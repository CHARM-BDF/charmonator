import { strict as assert } from 'assert';
import net from 'net';
import { createAndStart } from '../lib/server.mjs';

const __port = 5003;

function failAfter(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, ms);
  });
}

function waitForSocketClose(socket) {
  return new Promise((resolve) => {
    socket.once('close', resolve);
    socket.once('error', () => {});
  });
}

describe('Server cleanup', function() {
  let processes;

  before(async function() {
    this.timeout(10000);
    processes = await createAndStart();
  });

  after(async function() {
    this.timeout(10000);
    await processes?.cleanup?.();
  });

  it('should force close active HTTP connections during cleanup', async function() {
    this.timeout(5000);

    const socket = net.createConnection({ host: '127.0.0.1', port: __port });
    socket.on('error', () => {});

    await new Promise((resolve) => {
      socket.once('connect', resolve);
    });

    const socketClosed = waitForSocketClose(socket);
    socket.write('GET /api/charmonator/v1/models HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n');

    await Promise.race([
      processes.cleanup(),
      failAfter(2000, 'server cleanup')
    ]);

    processes = null;

    await Promise.race([
      socketClosed,
      failAfter(2000, 'socket close')
    ]);

    assert.equal(socket.destroyed, true, 'Expected cleanup to destroy the active socket');
  });
});
