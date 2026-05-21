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

function programKeyToDisplayName(key: string): string {
  const last = key.split(".").pop() ?? key;
  return last.replace(/([A-Z])/g, " $1").trim();
}

export function beginOvenAccessory(accessory: PlatformAccessory, appliance: HCAppliance): void {
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

  type InputEntry = { service: InstanceType<typeof Service.InputSource>; programKey: string; identifier: number };
  const inputEntries: InputEntry[] = [];

  // --- TV service (cook mode selection) ---
  const tvService = accessory.getService(Service.Television)
    ?? accessory.addService(Service.Television, appliance.name, `oven-${appliance.haId}`);
  tvService.setCharacteristic(Characteristic.ConfiguredName, appliance.name);
  tvService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

  tvService
    .getCharacteristic(Characteristic.Active)
    .onGet(() => isActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)
    .onSet(async (value) => {
      if (value === 0) {
        await homeConnect.stopProgram(appliance.haId);
      } else {
        const key = currentProgramKey || lastProgramKey || programs[0]?.key;
        if (key) await homeConnect.startProgram(appliance.haId, key);
      }
    });

  tvService
    .getCharacteristic(Characteristic.ActiveIdentifier)
    .onGet(() => inputEntries.find(e => e.programKey === currentProgramKey)?.identifier ?? (inputEntries[0]?.identifier ?? 1))
    .onSet(async (value) => {
      const entry = inputEntries.find(e => e.identifier === value);
      if (entry) {
        await homeConnect.startProgram(appliance.haId, entry.programKey);
        lastProgramKey = entry.programKey;
      }
    });

  // --- Thermostat service (temperature readout) ---
  const thermoService = accessory.getServiceById(Service.Thermostat, "oven-temp")
    ?? accessory.addService(Service.Thermostat, "Temperature", "oven-temp");

  thermoService.setCharacteristic(Characteristic.TemperatureDisplayUnits, Characteristic.TemperatureDisplayUnits.CELSIUS);

  thermoService
    .getCharacteristic(Characteristic.CurrentTemperature)
    .onGet(() => currentCavityTemp);

  const scheduleSetpointCommand = debounce(async () => {
    const key = currentProgramKey || lastProgramKey;
    if (!key || stagedSetpoint === undefined) return;
    isRestarting = true;
    try {
      await homeConnect.stopProgram(appliance.haId);
      await homeConnect.startProgram(appliance.haId, key, stagedSetpoint);
    } finally {
      isRestarting = false;
    }
  }, SETPOINT_COMMAND_DELAY_MS);

  thermoService
    .getCharacteristic(Characteristic.TargetTemperature)
    .onGet(() => setpointTemp)
    .onSet(async (value) => {
      stagedSetpoint = value as number;
      scheduleSetpointCommand();
    });

  thermoService
    .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .setProps({ validValues: [Characteristic.CurrentHeatingCoolingState.OFF, Characteristic.CurrentHeatingCoolingState.HEAT] })
    .onGet(() => isActive ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF);

  thermoService
    .getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .setProps({ validValues: [Characteristic.CurrentHeatingCoolingState.OFF, Characteristic.CurrentHeatingCoolingState.HEAT] })
    .onGet(() => isActive ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF)
    .onSet(async (value) => {
      if (value === Characteristic.TargetHeatingCoolingState.OFF) {
        await homeConnect.stopProgram(appliance.haId);
      } else {
        const key = currentProgramKey || lastProgramKey || programs[0]?.key;
        if (key) await homeConnect.startProgram(appliance.haId, key);
      }
    });

  // --- Contact sensor (open = preheating, closed = done → triggers HomeKit notification) ---
  const preheatSensor = accessory.getServiceById(Service.ContactSensor, "preheat-done")
    ?? accessory.addService(Service.ContactSensor, "Preheat Done", "preheat-done");
  preheatSensor
    .getCharacteristic(Characteristic.ContactSensorState)
    .onGet(() =>
      isPreheating
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED,
    );

  function setupInputs() {
    for (const [index, program] of programs.entries()) {
      const identifier = index + 1;
      const name = programKeyToDisplayName(program.key);
      const inputService = accessory.getServiceById(Service.InputSource, `input-${program.key}`)
        ?? accessory.addService(Service.InputSource, name, `input-${program.key}`);
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

  const INTERVAL = ((config.pollIntervalSeconds as number | undefined) ?? 30) * 1000;

  async function poll() {
    if (!isRestarting) try {
      const [statusEntries, activeProgram] = await Promise.all([
        homeConnect.getStatus(appliance.haId),
        homeConnect.getActiveProgram(appliance.haId),
      ]);

      const opState = statusEntries.find(s => s.key === OP_STATE_KEY)?.value as string | undefined;
      isActive = opState !== undefined && ACTIVE_OP_STATES.has(opState);

      const rawCavityTemp = statusEntries.find(s => s.key === CAVITY_TEMP_KEY)?.value;
      if (typeof rawCavityTemp === "number") currentCavityTemp = rawCavityTemp;

      const rawSetpoint = activeProgram?.options.find(o => o.key === SETPOINT_TEMP_KEY)?.value;
      if (typeof rawSetpoint === "number") setpointTemp = rawSetpoint;

      isPreheating = isActive && currentCavityTemp < setpointTemp;

      if (activeProgram) {
        currentProgramKey = activeProgram.key;
        lastProgramKey = activeProgram.key;
      } else {
        currentProgramKey = "";
      }

      const activeIdentifier =
        inputEntries.find(e => e.programKey === currentProgramKey)?.identifier ?? (inputEntries[0]?.identifier ?? 1);

      tvService.updateCharacteristic(Characteristic.Active, isActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
      tvService.updateCharacteristic(Characteristic.ActiveIdentifier, activeIdentifier);
      thermoService.updateCharacteristic(Characteristic.CurrentTemperature, currentCavityTemp);
      thermoService.updateCharacteristic(Characteristic.TargetTemperature, setpointTemp);
      thermoService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState,
        isActive ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF);
      thermoService.updateCharacteristic(Characteristic.TargetHeatingCoolingState,
        isActive ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF);
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
    } catch (err) {
      log.error(`[${appliance.name}] failed to load programs: ${(err as Error).message}`);
    }

    const allOptions: HCProgramOption[][] = await Promise.all(
      programs.map(p => homeConnect.getProgramDetail(appliance.haId, p.key).catch(() => [])),
    );

    let tempMin = 30;
    let tempMax = 300;
    let tempStep = 5;
    for (const options of allOptions) {
      const c = options.find(o => o.key === SETPOINT_TEMP_KEY)?.constraints;
      if (c?.min !== undefined) tempMin = Math.min(tempMin, c.min);
      if (c?.max !== undefined) tempMax = Math.max(tempMax, c.max);
      if (c?.stepsize !== undefined) tempStep = Math.min(tempStep, c.stepsize);
    }
    thermoService.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: 0, maxValue: tempMax, minStep: 1 });
    thermoService.getCharacteristic(Characteristic.TargetTemperature).setProps({ minValue: tempMin, maxValue: tempMax, minStep: tempStep });

    setupInputs();
    poll();
  }

  start();
}
