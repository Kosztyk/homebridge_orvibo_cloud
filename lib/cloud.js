'use strict';

const https = require('node:https');
const { randomBytes, randomInt } = require('node:crypto');
const {
  HOSTS, object, text, integer, passwordHash, familyRequest, readtableRequest,
  parseFamilies, parseReadtable, binaryCredentials,
} = require('./protocol');

class OrviboError extends Error {
  constructor(message, code = 'PROTOCOL') {
    super(message);
    this.name = 'OrviboError';
    this.code = code;
  }
}

function successful(payload) {
  return object(payload) && [undefined, null, 0, '0', 200, '200'].includes(payload.status ?? payload.code);
}

// Never put raw fetch/TLS errors, response text, URLs or request bodies in logs.
function requestJSON(host, pathname, { method = 'GET', body, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = https.request({
      hostname: host, port: 443, path: pathname, method, rejectUnauthorized: true,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          request.destroy();
          reject(new OrviboError('ORVIBO response exceeded the size limit'));
        } else chunks.push(chunk);
      });
      response.on('error', () => reject(new OrviboError('ORVIBO response was interrupted', 'NETWORK')));
      response.on('end', () => {
        if ([400, 401, 403].includes(response.statusCode)) return reject(new OrviboError('ORVIBO rejected the account or token', 'AUTH'));
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new OrviboError(`ORVIBO HTTPS request failed (HTTP ${response.statusCode})`, 'NETWORK'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new OrviboError('ORVIBO returned an invalid JSON response')); }
      });
    });
    const timer = setTimeout(() => {
      request.destroy();
      reject(new OrviboError('ORVIBO HTTPS request timed out', 'NETWORK'));
    }, timeout);
    request.once('close', () => clearTimeout(timer));
    request.once('error', () => reject(new OrviboError('Could not connect to the ORVIBO HTTPS server', 'NETWORK')));
    if (data) request.write(data);
    request.end();
  });
}

function normalizeConfig(input, onIncompleteDevice) {
  const config = { ...input };
  // The settings form can save an unused row or a partially entered override.
  // Overrides customize discovered devices; they must not prevent discovery.
  if (Array.isArray(config.devices)) {
    config.devices = config.devices.flatMap((row, index) => {
      if (!object(row) || typeof row.deviceId !== 'string' || !row.deviceId.trim()) {
        onIncompleteDevice?.(index + 1);
        return [];
      }
      return [{ ...row, deviceId: row.deviceId.trim() }];
    });
  }
  // An unused include-list field may be serialized as [""]. Treat it as empty,
  // otherwise the account's real device IDs would all be filtered out.
  for (const key of ['includeDeviceIds', 'excludeDeviceIds']) {
    if (Array.isArray(config[key])) {
      config[key] = config[key].map((value) => typeof value === 'string' ? value.trim() : value)
        .filter((value) => value !== '');
    }
  }
  return config;
}

function validateConfig(input) {
  const config = normalizeConfig(input);
  if (typeof config.username !== 'string' || !config.username.trim()) throw new OrviboError('Enter your HomeMate username, email or phone number in the plugin settings', 'CONFIG');
  if (!config.password && !config.passwordHash) throw new OrviboError('Enter your HomeMate password in the plugin settings', 'CONFIG');
  if (config.password !== undefined && typeof config.password !== 'string') throw new OrviboError('Password must be a string', 'CONFIG');
  if (config.passwordHash && !/^[a-fA-F0-9]{32}$/.test(config.passwordHash)) throw new OrviboError('passwordHash must be a 32-character MD5 hex string', 'CONFIG');
  if (config.host && config.host !== 'auto' && !HOSTS.includes(config.host)) throw new OrviboError('Select one of the four supported ORVIBO cloud servers', 'CONFIG');
  if (config.familyId !== undefined && typeof config.familyId !== 'string') throw new OrviboError('familyId must be a string', 'CONFIG');
  for (const key of ['includeDeviceIds', 'excludeDeviceIds', 'tvButtons']) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== 'string'))) throw new OrviboError(`${key} must be an array of strings`, 'CONFIG');
  }
  if (config.tvProfile !== undefined && !['lg', 'stored'].includes(config.tvProfile)) throw new OrviboError('TV profile must be stored or lg', 'CONFIG');
  if (config.devices !== undefined && (!Array.isArray(config.devices) || config.devices.some((row) => !object(row) || typeof row.deviceId !== 'string' || !row.deviceId))) throw new OrviboError('Each device override must contain a deviceId string', 'CONFIG');
  for (const row of config.devices || []) {
    if (row.tvProfile !== undefined && !['lg', 'stored'].includes(row.tvProfile)) throw new OrviboError('Device TV profile must be stored or lg', 'CONFIG');
    if (row.tvButtons !== undefined && (!Array.isArray(row.tvButtons) || row.tvButtons.some((key) => typeof key !== 'string'))) throw new OrviboError('Device TV buttons must be an array of strings', 'CONFIG');
    if (row.exposeAs !== undefined && !['auto', 'switch', 'outlet'].includes(row.exposeAs)) throw new OrviboError('exposeAs must be auto, switch or outlet', 'CONFIG');
  }
  return config;
}

class CloudClient {
  constructor(config, request = requestJSON) {
    config = validateConfig(config);
    this.username = config.username.trim();
    this.hash = config.passwordHash ? config.passwordHash.toUpperCase() : passwordHash(config.password);
    this.hosts = config.host && config.host !== 'auto' ? [config.host] : HOSTS;
    this.familyId = config.familyId?.trim() || '';
    this.request = request;
    this.sessionId = randomBytes(16).toString('hex');
  }

  async login() {
    let failure;
    for (const host of this.hosts) {
      try {
        const query = new URLSearchParams({ userName: this.username, type: '0', password: this.hash });
        const payload = await this.request(host, `/getOauthToken?${query}`);
        if (!successful(payload)) throw new OrviboError('ORVIBO rejected the account credentials', 'AUTH');
        const data = object(payload.data) ? payload.data : payload;
        const accessToken = text(data, ['access_token', 'accessToken']);
        const userId = text(data, ['user_id', 'userId']);
        if (!accessToken || !userId) throw new OrviboError('ORVIBO login did not return account tokens', 'AUTH');
        const body = familyRequest(accessToken, userId, Date.now(), randomInt(100000, 1000000));
        const familiesPayload = await this.request(host, '/v2/family/statistics/users', { method: 'POST', body });
        if (!successful(familiesPayload)) throw new OrviboError('ORVIBO rejected the account token', 'AUTH');
        return { host, userId, accessToken, families: parseFamilies(familiesPayload) };
      } catch (error) {
        // A known-host fallback can never forward credentials to a supplied URL.
        if (!(error instanceof OrviboError)) throw new OrviboError('ORVIBO cloud request failed', 'NETWORK');
        failure = error;
      }
    }
    throw failure || new OrviboError('No ORVIBO cloud server is configured');
  }

  async readFamily(account, family) {
    const body = readtableRequest(account.accessToken, account.userId, family.id, this.sessionId, Date.now(), randomBytes(16).toString('hex'));
    const payload = await this.request(account.host, '/v2/cmd/app/readtable', { method: 'POST', body });
    if (!successful(payload)) {
      const status = integer(payload?.status ?? payload?.code);
      throw new OrviboError(`ORVIBO device discovery was rejected (status=${status ?? 'unknown'})`);
    }
    if (!object(payload.data) || !Array.isArray(payload.data.device) && !Array.isArray(payload.data.deviceStatus)) {
      throw new OrviboError('ORVIBO did not return a device table; the existing HomeKit accessories were retained');
    }
    return {
      id: family.id, name: family.name, host: account.host, userId: account.userId,
      devices: parseReadtable(payload), credentials: binaryCredentials(payload, account.userId),
    };
  }

  async snapshot() {
    const account = await this.login();
    const selected = this.familyId ? account.families.filter((family) => family.id === this.familyId) : account.families;
    if (!selected.length) throw new OrviboError(this.familyId ? 'The selected familyId was not returned for this account; run npm run discover' : 'No HomeMate homes were returned for this account');
    const families = [];
    for (const family of selected) families.push(await this.readFamily(account, family));
    return { host: account.host, userId: account.userId, families };
  }
}

module.exports = { CloudClient, OrviboError, requestJSON, successful, validateConfig, normalizeConfig };
