import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { HomeConnect, HCAppliance } from "./homeConnect";
import { beginOvenAccessory, OvenControl } from "./ovenAccessory";

export let platform: HomeConnectPlatform;

export class HomeConnectPlatform implements DynamicPlatformPlugin {
  public homeConnect!: HomeConnect;
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    platform = this;
    this.api.on("didFinishLaunching", () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    const { clientId } = this.config;
    if (!clientId) {
      this.log.error("Missing clientId in config — register at developer.home-connect.com");
      return;
    }

    this.homeConnect = new HomeConnect(clientId as string, this.api.user.storagePath());

    try {
      await this.homeConnect.initialize(this.log);
    } catch (err) {
      this.log.error("Failed to authenticate with Home Connect: " + (err as Error).message);
      return;
    }

    let appliances: HCAppliance[];
    try {
      appliances = await this.homeConnect.getAppliances();
    } catch (err) {
      this.log.error("Failed to fetch appliances: " + (err as Error).message);
      return;
    }

    this.log.info(`All appliances: ${appliances.map(a => `${a.name} (type=${a.type})`).join(", ") || "none"}`);
    const ovens = appliances.filter(a => a.type === "Oven");
    this.log.info(`Found ${ovens.length} oven(s)`);

    const ovenControls: OvenControl[] = [];
    for (const oven of ovens) {
      this.log.info(`Setting up oven: ${oven.name} (${oven.haId}) connected=${oven.connected}`);
      ovenControls.push(beginOvenAccessory(
        this.getAccessory(oven.name, oven.haId),
        this.getAccessory(`${oven.name} Mode`, `${oven.haId}-mode`),
        oven,
      ));
    }

    if (ovenControls.length > 0) {
      const { Characteristic, Service } = this.api.hap;
      const masterAccessory = this.getAccessory("Oven", "oven-master");
      const switchService = masterAccessory.getService(Service.Switch)
        ?? masterAccessory.addService(Service.Switch, "Oven");
      switchService.getCharacteristic(Characteristic.On)
        .onGet(() => ovenControls.some(o => o.isActive))
        .onSet(async (value) => {
          if (value) {
            switchService.updateCharacteristic(Characteristic.On, ovenControls.some(o => o.isActive));
            return;
          }
          await Promise.all(ovenControls.map(o => o.stop()));
        });
    }
  }

  private getAccessory(displayName: string, uniqueId: string): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(uniqueId);
    const existing = this.accessories.find(a => a.UUID === uuid);
    if (existing) return existing;
    const accessory = new this.api.platformAccessory(displayName, uuid);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    return accessory;
  }
}
