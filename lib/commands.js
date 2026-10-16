'use strict';

const { switchState, percentage } = require('./protocol');

const PROPERTY_MODELS = new Set([
  '294339fdc9b04613bb6cf1569305b78c', '71b94d0309094d1e9c678e4c21bbf878', 'f731c19a484c419282051494ceecd66a',
]);
const TV_ORDERS = {
  power_toggle: '310110', mute: '310112', volume_up: '310113', volume_down: '310114',
  channel_up: '310115', channel_down: '310116', menu: '310118', input: '310126',
  up: '310120', down: '310121', left: '310122', right: '310123', ok: '310124',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i), `31010${i}`])),
};
const TV_LABELS = {
  power_toggle: 'Power toggle', mute: 'Mute', volume_up: 'Volume up', volume_down: 'Volume down',
  channel_up: 'Channel up', channel_down: 'Channel down', menu: 'Menu', input: 'Input',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'OK', home: 'Home', back: 'Back', exit: 'Exit',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i), `Number ${i}`])),
};
const LG_CODES = {
  power_toggle: 0x20DF10EF, mute: 0x20DF906F, volume_up: 0x20DF40BF, volume_down: 0x20DFC03F,
  channel_up: 0x20DF00FF, channel_down: 0x20DF807F, menu: 0x20DFC23D, input: 0x20DFD02F,
  up: 0x20DF02FD, down: 0x20DF827D, left: 0x20DFE01F, right: 0x20DF609F, ok: 0x20DF22DD,
  home: 0x20DF3EC1, back: 0x20DF14EB, exit: 0x20DFDA25,
  '0': 0x20DF08F7, '1': 0x20DF8877, '2': 0x20DF48B7, '3': 0x20DFC837, '4': 0x20DF28D7,
  '5': 0x20DFA857, '6': 0x20DF6897, '7': 0x20DFE817, '8': 0x20DF18E7, '9': 0x20DF9867,
};
const DEFAULT_TV_BUTTONS = ['power_toggle', 'mute', 'volume_up', 'volume_down', 'channel_up', 'channel_down', 'input', 'menu', 'up', 'down', 'left', 'right', 'ok', 'home', 'back', 'exit'];

const clamp = (n, min, max) => Math.max(min, Math.min(max, Math.round(n)));
const command = (order, value1 = 0, value2 = 0, value3 = 0, value4 = 0, properties, infrared) => ({ order, value1, value2, value3, value4, properties, infrared });

function classify(device, devices) {
  const hub = devices.find((other) => other.cloudUid && other.cloudUid === device.cloudUid && ['30', '67'].includes(other.type));
  if (device.type === '34') return hub ? 'rfCover' : 'cover';
  if (device.type === '6' && hub?.type === '67') return 'tv';
  if (device.type === '503' && device.subType === '436' && PROPERTY_MODELS.has(device.model)) return 'tunableLight';
  if (device.type === '38' && ['4', '6', '13'].includes(device.subType)
    && Number.isInteger(device.value2) && device.value2 >= 0 && device.value2 <= 255 && device.value3 > 0) return 'tunableLight';
  if (['1', '102'].includes(device.type) && device.subType === '1') return 'light';
  if ('door_status' in device.properties || 'battery_power' in device.properties) return 'sensor';
  return null;
}

function isOn(device) {
  if (device.type === '503') {
    const property = switchState(device.properties.onoff);
    if (property !== null) return property;
  }
  return device.value1 === 0 ? true : device.value1 === 1 ? false : null;
}

function power(device, on) {
  if (device.type === '503') return command('set property', 0, 0, 0, 0, { onoff: { status: on ? 'on' : 'off' } });
  if (['1', '102'].includes(device.type)) return command(on ? 'on' : 'off', on ? 0 : 1);
  return command(on ? 'on' : 'off', on ? 0 : 1, clamp(device.value2 || 255, 1, 255), device.value3 > 0 ? device.value3 : 250);
}

function brightness(device, percent) {
  if (percent <= 0) return power(device, false);
  const value = clamp(percent * 255 / 100, 1, 255);
  // Legacy type-38 brightness commands carry Kelvin; status and CCT commands carry mired.
  return command('fast move to level', 0, value, device.type === '503' ? 0 : Math.round(1000000 / (device.value3 > 0 ? device.value3 : 250)));
}

function colorTemperature(device, mired) {
  return command('fast color temperature', 0, clamp(device.value2 || 255, 1, 255), clamp(mired, 154, 370));
}

function coverPosition(position, invert = false) {
  const target = clamp(position, 0, 100);
  return command('open', invert ? 100 - target : target);
}

function rfCover(action) {
  const codes = { open: 380000, close: 380001, stop: 380002 };
  if (!Object.hasOwn(codes, action)) throw new Error('Unsupported RF blind action');
  return command('rf control', codes[action]);
}

function tvKeys(profile, keys = DEFAULT_TV_BUTTONS) {
  return [...new Set(keys)].filter((key) => Object.hasOwn(profile === 'lg' ? LG_CODES : TV_ORDERS, key));
}

function tvButton(action, profile = 'stored') {
  if (profile === 'stored' && Object.hasOwn(TV_ORDERS, action)) return command(TV_ORDERS[action]);
  if (profile !== 'lg' || !Object.hasOwn(LG_CODES, action)) throw new Error('Unsupported TV key for the selected profile');
  const signal = LG_CODES[action];
  const pulses = [8960, 4480];
  for (let shift = 31; shift >= 0; shift--) pulses.push(560, signal >>> shift & 1 ? 1680 : 560);
  pulses.push(560);
  return command('ir control', 0, 0, 0, 0, undefined, { frequency: 38000, pulses });
}

module.exports = {
  clamp, command, classify, isOn, power, brightness, colorTemperature, coverPosition,
  rfCover, tvKeys, tvButton, TV_LABELS, TV_ORDERS, DEFAULT_TV_BUTTONS, percentage,
};
