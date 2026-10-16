'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CloudClient, OrviboError, validateConfig } = require('../lib/cloud');
const { passwordHash, sign } = require('../lib/protocol');

test('discovery uses signed requests, transient binary credentials and all homes by default', async () => {
  const calls = [];
  const request = async (host, route, options) => {
    calls.push({ host, route, options });
    if (route.startsWith('/getOauthToken?')) return { status: 0, data: { access_token: 'test-token', user_id: 'user-id' } };
    const body = { ...options.body };
    delete body.sign;
    assert.equal(options.body.sign, sign(body));
    if (route === '/v2/family/statistics/users') return { status: 0, data: [{ familyId: 'first', familyName: 'Home' }, { familyId: 'second', familyName: 'Other home' }] };
    return { status: 0, data: { device: [{ deviceId: `${body.familyId}-blind`, uid: 'hub', deviceType: 34 }], account: [{ userId: 'user-id', password: 'socket-pass' }] } };
  };
  const client = new CloudClient({ username: 'email@example.com', password: 'test-password', host: 'homemate.orvibo.com' }, request);
  const snapshot = await client.snapshot();
  assert.equal(snapshot.families.length, 2);
  assert.equal(snapshot.families[1].devices[0].id, 'second-blind');
  assert.deepEqual(snapshot.families[0].credentials, { username: 'user-id', password: 'socket-pass' });
  const url = new URL(`https://homemate.orvibo.com${calls[0].route}`);
  assert.equal(url.searchParams.get('password'), passwordHash('test-password'));
  assert.ok(calls.every((call) => call.host === 'homemate.orvibo.com'));
});

test('explicit family selection is enforced and unknown families do not silently fall back', async () => {
  const request = async (_host, route) => {
    if (route.startsWith('/getOauthToken?')) return { data: { access_token: 'token', user_id: 'user' } };
    if (route.includes('statistics')) return { data: [{ familyId: 'a' }, { familyId: 'b' }] };
    return { data: { device: [], account: [] } };
  };
  const client = new CloudClient({ username: 'user', password: 'pass', familyId: 'b' }, request);
  assert.equal((await client.snapshot()).families[0].id, 'b');
  client.familyId = 'missing';
  await assert.rejects(client.snapshot(), /selected familyId/);
});

test('server validation prevents sending credentials to arbitrary hosts', () => {
  const config = { username: 'user', password: 'pass' };
  assert.throws(() => new CloudClient({ ...config, host: 'https://homemate.orvibo.com@attacker.example' }), /supported ORVIBO/);
  assert.throws(() => new CloudClient({ ...config, host: 'attacker.example' }), /supported ORVIBO/);
  assert.throws(() => validateConfig({ username: 'user' }), /password/);
  assert.throws(() => validateConfig({ ...config, passwordHash: 'bad' }), /MD5/);
});

test('auto fallback reaches only known servers and an explicit server is never replaced', async () => {
  const called = [];
  const request = async (host, route) => {
    called.push(host);
    if (host === 'homemate.orvibo.com') throw new OrviboError('Rejected', 'AUTH');
    return route.startsWith('/getOauth') ? { data: { access_token: 'token', user_id: 'user' } } : { data: [] };
  };
  const auto = new CloudClient({ username: 'user', password: 'pass', host: 'auto' }, request);
  assert.equal((await auto.login()).host, 'germany.orvibo.com');
  assert.deepEqual([...new Set(called)], ['homemate.orvibo.com', 'germany.orvibo.com']);
  const explicit = new CloudClient({ username: 'user', password: 'pass', host: 'homemate.orvibo.com' }, request);
  await assert.rejects(explicit.login(), /Rejected/);
});

test('malformed discovery is rejected so cached accessories cannot be replaced by an incomplete response', async () => {
  const client = new CloudClient({ username: 'user', password: 'pass' }, async () => ({ status: 0, data: {} }));
  await assert.rejects(client.readFamily({ host: 'homemate.orvibo.com', userId: 'user', accessToken: 'token' }, { id: 'family', name: 'Home' }), /existing HomeKit accessories were retained/);
});

test('unexpected transport errors are sanitized before reaching diagnostics', async () => {
  const client = new CloudClient({ username: 'user', password: 'pass', host: 'homemate.orvibo.com' }, async () => { throw new Error('https://secret?password=DO-NOT-LOG'); });
  await assert.rejects(client.login(), (error) => {
    assert.doesNotMatch(error.message, /secret|DO-NOT-LOG|password=/);
    return error.code === 'NETWORK';
  });
});
