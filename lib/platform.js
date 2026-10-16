'use strict';

const { createHash } = require('node:crypto');
const { CloudClient, OrviboError, normalizeConfig } = require('./cloud');
const { BinarySession } = require('./binary');
const { AccessoryHandler } = require('./accessory');
const { classify, tvKeys } = require('./commands');
const { integer, object, safeProperties, switchState, STATE_KEYS } = require('./protocol');

const PLUGIN_NAME = 'homebridge-orvibo-cloud';
const PLATFORM_NAME = 'OrviboCloud';
const safeError = (error) => error instanceof OrviboError ? error.message : 'An unexpected ORVIBO operation failed';
const deviceKey = (familyId, deviceId) => `${familyId}:${deviceId}`;

class OrviboPlatform {
  constructor(log, config, api, dependencies = {}) {
    this.log = log;
    this.config = normalizeConfig(config || {}, (row) => {
      this.log.warn(`Ignoring Device options row ${row} without a deviceId; automatic device discovery will continue.`);
    });
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.owner = createHash('sha256').update(`${this.config.username?.trim() || ''}:${this.config.familyId || '*'}`).digest('hex');
    this.accessories = new Map();
    this.handlers = new Map();
    this.families = new Map();
    this.listeners = new Map();
    this.sessions = new Set();
    this.queues = new Map();
    this.pushState = new Map();
    this.online = false;
    this.stopped = false;
    this.refreshing = null;
    this.timer = null;
    this.pollSeconds = Math.max(30, Math.min(3600, Number(this.config.pollInterval) || 60));
    this.sessionFactory = dependencies.sessionFactory || ((family) => new BinarySession(family));
    try { this.client = dependencies.client || new CloudClient(this.config); }
    catch (error) { this.log.error(safeError(error)); }
    api.on('didFinishLaunching', () => { void this.start(); });
    api.on('shutdown', () => this.shutdown());
  }

  debug(message) {
    if (this.config.debug) this.log.info(message);
    else this.log.debug(message);
  }

  configureAccessory(accessory) {
    if (accessory.context.owner !== this.owner) return;
    this.accessories.set(accessory.UUID, accessory);
    const context = accessory.context;
    if (context.device && context.kind && context.familyId && this.selected(context.device, context.kind)) {
      const handler = new AccessoryHandler(this, accessory, context.device, context.familyId, context.kind, this.options(context.device.id));
      this.handlers.set(deviceKey(context.familyId, context.device.id), handler);
    }
  }

  options(id) {
    const override = (this.config.devices || []).find((row) => row.deviceId === id) || {};
    return { tvProfile: this.config.tvProfile || 'stored', tvButtons: this.config.tvButtons, ...override };
  }

  selected(device, kind) {
    const include = this.config.includeDeviceIds;
    const options = this.options(device.id);
    return (!include?.length || include.includes(device.id))
      && !(this.config.excludeDeviceIds || []).includes(device.id)
      && !options.exclude
      && (kind !== 'tv' || this.config.tvProfile !== 'none' && tvKeys(options.tvProfile, options.tvButtons).length > 0);
  }

  removeExcludedAccessories() {
    // Explicit settings do not depend on cloud availability. Remove excluded
    // cached accessories even when discovery fails or the device is absent.
    for (const [uuid, accessory] of this.accessories) {
      const id = accessory.context.device?.id;
      if (!id || this.selected({ id }, accessory.context.kind)) continue;
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      const key = deviceKey(accessory.context.familyId, id);
      this.handlers.get(key)?.dispose();
      this.handlers.delete(key);
      this.pushState.delete(key);
      this.log.info(`Removed excluded accessory ${accessory.displayName}.`);
    }
  }

  async start() {
    if (this.stopped) return;
    this.removeExcludedAccessories();
    if (!this.client) return;
    await this.refresh();
    if (this.stopped) return;
    this.timer = setInterval(() => { void this.refresh(); }, this.pollSeconds * 1000);
    this.timer.unref?.();
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refreshOnce() {
    this.removeExcludedAccessories();
    const started = performance.now();
    try {
      const snapshot = await this.client.snapshot();
      if (this.stopped) return;
      // Commit only complete snapshots. A failed home must not remove its accessories.
      this.families = new Map(snapshot.families.map((family) => [family.id, family]));
      this.online = true;
      let supported = 0;
      let count = 0;
      for (const family of snapshot.families) {
        for (const device of family.devices) {
          count++;
          const kind = classify(device, family.devices);
          if (!kind || !this.selected(device, kind)) {
            this.debug(`Skipping ${device.name || 'unnamed device'} (type ${device.type || '?'}, ${kind ? 'excluded' : 'no supported profile'}).`);
            continue;
          }
          supported++;
          const key = deviceKey(family.id, device.id);
          const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${snapshot.userId}:${family.id}:${device.id}`);
          const pushed = this.pushState.get(key);
          if (pushed && Date.now() - pushed.time < this.pollSeconds * 2000) {
            Object.assign(device, pushed.values);
            if (pushed.properties) device.properties = { ...device.properties, ...pushed.properties };
          } else this.pushState.delete(key);
          const existing = this.handlers.get(key);
          if (existing && existing.kind === kind) {
            existing.update(device, started);
          } else {
            existing?.dispose();
            const accessory = this.accessories.get(uuid) || new this.api.platformAccessory(this.options(device.id).name || device.name || `ORVIBO ${device.id.slice(-6)}`, uuid);
            Object.assign(accessory.context, { owner: this.owner, familyId: family.id, kind });
            const handler = new AccessoryHandler(this, accessory, device, family.id, kind, this.options(device.id));
            this.handlers.set(key, handler);
            if (!this.accessories.has(uuid)) {
              this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
              this.accessories.set(uuid, accessory);
              this.log.info(`Added ${accessory.displayName} (${kind}).`);
            }
          }
        }
        if (!family.credentials) this.log.warn(`No control credentials were returned for ${family.name}. Sensors remain available; controls will retry after discovery refreshes.`);
      }
      this.syncListeners();
      for (const handler of this.handlers.values()) handler.publish();
      this.api.updatePlatformAccessories([...this.accessories.values()]);
      const summary = `${count} devices discovered in ${snapshot.families.length} home(s); ${supported} supported and selected.`;
      if (!this.didDiscover) this.log.info(summary);
      else this.debug(summary);
      this.didDiscover = true;
    } catch (error) {
      if (this.stopped) return;
      this.online = false;
      for (const handler of this.handlers.values()) handler.publish();
      this.log.error(`${safeError(error)}. Retrying in ${this.pollSeconds} seconds; cached accessories are retained.`);
    }
  }

  isAvailable(handler, control = true) {
    const family = this.families.get(handler.familyId);
    if (!this.online || this.stopped || !family) return false;
    const device = family.devices.find((row) => row.id === handler.device.id);
    if (!device || device.online === false || classify(device, family.devices) !== handler.kind || !this.selected(device, handler.kind)) return false;
    const hub = family.devices.find((row) => row.id !== device.id && row.cloudUid && row.cloudUid === device.cloudUid && ['30', '67'].includes(row.type));
    if (hub?.online === false) return false;
    return !control || Boolean(family.credentials && device.cloudUid);
  }

  control(handler, build, optimistic = {}) {
    const family = this.families.get(handler.familyId);
    const queueKey = `${handler.familyId}:${handler.device.cloudUid || handler.device.id}`;
    const previous = this.queues.get(queueKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (!this.isAvailable(handler)) throw new OrviboError('The ORVIBO device is unavailable', 'NETWORK');
      const currentFamily = this.families.get(handler.familyId) || family;
      const command = typeof build === 'function' ? build(handler.device) : build;
      const session = this.sessionFactory(currentFamily);
      this.sessions.add(session);
      try {
        // A command, especially a toggle, is never automatically retried.
        const reported = await session.control(handler.device, command);
        if (this.stopped) return;
        const values = typeof optimistic === 'function' ? optimistic(handler.device, command) : optimistic;
        const state = { ...values, ...reported };
        if (values.properties || reported.properties) state.properties = { ...values.properties, ...reported.properties };
        handler.applyState(state, true);
      } catch (error) {
        this.log.warn(`Command for ${handler.accessory.displayName} failed: ${safeError(error)}`);
        throw error;
      } finally {
        this.sessions.delete(session);
        session.close();
      }
    });
    // Keep the observed task separate from the non-rejecting queue tail.
    const tail = task.catch(() => {});
    this.queues.set(queueKey, tail);
    void tail.finally(() => { if (this.queues.get(queueKey) === tail) this.queues.delete(queueKey); });
    return task;
  }

  syncListeners() {
    for (const [id, listener] of this.listeners) {
      const current = this.families.get(id);
      const signature = current?.credentials ? `${current.host}:${current.credentials.username}:${current.credentials.password}` : '';
      if (this.config.pushUpdates === false || !signature || listener.signature !== signature) {
        listener.stopped = true;
        clearTimeout(listener.timer);
        listener.session?.close();
        this.listeners.delete(id);
      }
    }
    if (this.config.pushUpdates === false) return;
    for (const [id, family] of this.families) {
      if (!family.credentials || this.listeners.has(id)) continue;
      const listener = { signature: `${family.host}:${family.credentials.username}:${family.credentials.password}`, stopped: false, delay: 5000, session: null, timer: null };
      this.listeners.set(id, listener);
      void this.openListener(id, listener);
    }
  }

  async openListener(id, listener) {
    if (this.stopped || listener.stopped) return;
    let session;
    try {
      session = this.sessionFactory(this.families.get(id));
      listener.session = session;
      session.on('packet', (packet) => this.handlePush(id, packet));
      session.once('disconnect', () => {
        if (this.stopped || listener.stopped) return;
        listener.timer = setTimeout(() => { void this.openListener(id, listener); }, listener.delay);
        listener.timer.unref?.();
        listener.delay = Math.min(60000, listener.delay * 2);
      });
      await session.open();
      if (this.stopped || listener.stopped) { session.close(); return; }
      listener.delay = 5000;
      this.debug('ORVIBO push updates connected.');
    } catch (error) {
      this.debug(`Push updates disconnected: ${safeError(error)}; automatic reconnect is enabled.`);
      session?.close();
    }
  }

  handlePush(familyId, packet) {
    if (!object(packet) || integer(packet.cmd) !== 42) return;
    const family = this.families.get(familyId);
    if (!family) return;
    // An Allone hub UID is shared by siblings. Never apply its unaddressed
    // broadcast to every child, or accept another child's control state.
    let matches;
    if (packet.deviceId) matches = family.devices.filter((device) => device.id === String(packet.deviceId) && (!packet.uid || !device.cloudUid || device.cloudUid === String(packet.uid)));
    else {
      matches = family.devices.filter((device) => device.id === String(packet.uid));
      if (!matches.length) matches = family.devices.filter((device) => device.cloudUid && device.cloudUid === String(packet.uid));
    }
    if (matches.length !== 1) return;
    const device = matches[0];
    const values = {};
    for (const key of STATE_KEYS) {
      const value = integer(packet[key]);
      if (value !== null) values[key] = value;
    }
    const online = switchState(packet.online);
    if (online !== null) values.online = online;
    const properties = safeProperties(packet.properties);
    Object.assign(device, values);
    device.properties = { ...device.properties, ...properties };
    const key = deviceKey(familyId, device.id);
    const previous = this.pushState.get(key);
    this.pushState.set(key, { time: Date.now(), values: { ...previous?.values, ...values }, properties: { ...previous?.properties, ...properties } });
    this.handlers.get(key)?.applyState({ ...values, properties });
    // Hub connectivity also affects its child controls.
    if (online !== null) for (const handler of this.handlers.values()) handler.publish();
  }

  shutdown() {
    this.stopped = true;
    this.online = false;
    clearInterval(this.timer);
    for (const listener of this.listeners.values()) {
      listener.stopped = true;
      clearTimeout(listener.timer);
      listener.session?.close();
    }
    this.listeners.clear();
    for (const session of this.sessions) session.close();
    this.sessions.clear();
    for (const handler of this.handlers.values()) handler.dispose();
  }
}

module.exports = { OrviboPlatform, PLUGIN_NAME, PLATFORM_NAME, safeError, deviceKey };
