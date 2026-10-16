#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { CloudClient, OrviboError } = require('../lib/cloud');
const { classify } = require('../lib/commands');

async function main() {
  let config;
  if (process.env.ORVIBO_CONFIG_PATH) {
    let data;
    try { data = JSON.parse(fs.readFileSync(process.env.ORVIBO_CONFIG_PATH, 'utf8')); }
    catch { throw new OrviboError('Could not read ORVIBO_CONFIG_PATH as a JSON configuration file', 'CONFIG'); }
    if (Array.isArray(data.platforms)) {
      const matches = data.platforms.filter((item) => item.platform === 'OrviboCloud');
      if (matches.length !== 1) throw new OrviboError('The config must contain exactly one OrviboCloud platform; use a separate JSON config when there are multiple accounts', 'CONFIG');
      config = matches[0];
    } else config = data;
  } else {
    config = {
      username: process.env.ORVIBO_USERNAME,
      password: process.env.ORVIBO_PASSWORD,
      passwordHash: process.env.ORVIBO_PASSWORD_HASH,
      host: process.env.ORVIBO_HOST || 'homemate.orvibo.com',
      familyId: process.env.ORVIBO_FAMILY_ID,
    };
  }
  const snapshot = await new CloudClient(config).snapshot();
  // Deliberately omit account tokens, socket passwords, keys and raw tables.
  console.log(JSON.stringify({
    server: snapshot.host,
    homes: snapshot.families.map((family) => ({
      familyId: family.id, name: family.name,
      controlCredentialsAvailable: Boolean(family.credentials),
      devices: family.devices.map((device) => ({
        deviceId: device.id, name: device.name, room: device.room,
        type: device.type, subType: device.subType, model: device.model,
        online: device.online, homebridgeProfile: classify(device, family.devices) || 'unsupported',
      })),
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof OrviboError ? error.message : 'ORVIBO discovery failed');
  process.exitCode = 1;
});
