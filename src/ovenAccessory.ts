import { PlatformAccessory } from "homebridge";
import { HCAppliance, HCProgram, HCProgramOption, SETPOINT_TEMP_KEY } from "./homeConnect";
import { platform } from "./platform";
import { debounce } from "./debounce";

const OP_STATE_KEY = "BSH.Common.Status.OperationState";
const CAVITY_TEMP_KEY = "Cooking.Oven.Status.CurrentCavityTemperature";

const ACTIVE_OP_STATES = new Set([
  "BSH.Common.EnumType.OperationState.Run",
  "BSH.Common.EnumType.OperationState.Pause",
  "BSH.Common.EnumType.OperationState.ActionRequired",
]);

const DEFAULT_TEMP = 20;
const SETPOINT_COMMAND_DELAY_MS = 800;
const COMMAND_COOLDOWN_MS = 5000;
const DEFAULT_DURATION_SECONDS = 3600;

function programKeyToDisplayName(key: string): string {
  const last = key.split(".").pop() ?? key;
  return last.replace(/([A-Z])/g, " $1").trim();
}

export interface OvenControl {
  readonly isActive: boolean;
  stop(): Promise<void>;
}

export function beginOvenAccessory(
  accessory: PlatformAccessory,
  modeAccessory: PlatformAccessory,
  appliance: HCAppliance,
): OvenControl {
  const { homeConnect, api, log, config } = platform;
  const { Characteristic, Service } = api.hap;

  let programs: HCProgram[] = [];
  let isActive = false;
  let isPreheating = false;
  let currentCavityTemp = DEFAULT_TEMP;
  let setpointTemp = DEFAULT_TEMP;
  let currentProgramKey = "";
  let lastProgramKey = "";
  let stagedSetpoint: number | undefined;
  let isRestarting = false;
  let commandPendingUntil = 0;
  let setupComplete = false;
  let applianceTempUnit = "°C";
  const programConstraintsMap = new Map<string, { min: number; max: number }>();

  const toHomeKit = (v: number) => applianceTempUnit === "°F" ? (v - 32) * 5 / 9 : v;
  const fromHomeKit = (v: number) => applianceTempUnit === "°F" ? Math.round(v * 9 / 5 + 32) : v;

  type InputEntry = { service: InstanceType<typeof Service.InputSource>; programKey: string; identifier: number };
  const inputEntries: InputEntry[] = [];

  // --- TV service (mode selector — separate tile) ---
  const tvService = modeAccessory.getService(Service.Television)
    ?? modeAccessory.addService(Service.Television, appliance.name, `oven-mode-${appliance.haId}`);
  tvService.setCharacteristic(Characteristic.ConfiguredName, appliance.name);
  tvService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
  tvService.getCharacteristic(Characteristic.Active)
    .onGet(() => isActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
  tvService.getCharacteristic(Characteristic.ActiveIdentifier)
    .onGet(() => inputEntries.find(e => e.programKey === currentProgramKey)?.identifier ?? (inputEntries[0]?.identifier ?? 1));

  // --- Thermostat service ---
  const thermoService = accessory.getServiceById(Service.Thermostat, "oven-temp")
    ?? accessory.addService(Service.Thermostat, "Temperature", "oven-temp");
  thermoService.getCharacteristic(Characteristic.CurrentTemperature).onGet(() => currentCavityTemp);

  const REMAINING_TIME_KEY = "BSH.Common.Option.RemainingProgramTime";

  const scheduleSetpointCommand = debounce(async () => {
    const key = currentProgramKey || lastProgramKey;
    if (!key || stagedSetpoint === undefined) return;
    isRestarting = true;
    try {
      const activeProgram = await homeConnect.getActiveProgram(appliance.haId);
      const rawRemaining = activeProgram?.options.find(o => o.key === REMAINING_TIME_KEY)?.value;
      const remainingSeconds = typeof rawRemaining === "number" && rawRemaining > 0 ? rawRemaining : DEFAULT_DURATION_SECONDS;
      log.info(`[${appliance.name}] setpoint change: program=${key} setpoint=${stagedSetpoint}°C remaining=${remainingSeconds}s`);
      await homeConnect.stopProgram(appliance.haId);
      await homeConnect.startProgram(appliance.haId, key, fromHomeKit(stagedSetpoint), applianceTempUnit, remainingSeconds);
    } catch (err) {
      log.error(`[${appliance.name}] setpoint command failed: ${(err as Error).message}`);
    } finally {
      isRestarting = false;
    }
  }, SETPOINT_COMMAND_DELAY_MS);

  thermoService.getCharacteristic(Characteristic.TargetTemperature)
    .onGet(() => setpointTemp)
    .onSet((value) => {
      if (!setupComplete) return;
      const programKey = currentProgramKey || lastProgramKey;
      const constraints = programConstraintsMap.get(programKey);
      const raw = value as number;
      const clamped = constraints ? Math.max(constraints.min, Math.min(constraints.max, raw)) : raw;
      stagedSetpoint = clamped;
      if (clamped !== raw) thermoService.updateCharacteristic(Characteristic.TargetTemperature, clamped);
      scheduleSetpointCommand();
    });

  thermoService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .setProps({ validValues: [Characteristic.CurrentHeatingCoolingState.OFF, Characteristic.CurrentHeatingCoolingState.HEAT] })
    .onGet(() => isActive ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF);

  thermoService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .setProps({ validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT] })
    .onGet(() => isActive ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF);

  // --- Contact sensor ---
  const preheatSensor = accessory.getServiceById(Service.ContactSensor, "preheat-done")
    ?? accessory.addService(Service.ContactSensor, "Preheat Done", "preheat-done");
  preheatSensor.getCharacteristic(Characteristic.ContactSensorState)
    .onGet(() => isPreheating
      ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : Characteristic.ContactSensorState.CONTACT_DETECTED);

  // --- Optimistic active state (defined after both services) ---
  const setActiveOptimistic = (active: boolean) => {
    isActive = active;
    commandPendingUntil = Date.now() + COMMAND_COOLDOWN_MS;
    tvService.updateCharacteristic(Characteristic.Active, active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
    thermoService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState,
      active ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF);
    thermoService.updateCharacteristic(Characteristic.TargetHeatingCoolingState,
      active ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF);
  };

  // --- onSet handlers ---
  tvService.getCharacteristic(Characteristic.Active).onSet(async (value) => {
    if (!setupComplete) return;
    setActiveOptimistic(value !== 0);
    try {
      if (value === 0) {
        await homeConnect.stopProgram(appliance.haId);
      } else {
        const key = currentProgramKey || lastProgramKey || programs[0]?.key;
        log.info(`[${appliance.name}] Active → ${value ? "ON" : "OFF"} key=${key ?? "none"}`);
        if (key) await homeConnect.startProgram(appliance.haId, key, undefined, applianceTempUnit, DEFAULT_DURATION_SECONDS);
      }
    } catch (err) {
      log.error(`[${appliance.name}] Active onSet failed: ${(err as Error).message}`);
    }
  });

  tvService.getCharacteristic(Characteristic.ActiveIdentifier).onSet(async (value) => {
    if (!setupComplete) return;
    const entry = inputEntries.find(e => e.identifier === value);
    log.info(`[${appliance.name}] ActiveIdentifier → ${value} entry=${entry?.programKey ?? "not found"}`);
    if (entry) {
      setActiveOptimistic(true);
      try {
        await homeConnect.startProgram(appliance.haId, entry.programKey, undefined, applianceTempUnit, DEFAULT_DURATION_SECONDS);
        lastProgramKey = entry.programKey;
      } catch (err) {
        log.error(`[${appliance.name}] ActiveIdentifier onSet failed: ${(err as Error).message}`);
      }
    }
  });

  thermoService.getCharacteristic(Characteristic.TargetHeatingCoolingState).onSet(async (value) => {
    if (!setupComplete) return;
    setActiveOptimistic(value !== Characteristic.TargetHeatingCoolingState.OFF);
    try {
      if (value === Characteristic.TargetHeatingCoolingState.OFF) {
        await homeConnect.stopProgram(appliance.haId);
      } else {
        const key = currentProgramKey || lastProgramKey || programs[0]?.key;
        log.info(`[${appliance.name}] TargetHeatingCoolingState → ${value} key=${key ?? "none"}`);
        if (key) await homeConnect.startProgram(appliance.haId, key, undefined, applianceTempUnit, DEFAULT_DURATION_SECONDS);
      }
    } catch (err) {
      log.error(`[${appliance.name}] TargetHeatingCoolingState onSet failed: ${(err as Error).message}`);
    }
  });

  // --- Input setup ---
  function setupInputs() {
    for (const [index, program] of programs.entries()) {
      const identifier = index + 1;
      const name = programKeyToDisplayName(program.key);
      const inputService = modeAccessory.getServiceById(Service.InputSource, `input-${program.key}`)
        ?? modeAccessory.addService(Service.InputSource, name, `input-${program.key}`);
      inputService.setCharacteristic(Characteristic.Identifier, identifier);
      inputService.setCharacteristic(Characteristic.ConfiguredName, name);
      inputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
      inputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.OTHER);
      inputService.setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
      tvService.addLinkedService(inputService);
      inputEntries.push({ service: inputService as InstanceType<typeof Service.InputSource>, programKey: program.key, identifier });
    }
    log.info(`[${appliance.name}] inputs: ${programs.map(p => programKeyToDisplayName(p.key)).join(", ") || "none"}`);
  }

  const INTERVAL = ((config.pollIntervalSeconds as number | undefined) ?? 60) * 1000;

  async function poll() {
    if (!isRestarting) try {
      const statusEntries = await homeConnect.getStatus(appliance.haId);
      const opState = statusEntries.find(s => s.key === OP_STATE_KEY)?.value as string | undefined;
      const apiIsActive = opState !== undefined && ACTIVE_OP_STATES.has(opState);

      const activeProgram = apiIsActive ? await homeConnect.getActiveProgram(appliance.haId) : null;

      const rawCavityTemp = statusEntries.find(s => s.key === CAVITY_TEMP_KEY)?.value;
      if (typeof rawCavityTemp === "number") currentCavityTemp = toHomeKit(rawCavityTemp);

      const rawSetpoint = activeProgram?.options.find(o => o.key === SETPOINT_TEMP_KEY)?.value;
      if (typeof rawSetpoint === "number") setpointTemp = toHomeKit(rawSetpoint);

      if (activeProgram) {
        currentProgramKey = activeProgram.key;
        lastProgramKey = activeProgram.key;
      } else {
        currentProgramKey = "";
      }

      if (Date.now() >= commandPendingUntil) {
        isActive = apiIsActive;
        tvService.updateCharacteristic(Characteristic.Active, isActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
        thermoService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState,
          isActive ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF);
        thermoService.updateCharacteristic(Characteristic.TargetHeatingCoolingState,
          isActive ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF);
      }

      isPreheating = isActive && currentCavityTemp < setpointTemp;

      const activeIdentifier =
        inputEntries.find(e => e.programKey === currentProgramKey)?.identifier ?? (inputEntries[0]?.identifier ?? 1);
      tvService.updateCharacteristic(Characteristic.ActiveIdentifier, activeIdentifier);
      thermoService.updateCharacteristic(Characteristic.CurrentTemperature, currentCavityTemp);
      if (typeof rawSetpoint === "number") {
        thermoService.updateCharacteristic(Characteristic.TargetTemperature, setpointTemp);
      }
      preheatSensor.updateCharacteristic(Characteristic.ContactSensorState,
        isPreheating
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED);
    } catch (err) {
      log.error(`[${appliance.name}] poll error: ${(err as Error).message}`);
    }
    setTimeout(poll, INTERVAL);
  }

  async function start() {
    try {
      programs = await homeConnect.getAvailablePrograms(appliance.haId);
      log.info(`[${appliance.name}] available programs (${programs.length}): ${programs.map(p => p.key).join(", ") || "none"}`);
    } catch (err) {
      log.error(`[${appliance.name}] failed to load programs: ${(err as Error).message}`);
    }

    const allOptions: HCProgramOption[][] = await Promise.all(
      programs.map(p => homeConnect.getProgramDetail(appliance.haId, p.key).catch((err) => {
        log.warn(`[${appliance.name}] failed to load options for ${p.key}: ${(err as Error).message}`);
        return [];
      })),
    );

    for (const options of allOptions) {
      const opt = options.find(o => o.key === SETPOINT_TEMP_KEY);
      if (opt?.unit) { applianceTempUnit = opt.unit; break; }
    }
    log.info(`[${appliance.name}] temperature unit: ${applianceTempUnit}`);

    let tempMin = Infinity;
    let tempMax = -Infinity;
    let tempStep = 1;
    for (const [i, options] of allOptions.entries()) {
      const opt = options.find(o => o.key === SETPOINT_TEMP_KEY);
      const c = opt?.constraints;
      log.info(`[${appliance.name}] ${programs[i].key} constraints: ${JSON.stringify(c ?? "none")}`);
      if (c?.min !== undefined) tempMin = Math.min(tempMin, toHomeKit(c.min));
      if (c?.max !== undefined) tempMax = Math.max(tempMax, toHomeKit(c.max));
      if (c?.stepsize !== undefined) tempStep = Math.min(tempStep, applianceTempUnit === "°F" ? c.stepsize * 5 / 9 : c.stepsize);
      if (c?.min !== undefined && c?.max !== undefined) {
        programConstraintsMap.set(programs[i].key, { min: toHomeKit(c.min), max: toHomeKit(c.max) });
      }
    }
    if (!isFinite(tempMin) || !isFinite(tempMax)) {
      tempMin = 30;
      tempMax = 300;
      tempStep = 5;
      log.warn(`[${appliance.name}] no temperature constraints returned by API, using defaults (${tempMin}–${tempMax}°C)`);
    }
    thermoService.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: 0, maxValue: tempMax, minStep: 1 });
    thermoService.getCharacteristic(Characteristic.TargetTemperature).setProps({ minValue: tempMin, maxValue: tempMax, minStep: tempStep });
    if (setpointTemp < tempMin) setpointTemp = tempMin;

    setupInputs();
    setupComplete = true;
    poll();
  }

  start();

  return {
    get isActive() { return isActive; },
    stop: async () => {
      setActiveOptimistic(false);
      await homeConnect.stopProgram(appliance.haId);
    },
  };
}
