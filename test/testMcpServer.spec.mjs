import tags from 'mocha-tags-ultra';
import { spawn } from 'child_process';
import path from 'path';
import { strict as assert } from 'assert';
import { fileURLToPath } from 'url';
import readline from 'readline';

let requestId = 0;
let serverProc;

/**
 * Send a JSON-RPC request to the MCP server.
 */
function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const request = { jsonrpc: '2.0', id, method, params };

    let responseData = '';

    const onData = (data) => {
      responseData += data.toString();
      const lines = responseData.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id === id) {
            serverProc.stdout.off('data', onData);
            if (response.error) {
              reject(new Error(response.error.message));
            } else {
              resolve(response.result);
            }
            return;
          }
        } catch (e) {
          // Possibly partial JSON; keep buffering
        }
      }
    };

    serverProc.stdout.on('data', onData);

    // Failsafe to avoid infinite waits
    setTimeout(() => {
      serverProc.stdout.off('data', onData);
      reject(new Error('Request timeout'));
    }, 5000);

    serverProc.stdin.write(JSON.stringify(request) + '\n');
  });
}

/**
 * Send a JSON-RPC notification (no response).
 */
function sendNotification(method, params) {
  const notification = { jsonrpc: '2.0', method, params };
  serverProc.stdin.write(JSON.stringify(notification) + '\n');
}

tags().describe('MCP Test Server', function() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const serverPath = path.join(__dirname, '../mcp-servers/test-server.mjs');

  // Start MCP test server before the tests
  before(async function() {
    this.timeout(5000);
    serverProc = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Just confirm the process started
    await new Promise((resolve, reject) => {
      let started = false;
      serverProc.stderr.on('data', (data) => {
        // You can log these if useful: console.log('[stderr]', data.toString().trim());
        // The test server logs "[MCP Test Server] Starting..." so watch for that:
        if (data.toString().includes('Starting...') && !started) {
          started = true;
          resolve();
        }
      });
      // If it doesn’t output that text in time, we give up
      setTimeout(() => {
        if (!started) {
          reject(new Error('Timeout waiting for test-server startup message'));
        }
      }, 4000);
    });
  });

  // Stop MCP test server after the tests
  after(async function() {
    if (serverProc) {
      serverProc.kill('SIGTERM');
    }
  });

  it('Test 1: initialize', async function() {
    const initResult = await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    assert(initResult, 'Should receive an initialization result');
    assert.equal(initResult.serverInfo.name, 'test-mcp-server');
    // Send notification
    sendNotification('notifications/initialized', {});
  });

  it('Test 2: list tools', async function() {
    const listResult = await sendRequest('tools/list', {});
    assert(listResult.tools, 'Should return an array of tools');
    assert(listResult.tools.length > 0, 'At least one tool is expected');
  });

  it('Test 3: echo tool', async function() {
    const echoResult = await sendRequest('tools/call', {
      name: 'echo',
      arguments: { message: 'Hello, MCP!' }
    });
    assert(echoResult.content, 'Should return content');
    const parsed = JSON.parse(echoResult.content[0].text);
    assert.equal(parsed.message, 'Hello, MCP!');
  });

  it('Test 4: calculator - add', async function() {
    const addResult = await sendRequest('tools/call', {
      name: 'calculator',
      arguments: { operation: 'add', a: 5, b: 3 }
    });
    const parsed = JSON.parse(addResult.content[0].text);
    assert.equal(parsed.result, 8, '5 + 3 should be 8');
  });

  it('Test 5: calculator - multiply', async function() {
    const mulResult = await sendRequest('tools/call', {
      name: 'calculator',
      arguments: { operation: 'multiply', a: 7, b: 6 }
    });
    const parsed = JSON.parse(mulResult.content[0].text);
    assert.equal(parsed.result, 42, '7 * 6 should be 42');
  });

  it.skip('Test 6: calculator - divide by zero', async function() {
    const divZeroResult = await sendRequest('tools/call', {
      name: 'calculator',
      arguments: { operation: 'divide', a: 10, b: 0 }
    });
    // The server catches error internally and returns isError = true
    assert(divZeroResult.isError, 'Should mark divide-by-zero as error');
    const parsed = JSON.parse(divZeroResult.content[0].text);
    assert(parsed.error || parsed.message, 'Should indicate an error in the text');
  });

  it('Test 7: write file', async function() {
    const writeResult = await sendRequest('tools/call', {
      name: 'write_file',
      arguments: { filename: 'test.txt', content: 'Hello from MCP test!' }
    });
    const parsed = JSON.parse(writeResult.content[0].text);
    assert(parsed.path, 'Response should contain a file path');
    assert(parsed.success, 'Should indicate success');
  });

  it('Test 8: read file', async function() {
    // First write the file
    const writeResult = await sendRequest('tools/call', {
      name: 'write_file',
      arguments: { filename: 'test-to-read.txt', content: 'Hello from MCP read test!' }
    });
    const writeParsed = JSON.parse(writeResult.content[0].text);

    // Then read it
    const readResult = await sendRequest('tools/call', {
      name: 'read_file',
      arguments: { path: writeParsed.path }
    });
    const readParsed = JSON.parse(readResult.content[0].text);
    assert.equal(readParsed.content, 'Hello from MCP read test!');
  });
});
