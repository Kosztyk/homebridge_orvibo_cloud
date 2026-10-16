'use strict';

const { createHash, createHmac } = require('node:crypto');

const HOSTS = ['homemate.orvibo.com', 'germany.orvibo.com', 'china.orvibo.com', 'usa.orvibo.com'];
const APP_VERSION = '5.2.6.302';
const HMAC_SECRET = 'nQ45RjPtOws96jmH';
const STATE_KEYS = ['value1', 'value2', 'value3', 'value4'];
const PROPERTY_KEYS = ['door_status', 'battery_power', 'onoff'];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(row, keys) {
  for (const key of keys) {
    if (row[key] !== null && row[key] !== undefined && String(row[key]).trim()) {
      return String(row[key]).trim();
    }
  }
  return '';
}

function integer(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function switchState(value) {
  if (object(value)) value = value.status;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'on', 'open', 'online', 'connected'].includes(normalized)) return true;
    if (['0', 'false', 'off', 'closed', 'offline', 'disconnected'].includes(normalized)) return false;
  }
  return null;
}

function percentage(value) {
  const result = integer(value);
  return result !== null && result >= 0 && result <= 100 ? result : null;
}

// Persist only state needed by HomeKit; never cache account records or raw tables.
function safeProperties(value) {
  const result = {};
  if (!object(value)) return result;
  for (const key of PROPERTY_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = object(value[key]) ? value[key].status : value[key];
    if (typeof entry === 'string' && entry.length <= 30 || typeof entry === 'boolean'
      || typeof entry === 'number' && Number.isFinite(entry)) result[key] = entry;
  }
  return result;
}

function passwordHash(password) {
  return createHash('md5').update(password, 'utf8').digest('hex').toUpperCase();
}

function sign(body) {
  const canonical = Object.keys(body).sort().map((key) => `${key}=${body[key]}`).join('&');
  return createHmac('sha256', HMAC_SECRET).update(`${canonical}&key=${HMAC_SECRET}`).digest('hex').toUpperCase();
}

function familyRequest(accessToken, userId, timestamp, nonce) {
  const body = { accessToken, userId, timestamp: String(timestamp), random: String(nonce) };
  return { ...body, sign: sign(body) };
}

function readtableRequest(accessToken, userId, familyId, sessionId, timestamp, nonce) {
  const body = {
    accessToken, dataType: 'all', deviceFlag: 0, familyId, lastUpdateTime: 0,
    pageIndex: 0, random: nonce, serial: Math.floor(timestamp / 1000), sessionId,
    timestamp, userId, userName: userId, ver: APP_VERSION,
  };
  return { ...body, sign: sign(body) };
}

function parseFamilies(payload) {
  let rows = payload.data;
  if (object(rows)) rows = rows.families || rows.familyList || rows.list;
  if (!Array.isArray(rows)) return [];
  const families = new Map();
  for (const row of rows) {
    if (!object(row)) continue;
    const id = text(row, ['familyId', 'family_id', 'id']);
    if (id && !families.has(id)) {
      families.set(id, { id, name: text(row, ['familyName', 'family_name', 'name']) || id });
    }
  }
  return [...families.values()];
}

function parseReadtable(payload) {
  if (!object(payload.data)) return [];
  const data = payload.data;
  const active = (rows) => (Array.isArray(rows) ? rows : []).filter((row) => object(row) && ![1, '1'].includes(row.delFlag));
  const rooms = new Map(active(data.room).map((row) => [text(row, ['roomId', 'roomID']), text(row, ['roomName'])]));
  const statuses = new Map(active(data.deviceStatus).map((row) => [text(row, ['deviceId', 'deviceID']), row]));
  const devices = new Map();
  function normalize(row, status, id) {
    const device = {
      id,
      name: text(row, ['deviceName', 'devName', 'name', 'nickName', 'nickname']),
      model: text(row, ['model', 'modelName', 'modelId', 'modelID', 'productName', 'productId', 'productID', 'pdid']),
      type: text(row, ['deviceType', 'devType', 'type', 'category', 'deviceCategory']),
      subType: text(row, ['subDeviceType', 'subDevType']),
      room: text(row, ['roomName', 'room']) || rooms.get(text(row, ['roomId', 'roomID'])) || '',
      parentId: text(row, ['parentUid', 'parentId', 'parentID', 'gatewayUid', 'hubUid']),
      cloudUid: text(row, ['uid']),
      online: switchState(status.online),
      properties: safeProperties(status.properties),
    };
    for (const key of STATE_KEYS) device[key] = integer(status[key]);
    return device;
  }
  for (const row of active(data.device)) {
    const id = text(row, ['deviceId', 'deviceID', 'deviceUid', 'deviceUUID', 'uid']);
    if (!id) continue;
    devices.set(id, normalize(row, statuses.get(id) || row, id));
  }
  // Locks and newer endpoints can exist only in deviceStatus.
  for (const [id, row] of statuses) {
    if (id && !devices.has(id) && Object.keys(safeProperties(row.properties)).length) {
      devices.set(id, normalize(row, row, id));
    }
  }
  return [...devices.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function binaryCredentials(payload, userId) {
  let rows = payload.data?.account;
  if (object(rows)) rows = [rows];
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (object(row) && text(row, ['userId']) === userId && text(row, ['password'])) {
      return { username: userId, password: text(row, ['password']) };
    }
  }
  return null;
}

module.exports = {
  HOSTS, APP_VERSION, STATE_KEYS, object, text, integer, switchState, percentage,
  safeProperties, passwordHash, sign, familyRequest, readtableRequest, parseFamilies,
  parseReadtable, binaryCredentials,
};
