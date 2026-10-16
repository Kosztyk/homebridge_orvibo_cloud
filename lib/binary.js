'use strict';

const tls = require('node:tls');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { APP_VERSION, STATE_KEYS, object, integer, safeProperties } = require('./protocol');
const { TV_ORDERS } = require('./commands');
const { OrviboError } = require('./cloud');

const STATIC_KEY = Buffer.from('khggd54865SNJHGF');
const HEADER_SIZE = 42;
const TV_ORDER_SET = new Set(Object.values(TV_ORDERS));
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

class PacketCodec {
  constructor() {
    this.key = null;
    this.sessionId = '0'.repeat(32);
    this.buffer = Buffer.alloc(0);
  }

  encode(payload, dynamic = true) {
    const useDynamic = dynamic && this.key !== null;
    const cipher = createCipheriv('aes-128-ecb', useDynamic ? this.key : STATIC_KEY, null);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    if (HEADER_SIZE + encrypted.length > 65535) throw new OrviboError('ORVIBO command is too large');
    const header = Buffer.alloc(HEADER_SIZE, 0x30);
    header.write('hd', 0, 'ascii');
    header.writeUInt16BE(HEADER_SIZE + encrypted.length, 2);
    header.write(useDynamic ? 'dk' : 'pk', 4, 'ascii');
    header.writeUInt32BE(crc32(encrypted), 6);
    header.write(this.sessionId.padEnd(32, '0').slice(0, 32), 10, 32, 'ascii');
    return Buffer.concat([header, encrypted]);
  }

  decode(frame) {
    if (frame.length < HEADER_SIZE || frame.subarray(0, 2).toString() !== 'hd' || frame.readUInt16BE(2) !== frame.length) return null;
    const encrypted = frame.subarray(HEADER_SIZE);
    if (!encrypted.length || encrypted.length % 16 || crc32(encrypted) !== frame.readUInt32BE(6)) return null;
    for (const key of [this.key, STATIC_KEY]) {
      if (!key) continue;
      try {
        const decipher = createDecipheriv('aes-128-ecb', key, null);
        const payload = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
        if (!object(payload)) continue;
        const session = frame.subarray(10, 42).toString('ascii').replace(/\0/g, '');
        if (session && session !== '0'.repeat(32)) this.sessionId = session.padEnd(32, '0').slice(0, 32);
        return payload;
      } catch { /* Try the static bootstrap key before discarding this frame. */ }
    }
    return null;
  }

  *push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const start = this.buffer.indexOf('hd');
      if (start < 0) {
        this.buffer = this.buffer.at(-1) === 0x68 ? Buffer.from('h') : Buffer.alloc(0);
        break;
      }
      if (start) this.buffer = this.buffer.subarray(start);
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt16BE(2);
      if (length < HEADER_SIZE + 16 || (length - HEADER_SIZE) % 16) {
        this.buffer = this.buffer.subarray(2);
        continue;
      }
      if (this.buffer.length < length) break;
      const frame = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      const payload = this.decode(frame);
      if (payload) yield payload;
    }
  }
}

function hasState(packet) {
  return STATE_KEYS.some((key) => Object.hasOwn(packet, key)) || object(packet.properties);
}

function matchesControlReply(packet, request) {
  const cmd = integer(packet.cmd);
  if (![15, 42].includes(cmd)) return false;
  for (const key of ['deviceId', 'uid']) {
    if (packet[key] !== undefined && packet[key] !== null && packet[key] !== '' && String(packet[key]) !== String(request[key])) return false;
  }
  if (cmd === 42 && packet.deviceId !== undefined && packet.deviceId !== null && packet.deviceId !== '') return hasState(packet) || Object.hasOwn(packet, 'status');
  let sequenceMatched = false;
  for (const key of ['serial', 'uniSerial']) {
    if (Object.hasOwn(packet, key)) {
      if (integer(packet[key]) === null || integer(packet[key]) !== integer(request[key])) return false;
      sequenceMatched = true;
    }
  }
  return cmd === 42 ? sequenceMatched && (hasState(packet) || Object.hasOwn(packet, 'status')) : Object.hasOwn(packet, 'status');
}

function controlPayload(base, username, device, command) {
  if (!device.id || !device.cloudUid) throw new OrviboError('ORVIBO device control identifiers are missing');
  const payload = {
    ...base, uid: device.cloudUid, userName: username, deviceId: device.id, groupId: '',
    order: command.order, value1: command.value1 ?? 0, value2: command.value2 ?? 0,
    value3: command.value3 ?? 0, value4: command.value4 ?? 0, delayTime: 0,
    qualityOfService: 1, defaultResponse: 1, propertyResponse: 0,
  };
  if (command.properties) payload.properties = command.properties;
  if (TV_ORDER_SET.has(command.order)) {
    delete payload.groupId;
    delete payload.propertyResponse;
    Object.assign(payload, { qualityOfService: 0, freq: 0, pluseNum: 0 });
  }
  if (command.infrared) {
    if (command.order !== 'ir control' || !command.infrared.pulses.length) throw new OrviboError('Invalid ORVIBO infrared command');
    delete payload.groupId;
    delete payload.propertyResponse;
    Object.assign(payload, { freq: command.infrared.frequency, pluseNum: command.infrared.pulses.length, pluseData: command.infrared.pulses.join(',') });
  }
  return payload;
}

class BinarySession extends EventEmitter {
  constructor(family, options = {}) {
    super();
    this.family = family;
    this.timeout = options.timeout ?? 10000;
    this.tlsConnect = options.tlsConnect || tls.connect;
    this.cert = options.cert || fs.readFileSync(path.join(__dirname, '../assets/orvibo_client_cert.pem'));
    this.clientKey = options.key || fs.readFileSync(path.join(__dirname, '../assets/orvibo_client_key.pem'));
    this.codec = new PacketCodec();
    this.serial = Math.floor(Date.now() / 1000);
    this.identifier = randomBytes(8).toString('hex');
    this.socket = null;
    this.pending = new Set();
    this.deadline = 0;
    this.closed = false;
  }

  base(cmd) {
    return {
      cmd, serial: ++this.serial, clientType: 1, uniSerial: Date.now(), serverRecord: false,
      ver: APP_VERSION, debugInfo: `Android_ZhiJia365_32_${APP_VERSION}`,
    };
  }

  remaining() {
    return this.deadline ? Math.max(1, this.deadline - Date.now()) : this.timeout;
  }

  async open() {
    this.deadline = Date.now() + this.timeout;
    if (!this.family.credentials?.username || !this.family.credentials?.password) throw new OrviboError('ORVIBO did not return control credentials for this home');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new OrviboError('ORVIBO binary connection timed out', 'NETWORK')); }, this.remaining());
      const failed = () => { clearTimeout(timer); reject(new OrviboError('Could not connect to the ORVIBO binary server', 'NETWORK')); };
      this.once('disconnect', failed);
      try {
        this.socket = this.tlsConnect({
          host: this.family.host, port: 10002, servername: this.family.host,
          cert: this.cert, key: this.clientKey,
          // The source integration's port-10002 server uses a legacy chain.
          // HTTPS discovery above retains normal certificate verification.
          rejectUnauthorized: false,
        });
        this.socket.once('secureConnect', () => {
          clearTimeout(timer);
          this.removeListener('disconnect', failed);
          resolve();
        });
        this.socket.on('data', (data) => {
          for (const packet of this.codec.push(data)) {
            // Update immediately: the next frame in this read may use this key.
            if (integer(packet.cmd) === 0 && packet.key) {
              this.codec.key = Buffer.from(String(packet.key), 'utf8').subarray(0, 16);
              if (typeof packet.sessionId === 'string' && packet.sessionId) this.codec.sessionId = packet.sessionId.padEnd(32, '0').slice(0, 32);
            }
            this.emit('packet', packet);
          }
        });
        this.socket.on('error', () => this.close(new OrviboError('ORVIBO binary connection failed', 'NETWORK')));
        this.socket.on('close', () => this.close(new OrviboError('ORVIBO binary connection closed', 'NETWORK')));
      } catch { clearTimeout(timer); this.removeListener('disconnect', failed); reject(new OrviboError('Could not initialize ORVIBO TLS', 'NETWORK')); }
    });
    const hello = {
      ...this.base(0), source: 'ZhiJia365', softwareVersion: '50206302',
      sysVersion: 'Android14_34', hardwareVersion: 'HomeAssistant', language: 'zh',
      identifier: this.identifier, phoneName: 'Home Assistant',
    };
    const handshake = await this.request(hello, (packet) => integer(packet.cmd) === 0, false);
    if (!handshake.key || this.codec.key?.length !== 16) throw new OrviboError('ORVIBO handshake did not return a valid encryption key');
    const login = {
      ...this.base(2), userName: this.family.credentials.username, password: this.family.credentials.password,
      familyId: this.family.id, type: 4, needAccountDetailError: true,
    };
    const response = await this.request(login, (packet) => integer(packet.cmd) === 2);
    if (![undefined, null, 0, '0'].includes(response.status)) throw new OrviboError(`ORVIBO binary login was rejected (status=${integer(response.status) ?? 'unknown'})`, 'AUTH');
    this.deadline = 0;
  }

  request(payload, predicate, dynamic = true) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.socket) return reject(new OrviboError('ORVIBO binary session is not connected', 'NETWORK'));
      const timer = setTimeout(() => { cleanup(); reject(new OrviboError('ORVIBO binary response timed out', 'NETWORK')); }, this.remaining());
      const waiter = { reject: (error) => { cleanup(); reject(error); } };
      const onPacket = (packet) => {
        if (predicate(packet)) { cleanup(); resolve(packet); }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('packet', onPacket);
        this.pending.delete(waiter);
      };
      this.pending.add(waiter);
      this.on('packet', onPacket);
      try { this.socket.write(this.codec.encode(payload, dynamic)); }
      catch { cleanup(); reject(new OrviboError('Could not send the ORVIBO binary request', 'NETWORK')); }
    });
  }

  async control(device, command) {
    try {
      const started = Date.now();
      await this.open();
      this.deadline = started + this.timeout;
      const request = controlPayload(this.base(15), this.family.credentials.username, device, command);
      const response = await this.request(request, (packet) => matchesControlReply(packet, request));
      if (![undefined, null, 0, '0'].includes(response.status)) throw new OrviboError(`ORVIBO control was rejected (status=${integer(response.status) ?? 'unknown'}, response_cmd=${integer(response.cmd) ?? 'unknown'})`, 'REJECTED');
      const state = {};
      if (integer(response.cmd) === 42) {
        for (const key of STATE_KEYS) {
          const value = integer(response[key]);
          if (value !== null) state[key] = value;
        }
        if (object(response.properties)) state.properties = safeProperties(response.properties);
      }
      return state;
    } finally { this.close(); }
  }

  close(error = new OrviboError('ORVIBO binary session stopped', 'NETWORK')) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.pending]) waiter.reject(error);
    if (this.socket) this.socket.destroy();
    this.emit('disconnect', error);
  }
}

module.exports = { BinarySession, PacketCodec, crc32, matchesControlReply, controlPayload, hasState };
