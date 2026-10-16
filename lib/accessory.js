'use strict';

const {
  command, isOn, power, brightness, colorTemperature, coverPosition, rfCover,
  tvKeys, tvButton, TV_LABELS, clamp,
} = require('./commands');
const { percentage, switchState, STATE_KEYS } = require('./protocol');
const VERSION = require('../package.json').version;

class AccessoryHandler {
  constructor(platform, accessory, device, familyId, kind, options = {}) {
    this.platform = platform;
    this.accessory = accessory;
    this.device = device;
    this.familyId = familyId;
    this.kind = kind;
    this.options = options;
    this.Service = platform.Service;
    this.C = platform.Characteristic;
    this.reads = [];
    this.timers = new Set();
    this.used = new Set();
    this.lastWriteAt = 0;
    this.name = options.name || accessory.displayName;
    const info = accessory.getService(this.Service.AccessoryInformation) || accessory.addService(this.Service.AccessoryInformation);
    info.setCharacteristic(this.C.Manufacturer, 'ORVIBO')
      .setCharacteristic(this.C.Model, (device.model || kind).slice(0, 64))
      .setCharacteristic(this.C.SerialNumber, device.id.slice(0, 64))
      .setCharacteristic(this.C.FirmwareRevision, VERSION);
    this.used.add(info);
    if (kind === 'cover') this.setupCover();
    if (kind === 'rfCover') this.setupRF();
    if (kind === 'light' || kind === 'tunableLight') this.setupLight();
    if (kind === 'tv') this.setupTV();
    this.setupSensors();
    for (const service of [...accessory.services]) if (!this.used.has(service)) accessory.removeService(service);
    this.saveContext();
    this.publish();
  }

  service(Type, name, subtype) {
    const service = this.accessory.getServiceById(Type, subtype) || this.accessory.addService(Type, name, subtype);
    this.used.add(service);
    service.setCharacteristic(this.C.Name, name);
    if (this.C.ConfiguredName && service.testCharacteristic(this.C.ConfiguredName)) service.setCharacteristic(this.C.ConfiguredName, name);
    return service;
  }

  error() {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  assertAvailable() {
    if (!this.platform.isAvailable(this, this.kind !== 'sensor')) throw this.error();
  }

  value(value) {
    if (value === null || value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw this.error();
    return value;
  }

  read(service, characteristic, get) {
    const getter = () => { this.assertAvailable(); return this.value(get()); };
    service.getCharacteristic(characteristic).onGet(getter);
    this.reads.push({ service, characteristic, get: getter });
  }

  write(service, characteristic, set) {
    service.getCharacteristic(characteristic).onSet(async (value) => {
      this.assertAvailable();
      try { await set(value); }
      catch { throw this.error(); }
    });
  }

  pulse(name, subtype, build) {
    const service = this.service(this.Service.Switch, name, subtype);
    this.read(service, this.C.On, () => false);
    this.write(service, this.C.On, async (on) => {
      if (!on) return;
      try {
        await this.platform.control(this, build);
        service.updateCharacteristic(this.C.On, true);
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          service.updateCharacteristic(this.C.On, false);
        }, 400);
        this.timers.add(timer);
      } catch (error) {
        service.updateCharacteristic(this.C.On, false);
        throw error;
      }
    });
    service.updateCharacteristic(this.C.On, false);
    return service;
  }

  position() {
    const position = percentage(this.device.value1);
    return position === null ? null : this.options.invertPosition ? 100 - position : position;
  }

  setupCover() {
    const service = this.service(this.Service.WindowCovering, this.name, 'cover');
    service.setPrimaryService();
    this.read(service, this.C.CurrentPosition, () => this.position());
    this.read(service, this.C.TargetPosition, () => this.position());
    this.read(service, this.C.PositionState, () => this.C.PositionState.STOPPED);
    this.write(service, this.C.TargetPosition, async (target) => {
      const payload = coverPosition(Number(target), Boolean(this.options.invertPosition));
      await this.platform.control(this, payload, { value1: payload.value1 });
    });
    this.write(service, this.C.HoldPosition, async (hold) => {
      if (hold) await this.platform.control(this, command('stop'));
    });
    this.pulse(`${this.name} Stop`, 'cover:stop', () => command('stop'));
  }

  setupRF() {
    for (const action of ['open', 'close', 'stop']) {
      this.pulse(`${this.name} ${action[0].toUpperCase()}${action.slice(1)}`, `rf:${action}`, () => rfCover(action));
    }
  }

  setupLight() {
    const Type = this.kind === 'light' && this.options.exposeAs === 'outlet' ? this.Service.Outlet
      : this.kind === 'light' && this.options.exposeAs === 'switch' ? this.Service.Switch : this.Service.Lightbulb;
    const service = this.service(Type, this.name, 'light');
    service.setPrimaryService();
    this.read(service, this.C.On, () => isOn(this.device));
    this.write(service, this.C.On, async (on) => {
      await this.platform.control(this, (device) => power(device, Boolean(on)), { value1: on ? 0 : 1, ...(this.device.type === '503' ? { properties: { onoff: on ? 'on' : 'off' } } : {}) });
    });
    if (Type === this.Service.Outlet) this.read(service, this.C.OutletInUse, () => isOn(this.device));
    if (this.kind !== 'tunableLight') return;
    this.read(service, this.C.Brightness, () => {
      const value = this.device.value2;
      return value !== null && value >= 0 && value <= 255 ? clamp(value * 100 / 255, 0, 100) : null;
    });
    this.write(service, this.C.Brightness, async (value) => {
      const percent = clamp(Number(value), 0, 100);
      await this.platform.control(this, (device) => brightness(device, percent), (_device, payload) => ({
        value1: percent ? 0 : 1, value2: percent ? payload.value2 : 0,
        ...(this.device.type === '503' ? { properties: { onoff: percent ? 'on' : 'off' } } : {}),
      }));
    });
    const temperature = service.getCharacteristic(this.C.ColorTemperature);
    // HAP's initial value can be below our narrower device range.
    temperature.updateValue(clamp(this.device.value3 > 0 ? this.device.value3 : 250, 154, 370));
    temperature.setProps({ minValue: 154, maxValue: 370, minStep: 1 });
    this.read(service, this.C.ColorTemperature, () => this.device.value3 > 0 ? clamp(this.device.value3, 154, 370) : null);
    this.write(service, this.C.ColorTemperature, async (value) => {
      const mired = clamp(Number(value), 154, 370);
      await this.platform.control(this, (device) => colorTemperature(device, mired), { value1: 0, value3: mired, ...(this.device.type === '503' ? { properties: { onoff: 'on' } } : {}) });
    });
  }

  setupTV() {
    const profile = this.options.tvProfile || 'stored';
    const keys = tvKeys(profile, this.options.tvButtons);
    for (const key of keys) this.pulse(`${this.name} ${TV_LABELS[key]}`, `tv:${key}`, () => tvButton(key, profile));
  }

  setupSensors() {
    if (Object.hasOwn(this.device.properties, 'door_status')) {
      const service = this.service(this.Service.ContactSensor, `${this.name} Door`, 'door');
      this.read(service, this.C.ContactSensorState, () => {
        const open = switchState(this.device.properties.door_status);
        return open === null ? null : open ? this.C.ContactSensorState.CONTACT_NOT_DETECTED : this.C.ContactSensorState.CONTACT_DETECTED;
      });
    }
    if (Object.hasOwn(this.device.properties, 'battery_power')) {
      const service = this.service(this.Service.Battery || this.Service.BatteryService, `${this.name} Battery`, 'battery');
      this.read(service, this.C.BatteryLevel, () => percentage(this.device.properties.battery_power));
      this.read(service, this.C.StatusLowBattery, () => {
        const level = percentage(this.device.properties.battery_power);
        return level === null ? null : level <= 20 ? this.C.StatusLowBattery.BATTERY_LEVEL_LOW : this.C.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      });
      this.read(service, this.C.ChargingState, () => this.C.ChargingState.NOT_CHARGEABLE);
    }
  }

  saveContext() {
    // `device` contains normalized, allowlisted metadata/state only.
    this.accessory.context.device = { ...this.device, properties: { ...this.device.properties } };
    this.accessory.context.kind = this.kind;
    this.accessory.context.familyId = this.familyId;
    this.accessory.context.owner = this.platform.owner;
  }

  update(device, snapshotStartedAt) {
    if (this.lastWriteAt > snapshotStartedAt) {
      const values = Object.fromEntries(STATE_KEYS.map((key) => [key, this.device[key]]));
      this.device = { ...device, ...values, properties: { ...device.properties, ...this.device.properties } };
    } else this.device = device;
    this.saveContext();
  }

  applyState(state, optimistic = false) {
    const properties = { ...this.device.properties, ...state.properties };
    this.device = { ...this.device, ...state, properties };
    this.lastWriteAt = performance.now();
    // RF and TV acknowledgements have no state to persist or estimate.
    if (optimistic && !Object.keys(state).length) return;
    this.saveContext();
    this.publish();
  }

  publish() {
    for (const { service, characteristic, get } of this.reads) {
      try { service.updateCharacteristic(characteristic, get()); }
      catch { service.updateCharacteristic(characteristic, this.error()); }
    }
  }

  dispose() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

module.exports = { AccessoryHandler };
