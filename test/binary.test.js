'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { BinarySession, PacketCodec } = require('../lib/binary');
const { rfCover, tvButton } = require('../lib/commands');

const cert = fs.readFileSync(path.join(__dirname, '../assets/orvibo_client_cert.pem'));
const key = fs.readFileSync(path.join(__dirname, '../assets/orvibo_client_key.pem'));
const family = { id: 'test-family', host: 'homemate.orvibo.com', credentials: { username: 'test-user', password: 'test-binary-password' } };
const device = { id: 'blind-one', cloudUid: 'shared-hub' };

async function mockCloud(t, reply) {
  const received = [];
  let clientCertificateSeen = false;
  const sockets = new Set();
  const server = tls.createServer({ cert, key, requestCert: true, rejectUnauthorized: false }, (socket) => {
    sockets.add(socket);
    clientCertificateSeen = Boolean(socket.getPeerCertificate().raw);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const codec = new PacketCodec();
    socket.on('data', (chunk) => {
      for (const packet of codec.push(chunk)) {
        received.push(packet);
        if (packet.cmd === 0) {
          codec.sessionId = 'abcdef0123456789abcdef0123456789';
          const hello = codec.encode({ cmd: 0, key: '0123456789abcdef', sessionId: codec.sessionId }, false);
          codec.key = Buffer.from('0123456789abcdef');
          // One TCP read can contain the handshake plus a dynamic-key frame.
          socket.write(Buffer.concat([hello, codec.encode({ cmd: 999, status: 0 })]));
        } else if (packet.cmd === 2) {
          socket.write(codec.encode({ cmd: 2, status: 0 }));
        } else if (packet.cmd === 15) reply(socket, codec, packet);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const session = new BinarySession(family, {
    cert, key, timeout: 1500,
    tlsConnect: (options) => tls.connect({ ...options, host: '127.0.0.1', port: server.address().port }),
  });
  t.after(() => session.close());
  return { session, received, clientCertificateSeen: () => clientCertificateSeen };
}

test('full mutual-TLS handshake/login/control succeeds and command echoes are not measured state', async (t) => {
  const mock = await mockCloud(t, (socket, codec, request) => {
    socket.write(codec.encode({ cmd: 42, deviceId: 'another-blind', uid: request.uid, value1: 99 }));
    socket.write(codec.encode({ cmd: 15, status: 0, serial: request.serial, value1: 380000 }));
  });
  const packets = [];
  mock.session.on('packet', (packet) => packets.push(packet));
  const state = await mock.session.control(device, rfCover('open'));
  assert.deepEqual(state, {});
  assert.ok(mock.clientCertificateSeen());
  assert.deepEqual(mock.received.map((packet) => packet.cmd), [0, 2, 15]);
  assert.equal(mock.received[1].type, 4);
  assert.equal(mock.received[1].userName, family.credentials.username);
  assert.equal(mock.received[1].password, family.credentials.password);
  assert.ok(mock.received[2].serial > mock.received[1].serial);
  assert.equal(mock.received[2].order, 'rf control');
  assert.equal(mock.received[2].value1, 380000);
  assert.ok(packets.some((packet) => packet.cmd === 999), 'coalesced dynamic frame decoded after handshake');
  assert.equal(mock.session.closed, true);
});

test('a measured cmd=42 reply supplies state and strips unrelated properties', async (t) => {
  const mock = await mockCloud(t, (socket, codec, request) => {
    socket.write(codec.encode({ cmd: 42, deviceId: request.deviceId, uid: request.uid, value1: 63, properties: { door_status: 'open', password: 'not-state' } }));
  });
  assert.deepEqual(await mock.session.control(device, rfCover('stop')), { value1: 63, properties: { door_status: 'open' } });
});

test('rejected TV toggles fail once and are never resent', async (t) => {
  const mock = await mockCloud(t, (socket, codec, request) => {
    socket.write(codec.encode({ cmd: 15, status: 1, serial: request.serial }));
  });
  await assert.rejects(mock.session.control(device, tvButton('power_toggle')), /status=1, response_cmd=15/);
  assert.equal(mock.received.filter((packet) => packet.cmd === 15).length, 1);
  assert.equal(mock.session.closed, true);
});

test('a response from a sibling device never completes the request; timeout closes the socket', async (t) => {
  const mock = await mockCloud(t, (socket, codec, request) => {
    socket.write(codec.encode({ cmd: 42, deviceId: 'other-child', uid: request.uid, status: 0, value1: 0 }));
  });
  mock.session.timeout = 200;
  await assert.rejects(mock.session.control(device, rfCover('stop')), /timed out/);
  assert.equal(mock.session.pending.size, 0);
  assert.equal(mock.session.closed, true);
});
