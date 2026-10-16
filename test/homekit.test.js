'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { OrviboPlatform, PLUGIN_NAME, PLATFORM_NAME } = require('../lib/platform');
const { OrviboError } = require('../lib/cloud');

let HomebridgeAPI;
try {
  const entry = process.env.ORVIBO_HOMEBRIDGE_ROOT
    ? path.join(process.env.ORVIBO_HOMEBRIDGE_ROOT, JSON.parse(fs.readFileSync(path.join(process.env.ORVIBO_HOMEBRIDGE_ROOT, 'package.json'))).main)
    : require.resolve('homebridge');
  HomebridgeAPI = require(path.join(path.dirname(entry), 'api.js')).HomebridgeAPI;
} catch { /* Core protocol tests still run without development dependencies. */ }
const nativeTest = (name, fn) => test(name, { skip: HomebridgeAPI ? false : 'Install development dependencies with npm install to run native HomeKit tests' }, fn);

function device(id, type, rest = {}) {
  return { id, type, name: `Test ${id}`, model: '', subType: '', cloudUid: `hardware-${id}`, room: 'Living', parentId: '', online: true, value1: 0, value2: null, value3: null, value4: null, properties: {}, ...rest };
}

function snapshot() {
  return {
    host: 'homemate.orvibo.com', userId: 'test-user', families: [{
      id: 'family-one', name: 'Home', host: 'homemate.orvibo.com', userId: 'test-user',
      credentials: { username: 'test-user', password: 'DO-NOT-CACHE-BINARY' },
      devices: [
        device('curtain', '34', { value1: 25 }),
        device('hub', '67', { cloudUid: 'shared-hub' }),
        device('rf', '34', { cloudUid: 'shared-hub' }),
        device('tv', '6', { cloudUid: 'shared-hub' }),
        device('relay', '1', { subType: '1' }),
        device('light', '38', { subType: '4', value2: 128, value3: 250 }),
        device('property', '503', { subType: '436', model: '294339fdc9b04613bb6cf1569305b78c', value1: 1, value2: 100, value3: 250, properties: { onoff: 'off' } }),
        device('door', '999', { properties: { door_status: 'closed', battery_power: 65 } }),
        device('unknown', '123456'),
      ],
    }],
  };
}

async function setup(t, config = {}, options = {}) {
  const api = new HomebridgeAPI();
  const commands = [];
  const logs = [];
  const events = { register: [], remove: [] };
  api.on('registerPlatformAccessories', (accessories) => events.register.push(...accessories));
  api.on('unregisterPlatformAccessories', (accessories) => events.remove.push(...accessories));
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((key) => [key, (message) => logs.push(String(message))]));
  const client = { snapshot: async () => snapshot() };
  const sessionFactory = () => ({
    control: async (target, command) => {
      commands.push({ device: { ...target }, command });
      return options.reply ? options.reply(target, command) : {};
    }, close() {},
  });
  const platform = new OrviboPlatform(log, {
    platform: PLATFORM_NAME, username: 'test@example.com', password: 'DO-NOT-CACHE-PASSWORD',
    host: 'homemate.orvibo.com', pushUpdates: false, ...config,
  }, api, { client, sessionFactory });
  t.after(() => platform.shutdown());
  if (options.refresh !== false) await platform.refresh();
  const handler = (id) => platform.handlers.get(`family-one:${id}`);
  const service = (id, Type, sub) => handler(id).accessory.getServiceById(Type, sub);
  return { api, platform, client, handler, service, commands, logs, events, C: api.hap.Characteristic, S: api.hap.Service };
}

nativeTest('plugin registers a dynamic platform through the actual Homebridge API', () => {
  const api = new HomebridgeAPI();
  let registered;
  api.on('registerPlatform', (...args) => { registered = args; });
  require('../index')(api);
  assert.ok(registered.includes(PLUGIN_NAME));
  assert.ok(registered.includes(PLATFORM_NAME));
  assert.ok(registered.includes(OrviboPlatform));
});

nativeTest('native HomeKit services are created for seven supported devices with RF blinds represented as window coverings', async (t) => {
  const h = await setup(t);
  assert.equal(h.platform.handlers.size, 7);
  assert.equal(h.events.register.length, 7);
  assert.ok(h.handler('rf').accessory.getService(h.S.WindowCovering));
  assert.equal(h.handler('rf').accessory.services.filter((s) => s.UUID === h.S.Switch.UUID).length, 0);
  assert.equal(h.service('rf', h.S.WindowCovering, 'cover').isPrimaryService, true);
  assert.equal(h.handler('tv').accessory.getService(h.S.Television), undefined);
  assert.equal(h.handler('tv').accessory.services.filter((s) => s.UUID === h.S.Switch.UUID).length, 13);
  assert.equal(await h.service('curtain', h.S.WindowCovering, 'cover').getCharacteristic(h.C.CurrentPosition).handleGetRequest(), 25);
  assert.equal(await h.service('light', h.S.Lightbulb, 'light').getCharacteristic(h.C.Brightness).handleGetRequest(), 50);
  assert.equal(await h.service('property', h.S.Lightbulb, 'light').getCharacteristic(h.C.On).handleGetRequest(), false);
  assert.equal(await h.service('door', h.S.ContactSensor, 'door').getCharacteristic(h.C.ContactSensorState).handleGetRequest(), h.C.ContactSensorState.CONTACT_DETECTED);
  assert.equal(await h.service('door', h.S.Battery || h.S.BatteryService, 'battery').getCharacteristic(h.C.BatteryLevel).handleGetRequest(), 65);
  assert.doesNotMatch(JSON.stringify([...h.platform.accessories.values()].map((a) => a.context)), /DO-NOT-CACHE|credentials|accessToken/);
});

nativeTest('HomeKit light setters keep active-low power, brightness units and temperature units correct', async (t) => {
  const h = await setup(t);
  const light = h.service('light', h.S.Lightbulb, 'light');
  await light.getCharacteristic(h.C.On).handleSetRequest(false);
  assert.equal(h.commands.at(-1).command.order, 'off');
  assert.equal(h.commands.at(-1).command.value1, 1);
  await light.getCharacteristic(h.C.Brightness).handleSetRequest(75);
  assert.equal(h.commands.at(-1).command.order, 'fast move to level');
  assert.equal(h.commands.at(-1).command.value2, 191);
  assert.equal(h.commands.at(-1).command.value3, 4000);
  await light.getCharacteristic(h.C.ColorTemperature).handleSetRequest(300);
  assert.equal(h.commands.at(-1).command.order, 'fast color temperature');
  assert.equal(h.commands.at(-1).command.value2, 191);
  assert.equal(h.commands.at(-1).command.value3, 300);
  await light.getCharacteristic(h.C.Brightness).handleSetRequest(0);
  assert.equal(h.commands.at(-1).command.order, 'off');
  assert.equal(await light.getCharacteristic(h.C.On).handleGetRequest(), false);
});

nativeTest('property lights use property power commands and actual properties take precedence', async (t) => {
  const h = await setup(t);
  const light = h.service('property', h.S.Lightbulb, 'light');
  await light.getCharacteristic(h.C.On).handleSetRequest(true);
  assert.deepEqual(h.commands[0].command.properties, { onoff: { status: 'on' } });
  assert.equal(await light.getCharacteristic(h.C.On).handleGetRequest(), true);
  await light.getCharacteristic(h.C.Brightness).handleSetRequest(50);
  assert.equal(h.commands.at(-1).command.value3, 0);
  assert.equal(h.commands.at(-1).command.value2, 128);
});

nativeTest('percentage curtains invert reads and writes consistently and support Stop', async (t) => {
  const h = await setup(t, { devices: [{ deviceId: 'curtain', invertPosition: true }] });
  const cover = h.service('curtain', h.S.WindowCovering, 'cover');
  assert.equal(await cover.getCharacteristic(h.C.CurrentPosition).handleGetRequest(), 75);
  await cover.getCharacteristic(h.C.TargetPosition).handleSetRequest(30);
  assert.equal(h.commands.at(-1).command.order, 'open');
  assert.equal(h.commands.at(-1).command.value1, 70);
  assert.equal(await cover.getCharacteristic(h.C.CurrentPosition).handleGetRequest(), 30);
  await cover.getCharacteristic(h.C.HoldPosition).handleSetRequest(true);
  assert.equal(h.commands.at(-1).command.order, 'stop');
});

nativeTest('one RF blind supports Open, Stop and Close through native covering characteristics and preserves cloud values', async (t) => {
  const h = await setup(t);
  const cover = h.service('rf', h.S.WindowCovering, 'cover');
  const target = cover.getCharacteristic(h.C.TargetPosition);
  const current = cover.getCharacteristic(h.C.CurrentPosition);
  const hold = cover.getCharacteristic(h.C.HoldPosition);
  assert.deepEqual(target.props.validValues, [0, 50, 100]);
  assert.equal(target.props.minStep, 50);
  assert.equal(await current.handleGetRequest(), 50, 'unknown initial state uses the Stop command selection');
  for (const [value, code] of [[100, 380000], [50, 380002], [0, 380001], [0, 380001], [100, 380000]]) {
    await target.handleSetRequest(value);
    assert.equal(h.commands.at(-1).command.order, 'rf control');
    assert.equal(h.commands.at(-1).command.value1, code);
    assert.equal(h.commands.at(-1).device.id, 'rf');
    assert.equal(h.commands.at(-1).device.cloudUid, 'shared-hub');
    assert.equal(await current.handleGetRequest(), value);
    assert.equal(await target.handleGetRequest(), value);
  }
  await hold.handleSetRequest(false);
  assert.equal(h.commands.length, 5);
  await hold.handleSetRequest(true);
  assert.equal(h.commands.at(-1).command.value1, 380002);
  assert.equal(h.commands.length, 6);
  assert.equal(await current.handleGetRequest(), 50);
  assert.equal(await target.handleGetRequest(), 50);
  assert.equal(h.handler('rf').device.value1, 0);
});

nativeTest('rejected RF covering commands are sent once and leave the last accepted command unchanged', async (t) => {
  const h = await setup(t, {}, { reply: async () => { throw new OrviboError('Simulated rejection', 'REJECTED'); } });
  const cover = h.service('rf', h.S.WindowCovering, 'cover');
  await assert.rejects(cover.getCharacteristic(h.C.TargetPosition).handleSetRequest(100));
  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0].command.value1, 380000);
  assert.equal(await cover.getCharacteristic(h.C.CurrentPosition).handleGetRequest(), 50);
  assert.equal(await cover.getCharacteristic(h.C.TargetPosition).handleGetRequest(), 50);
  assert.equal(h.handler('rf').accessory.context.rfAction, 'stop');
});

nativeTest('RF command selection survives cloud refresh and native cache restoration without treating cloud values as percentages', async (t) => {
  const h = await setup(t);
  const cover = h.service('rf', h.S.WindowCovering, 'cover');
  await cover.getCharacteristic(h.C.TargetPosition).handleSetRequest(100);
  await h.platform.refresh();
  assert.equal(await cover.getCharacteristic(h.C.CurrentPosition).handleGetRequest(), 100);
  assert.equal(h.handler('rf').device.value1, 0);
  const serialized = h.api.platformAccessory.serialize(h.handler('rf').accessory);
  assert.equal(serialized.context.rfAction, 'open');
  assert.doesNotMatch(JSON.stringify(serialized), /DO-NOT-CACHE|accessToken|credentials/);
  const restored = await setup(t, { includeDeviceIds: ['rf'] }, { refresh: false });
  restored.platform.configureAccessory(restored.api.platformAccessory.deserialize(serialized));
  await restored.platform.refresh();
  assert.equal(await restored.service('rf', restored.S.WindowCovering, 'cover').getCharacteristic(restored.C.TargetPosition).handleGetRequest(), 100);
  assert.equal(restored.commands.length, 0);
  assert.equal(restored.events.register.length, 0);
});

nativeTest('cached RF switch accessories migrate to one primary covering with the same UUID and no leftover switches', async (t) => {
  const h = await setup(t, { includeDeviceIds: ['rf'] });
  const accessory = h.handler('rf').accessory;
  accessory.removeService(accessory.getService(h.S.WindowCovering));
  for (const action of ['open', 'close', 'stop']) accessory.addService(h.S.Switch, `Test RF ${action}`, `rf:${action}`);
  delete accessory.context.rfAction;
  const serialized = h.api.platformAccessory.serialize(accessory);
  const restored = await setup(t, { includeDeviceIds: ['rf'] }, { refresh: false });
  restored.platform.configureAccessory(restored.api.platformAccessory.deserialize(serialized));
  await restored.platform.refresh();
  const migrated = restored.handler('rf').accessory;
  assert.equal(migrated.UUID, accessory.UUID);
  assert.equal(migrated.displayName, accessory.displayName);
  assert.equal(migrated.services.filter((service) => service.UUID === restored.S.WindowCovering.UUID).length, 1);
  assert.equal(migrated.services.filter((service) => service.UUID === restored.S.Switch.UUID).length, 0);
  assert.equal(migrated.getService(restored.S.WindowCovering).isPrimaryService, true);
  assert.equal(migrated.category, restored.api.hap.Categories.WINDOW_COVERING);
  assert.equal(restored.events.register.length, 0);
  assert.equal(restored.events.remove.length, 0);
});

nativeTest('LG profile exposes Back/Home/Exit and routes the TV child through its hub', async (t) => {
  const h = await setup(t, { devices: [{ deviceId: 'tv', tvProfile: 'lg', tvButtons: ['home', 'back', 'exit'] }] });
  assert.equal(h.handler('tv').accessory.services.filter((s) => s.UUID === h.S.Switch.UUID).length, 3);
  await h.service('tv', h.S.Switch, 'tv:home').getCharacteristic(h.C.On).handleSetRequest(true);
  assert.equal(h.commands[0].device.id, 'tv');
  assert.equal(h.commands[0].device.cloudUid, 'shared-hub');
  assert.equal(h.commands[0].command.order, 'ir control');
  assert.equal(h.commands[0].command.infrared.frequency, 38000);
});

nativeTest('live door and battery reports reach native HomeKit characteristics without touching sibling remotes', async (t) => {
  const h = await setup(t);
  h.platform.handlePush('family-one', { cmd: 42, uid: 'hardware-door', properties: { door_status: 'open', battery_power: 12, password: 'DO-NOT-CACHE' } });
  assert.equal(await h.service('door', h.S.ContactSensor, 'door').getCharacteristic(h.C.ContactSensorState).handleGetRequest(), h.C.ContactSensorState.CONTACT_NOT_DETECTED);
  const battery = h.service('door', h.S.Battery || h.S.BatteryService, 'battery');
  assert.equal(await battery.getCharacteristic(h.C.BatteryLevel).handleGetRequest(), 12);
  assert.equal(await battery.getCharacteristic(h.C.StatusLowBattery).handleGetRequest(), h.C.StatusLowBattery.BATTERY_LEVEL_LOW);
  h.platform.handlePush('family-one', { cmd: 42, uid: 'shared-hub', value1: 99 });
  assert.equal(h.handler('rf').device.value1, 0);
  h.platform.handlePush('family-one', { cmd: 42, deviceId: 'rf', uid: 'wrong-hub', value1: 99 });
  assert.equal(h.handler('rf').device.value1, 0);
  assert.doesNotMatch(JSON.stringify(h.handler('door').accessory.context), /DO-NOT-CACHE/);
});

nativeTest('offline failures preserve cached identities, and a later successful refresh restores the same accessories', async (t) => {
  const h = await setup(t);
  const before = [...h.platform.accessories.keys()];
  h.client.snapshot = async () => { throw new OrviboError('Simulated outage', 'NETWORK'); };
  await h.platform.refresh();
  assert.deepEqual([...h.platform.accessories.keys()], before);
  const characteristic = h.service('light', h.S.Lightbulb, 'light').getCharacteristic(h.C.On);
  await assert.rejects(characteristic.handleGetRequest());
  h.client.snapshot = async () => snapshot();
  await h.platform.refresh();
  assert.equal(await characteristic.handleGetRequest(), true);
  assert.equal(h.events.register.length, 7);
  assert.doesNotMatch(h.logs.join('\n'), /DO-NOT-CACHE/);
});

nativeTest('missing cloud rows remain unavailable and explicit filters remove only selected cached accessories', async (t) => {
  const h = await setup(t);
  h.client.snapshot = async () => {
    const result = snapshot();
    result.families[0].devices = result.families[0].devices.filter((d) => d.id !== 'curtain');
    return result;
  };
  await h.platform.refresh();
  assert.equal(h.platform.handlers.size, 7);
  await assert.rejects(h.service('curtain', h.S.WindowCovering, 'cover').getCharacteristic(h.C.CurrentPosition).handleGetRequest());
  h.platform.config.excludeDeviceIds = ['curtain'];
  await h.platform.refresh();
  assert.equal(h.platform.handlers.size, 6);
  assert.equal(h.events.remove.length, 1);
});

nativeTest('native accessory serialization and restoration preserve UUIDs and contain no account secrets', async (t) => {
  const h = await setup(t);
  const serialized = [...h.platform.accessories.values()].map((a) => h.api.platformAccessory.serialize(a));
  assert.doesNotMatch(JSON.stringify(serialized), /DO-NOT-CACHE|accessToken|credentials/);
  const restored = await setup(t, {}, { refresh: false });
  for (const data of serialized) restored.platform.configureAccessory(restored.api.platformAccessory.deserialize(data));
  assert.equal(restored.platform.handlers.size, 7);
  await restored.platform.refresh();
  assert.deepEqual([...restored.platform.accessories.keys()], [...h.platform.accessories.keys()]);
  assert.equal(restored.events.register.length, 0);
});

nativeTest('controls sharing an Allone hub are serialized, and rejected commands do not apply optimistic state', async (t) => {
  let active = 0;
  let maxActive = 0;
  const h = await setup(t, {}, { reply: async (_device, command) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active--;
    if (command.order === 'off') throw new OrviboError('Simulated rejection', 'REJECTED');
    return {};
  } });
  await Promise.all([
    h.service('rf', h.S.WindowCovering, 'cover').getCharacteristic(h.C.TargetPosition).handleSetRequest(100),
    h.service('tv', h.S.Switch, 'tv:power_toggle').getCharacteristic(h.C.On).handleSetRequest(true),
  ]);
  assert.equal(maxActive, 1);
  const relay = h.service('relay', h.S.Lightbulb, 'light').getCharacteristic(h.C.On);
  await assert.rejects(relay.handleSetRequest(false));
  assert.equal(h.handler('relay').device.value1, 0);
  assert.equal(await relay.handleGetRequest(), true);
});

nativeTest('sensors work without control credentials while actuator writes report unavailable', async (t) => {
  const h = await setup(t, {}, { refresh: false });
  h.client.snapshot = async () => {
    const result = snapshot();
    result.families[0].credentials = null;
    return result;
  };
  await h.platform.refresh();
  assert.equal(await h.service('door', h.S.Battery || h.S.BatteryService, 'battery').getCharacteristic(h.C.BatteryLevel).handleGetRequest(), 65);
  await assert.rejects(h.service('relay', h.S.Lightbulb, 'light').getCharacteristic(h.C.On).handleSetRequest(false));
});

nativeTest('an in-flight cloud snapshot cannot overwrite a command completed after it started', async (t) => {
  const h = await setup(t);
  let complete;
  h.client.snapshot = () => new Promise((resolve) => { complete = resolve; });
  const refresh = h.platform.refresh();
  await h.service('light', h.S.Lightbulb, 'light').getCharacteristic(h.C.Brightness).handleSetRequest(80);
  complete(snapshot());
  await refresh;
  assert.equal(await h.service('light', h.S.Lightbulb, 'light').getCharacteristic(h.C.Brightness).handleGetRequest(), 80);
});

nativeTest('an excluded hub remains available for RF classification and an offline hub blocks child writes', async (t) => {
  const h = await setup(t, { includeDeviceIds: ['rf'] });
  assert.equal(h.platform.handlers.size, 1);
  assert.equal(h.handler('rf').kind, 'rfCover');
  const control = h.service('rf', h.S.WindowCovering, 'cover').getCharacteristic(h.C.TargetPosition);
  await control.handleSetRequest(100);
  h.client.snapshot = async () => {
    const result = snapshot();
    result.families[0].devices.find((d) => d.id === 'hub').online = false;
    return result;
  };
  await h.platform.refresh();
  await assert.rejects(control.handleSetRequest(100));
  assert.equal(h.commands.length, 1);
});

nativeTest('an empty TV button selection hides the remote accessory and relay appearance can be changed to Outlet', async (t) => {
  const h = await setup(t, { tvButtons: [], devices: [{ deviceId: 'relay', exposeAs: 'outlet' }] });
  assert.equal(h.handler('tv'), undefined);
  const outlet = h.service('relay', h.S.Outlet, 'light');
  assert.ok(outlet);
  assert.equal(await outlet.getCharacteristic(h.C.OutletInUse).handleGetRequest(), true);
});

nativeTest('global TV profile None disables an explicit LG device override and leaves the RF blind exposed', async (t) => {
  const h = await setup(t, {
    tvProfile: 'none', devices: [{ deviceId: 'tv', tvProfile: 'lg', tvButtons: ['home', 'power_toggle'] }],
  });
  assert.equal(h.handler('tv'), undefined);
  assert.equal(h.platform.handlers.size, 6);
  assert.ok(h.service('rf', h.S.WindowCovering, 'cover'));
  assert.ok(h.handler('relay'));
});

nativeTest('disabled cached TV remotes are unregistered on startup even when cloud discovery fails', async (t) => {
  const original = await setup(t);
  const tvUUID = original.handler('tv').accessory.UUID;
  const rfUUID = original.handler('rf').accessory.UUID;
  const serialized = [...original.platform.accessories.values()].map((accessory) => original.api.platformAccessory.serialize(accessory));
  const disabledConfigs = [
    { tvProfile: 'none', devices: [{ deviceId: 'tv', tvProfile: 'lg', tvButtons: ['home'] }] },
    { tvProfile: 'lg', tvButtons: [] },
    { devices: [{ deviceId: 'tv', tvProfile: 'none' }] },
    { devices: [{ deviceId: 'tv', tvButtons: [] }] },
  ];
  for (const config of disabledConfigs) {
    const restored = await setup(t, config, { refresh: false });
    for (const accessory of serialized) restored.platform.configureAccessory(restored.api.platformAccessory.deserialize(accessory));
    restored.client.snapshot = async () => { throw new OrviboError('Simulated outage', 'NETWORK'); };
    await restored.platform.start();
    assert.deepEqual(restored.events.remove.map((accessory) => accessory.UUID), [tvUUID]);
    assert.equal(restored.platform.accessories.has(tvUUID), false);
    assert.equal(restored.platform.accessories.has(rfUUID), true);
    assert.equal(restored.platform.handlers.size, 6);
    assert.equal(restored.events.register.length, 0);
  }
});

nativeTest('per-device None removes only the selected TV and re-enabling restores its UUID without changing the blind', async (t) => {
  const h = await setup(t, { tvProfile: 'lg' }, { refresh: false });
  h.client.snapshot = async () => {
    const result = snapshot();
    result.families[0].devices.push(device('other-tv', '6', { cloudUid: 'shared-hub' }));
    return result;
  };
  await h.platform.refresh();
  const tvUUID = h.handler('tv').accessory.UUID;
  const otherTVUUID = h.handler('other-tv').accessory.UUID;
  const blind = h.handler('rf').accessory;
  h.platform.config.devices = [{ deviceId: 'tv', tvProfile: 'none' }];
  await h.platform.refresh();
  assert.equal(h.handler('tv'), undefined);
  assert.equal(h.handler('other-tv').accessory.UUID, otherTVUUID);
  assert.deepEqual(h.events.remove.map((accessory) => accessory.UUID), [tvUUID]);
  assert.equal(h.handler('rf').accessory, blind);
  h.platform.config.devices = [{ deviceId: 'tv', tvProfile: 'lg', tvButtons: ['home'] }];
  await h.platform.refresh();
  assert.equal(h.handler('tv').accessory.UUID, tvUUID);
  assert.equal(h.handler('other-tv').accessory.UUID, otherTVUUID);
  assert.equal(h.handler('rf').accessory, blind);
  assert.equal(h.events.register.filter((accessory) => accessory.UUID === tvUUID).length, 2);
});

nativeTest('push listener reconnects after an outage and shuts down without creating another session', async (t) => {
  const { EventEmitter } = require('node:events');
  const h = await setup(t);
  const sessions = [];
  h.platform.sessionFactory = () => {
    const session = new EventEmitter();
    session.closed = false;
    session.open = async () => {};
    session.close = () => {
      if (session.closed) return;
      session.closed = true;
      session.emit('disconnect');
    };
    sessions.push(session);
    return session;
  };
  h.platform.config.pushUpdates = true;
  h.platform.syncListeners();
  await delay(1);
  assert.equal(sessions.length, 1);
  const listener = h.platform.listeners.get('family-one');
  listener.delay = 5;
  sessions[0].close();
  await delay(15);
  assert.equal(sessions.length, 2);
  sessions[1].emit('packet', { cmd: 42, deviceId: 'door', uid: 'hardware-door', properties: { door_status: 'open' } });
  assert.equal(await h.service('door', h.S.ContactSensor, 'door').getCharacteristic(h.C.ContactSensorState).handleGetRequest(), h.C.ContactSensorState.CONTACT_NOT_DETECTED);
  h.platform.shutdown();
  await delay(15);
  assert.ok(sessions.every((session) => session.closed));
  assert.equal(sessions.length, 2);
});

nativeTest('blank UI device options allow startup and discovery of two Allone RF blinds', async (t) => {
  const api = new HomebridgeAPI();
  const logs = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((key) => [key, (message) => logs.push(String(message))]));
  const config = {
    platform: PLATFORM_NAME, username: 'user', password: 'pass', host: 'homemate.orvibo.com', pushUpdates: false,
    devices: [{ deviceId: '', name: '', exclude: false, invertPosition: false, exposeAs: 'auto', tvButtons: [] }, { name: 'Not finished yet' }],
    includeDeviceIds: [''], excludeDeviceIds: [''],
  };
  const platform = new OrviboPlatform(log, config, api);
  t.after(() => platform.shutdown());
  assert.ok(platform.client, 'cloud discovery must initialize despite the unused device row');
  platform.client.request = async (_host, route) => {
    if (route.startsWith('/getOauthToken?')) return { data: { access_token: 'test-token', user_id: 'test-user' } };
    if (route.includes('statistics')) return { data: [{ familyId: 'home', familyName: 'Home' }] };
    return { data: { device: [
      { deviceId: 'hub', uid: 'shared-hub', deviceType: 67, deviceName: 'Allone Pro', online: true },
      { deviceId: 'living-blind', uid: 'shared-hub', deviceType: 34, deviceName: 'Living blind', online: true },
      { deviceId: 'bedroom-blind', uid: 'shared-hub', deviceType: 34, deviceName: 'Bedroom blind', online: true },
    ], account: [{ userId: 'test-user', password: 'test-binary-password' }] } };
  };
  await platform.start();
  assert.equal(platform.handlers.size, 2);
  for (const handler of platform.handlers.values()) {
    assert.equal(handler.kind, 'rfCover');
    assert.equal(handler.accessory.services.filter((service) => service.UUID === api.hap.Service.WindowCovering.UUID).length, 1);
    assert.equal(handler.accessory.services.filter((service) => service.UUID === api.hap.Service.Switch.UUID).length, 0);
  }
  assert.deepEqual(platform.config.devices, []);
  assert.deepEqual(platform.config.includeDeviceIds, []);
  assert.deepEqual(platform.config.excludeDeviceIds, []);
  assert.doesNotMatch(logs.join('\n'), /Each device override must/);
  assert.match(logs.join('\n'), /Ignoring Device options row 2 without a deviceId/);
  assert.equal(config.devices.length, 2, 'normalization must not mutate Homebridge\'s source configuration');
});
