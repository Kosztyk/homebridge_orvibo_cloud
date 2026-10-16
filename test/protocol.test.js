'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../lib/protocol');
const c = require('../lib/commands');
const { PacketCodec, crc32, matchesControlReply, controlPayload } = require('../lib/binary');
const reference = require('./fixtures/python-reference.json');
const clean = (value) => JSON.parse(JSON.stringify(value));

test('password hashing and both signed REST bodies match the uploaded Python integration', () => {
  assert.equal(p.passwordHash(reference.password.input), reference.password.hash);
  assert.deepEqual(p.familyRequest('test-token', 'test-user', 1700000000123, 123456), reference.familyRequest);
  assert.deepEqual(p.readtableRequest('test-token', 'test-user', 'test-family', 'test-session', 1700000000123, 'test-nonce'), reference.readtableRequest);
});

test('AES, PKCS7 padding, CRC and session header match the Python wire format byte for byte', () => {
  const codec = new PacketCodec();
  codec.sessionId = reference.sessionId;
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(codec.encode(reference.packetPayload, false).toString('hex'), reference.staticPacketHex);
  codec.key = Buffer.from(reference.dynamicKey);
  assert.equal(codec.encode(reference.packetPayload).toString('hex'), reference.dynamicPacketHex);
  assert.deepEqual(codec.decode(Buffer.from(reference.dynamicPacketHex, 'hex')), reference.packetPayload);
});

test('stream decoder handles split markers, split frames, noise, coalesced frames and bad CRC', () => {
  const codec = new PacketCodec();
  const frame = Buffer.from(reference.staticPacketHex, 'hex');
  assert.deepEqual([...codec.push(Buffer.from('garbageh'))], []);
  assert.deepEqual([...codec.push(frame.subarray(1, 29))], []);
  assert.deepEqual([...codec.push(Buffer.concat([frame.subarray(29), frame]))], [reference.packetPayload, reference.packetPayload]);
  const damaged = Buffer.from(frame);
  damaged[damaged.length - 1] ^= 1;
  assert.deepEqual([...codec.push(Buffer.concat([damaged, frame]))], [reference.packetPayload]);
});

test('all 16 device command mappings agree with the uploaded integration', () => {
  const legacy = { type: '38', value2: 128, value3: 250 };
  const property = { type: '503', value2: 128, value3: 250 };
  const relay = { type: '1' };
  const actual = {
    coverOpen: c.coverPosition(100), coverClose: c.coverPosition(0), coverPartial: c.coverPosition(37), coverStop: c.command('stop'),
    rfOpen: c.rfCover('open'), rfClose: c.rfCover('close'), rfStop: c.rfCover('stop'),
    relayOn: c.power(relay, true), relayOff: c.power(relay, false), lightOn: c.power(legacy, true), lightOff: c.power(legacy, false),
    brightness: c.brightness(legacy, 50), colorTemperature: c.colorTemperature(legacy, 250),
    propertyOn: c.power(property, true), propertyOff: c.power(property, false), propertyBrightness: c.brightness(property, 50),
  };
  assert.deepEqual(clean(actual), reference.commands);
  assert.equal(c.coverPosition(20, true).value1, 80);
  assert.equal(c.brightness(legacy, 0).order, 'off');
});

test('all 23 stored keys and 26 raw LG NEC signals agree with the Python implementation', () => {
  for (const [key, value] of Object.entries(reference.tv)) assert.deepEqual(clean(c.tvButton(key, 'stored')), value, key);
  for (const [key, value] of Object.entries(reference.lg)) assert.deepEqual(clean(c.tvButton(key, 'lg')), value, key);
  assert.throws(() => c.tvButton('home', 'stored'));
  assert.throws(() => c.tvButton('constructor', 'stored'));
  assert.equal(c.tvKeys('stored').length, 13);
  assert.equal(c.tvKeys('lg').length, 16);
  assert.deepEqual(c.tvKeys('none'), []);
  assert.deepEqual(c.tvKeys('none', ['power_toggle', 'home']), []);
  assert.throws(() => c.tvButton('power_toggle', 'none'));
});

test('TV and RF commands preserve the source packet routing and infrared field names', () => {
  const base = { cmd: 15, serial: 11, uniSerial: 22 };
  const device = { id: 'child-one', cloudUid: 'allone-hub' };
  const stored = controlPayload(base, 'user', device, c.tvButton('power_toggle'));
  assert.equal(stored.order, '310110');
  assert.equal(stored.uid, 'allone-hub');
  assert.equal(stored.deviceId, 'child-one');
  assert.equal(stored.value1, 0);
  assert.equal(stored.qualityOfService, 0);
  assert.equal(stored.pluseNum, 0);
  assert.equal(stored.freq, 0);
  assert.ok(!('groupId' in stored));
  assert.ok(!('propertyResponse' in stored));
  const lg = controlPayload(base, 'user', device, c.tvButton('home', 'lg'));
  assert.equal(lg.order, 'ir control');
  assert.equal(lg.freq, 38000);
  assert.equal(lg.pluseNum, 67);
  assert.equal(lg.pluseData.split(',').length, 67);
  assert.equal(lg.qualityOfService, 1);
  const rf = controlPayload(base, 'user', device, c.rfCover('close'));
  assert.equal(rf.order, 'rf control');
  assert.equal(rf.value1, 380001);
  assert.equal(rf.propertyResponse, 0);
});

test('acknowledgements cannot be confused with another child sharing the Allone hub', () => {
  const request = { deviceId: 'one', uid: 'hub', serial: 7, uniSerial: 77 };
  assert.equal(matchesControlReply({ cmd: 15, status: 0 }, request), true);
  assert.equal(matchesControlReply({ cmd: 15, status: 0, serial: 6 }, request), false);
  assert.equal(matchesControlReply({ cmd: 42, deviceId: 'two', uid: 'hub', value1: 50 }, request), false);
  assert.equal(matchesControlReply({ cmd: 42, uid: 'hub', value1: 50 }, request), false);
  assert.equal(matchesControlReply({ cmd: 42, uid: 'hub', serial: 7, value1: 50 }, request), true);
  assert.equal(matchesControlReply({ cmd: 42, deviceId: 'one', uid: 'hub', serial: 999, value1: 50 }, request), true);
  assert.equal(matchesControlReply({ cmd: 42, deviceId: 'one', uid: 'other', value1: 50 }, request), false);
});

test('readtable joins rooms, active-low state and status-only sensors, without retaining account secrets', () => {
  const payload = { data: {
    account: [{ userId: 'user', password: 'test-socket-password' }],
    room: [{ roomId: 'r', roomName: 'Living' }],
    device: [
      { deviceId: 'light', uid: 'hardware', deviceName: 'Lamp', deviceType: 38, subDeviceType: 4, roomId: 'r' },
      { deviceId: 'deleted', delFlag: 1 },
    ],
    deviceStatus: [
      { deviceId: 'light', online: 'online', value1: 0, value2: 128, value3: 250 },
      { deviceId: 'lock', uid: 'lock-hardware', properties: { door_status: 'closed', battery_power: 65, password: 'DO-NOT-CACHE', token: 'DO-NOT-CACHE' } },
    ],
  } };
  const devices = p.parseReadtable(payload);
  assert.equal(devices.length, 2);
  const light = devices.find((device) => device.id === 'light');
  assert.equal(light.room, 'Living');
  assert.equal(c.classify(light, devices), 'tunableLight');
  assert.equal(c.isOn(light), true);
  assert.equal(light.online, true);
  const lock = devices.find((device) => device.id === 'lock');
  assert.deepEqual(lock.properties, { door_status: 'closed', battery_power: 65 });
  assert.equal(c.classify(lock, devices), 'sensor');
  assert.doesNotMatch(JSON.stringify(devices), /DO-NOT-CACHE|test-socket-password/);
  assert.deepEqual(p.binaryCredentials(payload, 'user'), { username: 'user', password: 'test-socket-password' });
  assert.equal(p.binaryCredentials(payload, 'other'), null);
});

test('normalizers preserve unknown values instead of fabricating off/closed/zero states', () => {
  for (const input of [null, undefined, '', true, 'not-a-number', -1, 101]) assert.equal(p.percentage(input), null);
  assert.equal(p.switchState('unknown'), null);
  assert.equal(c.isOn({ value1: null }), null);
  assert.equal(p.switchState({ status: 'on' }), true);
  assert.deepEqual(p.parseFamilies({ data: { familyList: [{ familyId: 'one', familyName: 'Home' }, { familyId: 'one' }] } }), [{ id: 'one', name: 'Home' }]);
});

test('profile selection requires verified light models and uses the full hub list', () => {
  const hub = { id: 'hub', type: '67', cloudUid: 'shared', properties: {} };
  const blind = { id: 'blind', type: '34', cloudUid: 'shared', properties: {} };
  assert.equal(c.classify(blind, [hub, blind]), 'rfCover');
  assert.equal(c.classify(blind, [blind]), 'cover');
  assert.equal(c.classify({ ...blind, type: '6' }, [hub, blind]), 'tv');
  assert.equal(c.classify({ type: '38', subType: '4', value2: null, value3: 250, properties: {} }, []), null);
  assert.equal(c.classify({ type: '503', subType: '436', model: 'unknown', properties: {} }, []), null);
});
