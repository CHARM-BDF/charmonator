#!/usr/bin/env node
/**
 * test-mcp-server.mjs
 *
 * Tests the MCP test server functionality.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '../mcp-servers/test-server.mjs');

let requestId = 0;

function sendRequest(proc, method, params) {
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
            proc.stdout.off('data', onData);
            if (response.error) {
              reject(new Error(response.error.message));
            } else {
              resolve(response.result);
            }
            return;
          }
        } catch (e) {
          // Partial JSON, continue buffering
        }
      }
    };

    proc.stdout.on('data', onData);

    setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error('Request timeout'));
    }, 5000);

    proc.stdin.write(JSON.stringify(request) + '\n');
  });
}

function sendNotification(proc, method, params) {
  const notification = { jsonrpc: '2.0', method, params };
  proc.stdin.write(JSON.stringify(notification) + '\n');
}

async function runTests() {
  console.log('Starting MCP test server...');

  const proc = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  proc.stderr.on('data', (data) => {
    console.log('[Server stderr]', data.toString().trim());
  });

  try {
    // Test 1: Initialize
    console.log('\n=== Test 1: Initialize ===');
    const initResult = await sendRequest(proc, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    console.log('Init result:', JSON.stringify(initResult, null, 2));

    sendNotification(proc, 'notifications/initialized', {});

    // Test 2: List tools
    console.log('\n=== Test 2: List Tools ===');
    const listResult = await sendRequest(proc, 'tools/list', {});
    console.log('Tools:', listResult.tools.map(t => t.name).join(', '));

    // Test 3: Echo tool
    console.log('\n=== Test 3: Echo Tool ===');
    const echoResult = await sendRequest(proc, 'tools/call', {
      name: 'echo',
      arguments: { message: 'Hello, MCP!' }
    });
    console.log('Echo result:', echoResult.content[0].text);

    // Test 4: Calculator - add
    console.log('\n=== Test 4: Calculator Add ===');
    const addResult = await sendRequest(proc, 'tools/call', {
      name: 'calculator',
      arguments: { operation: 'add', a: 5, b: 3 }
    });
    console.log('Add result:', addResult.content[0].text);

    // Test 5: Calculator - multiply
    console.log('\n=== Test 5: Calculator Multiply ===');
    const mulResult = await sendRequest(proc, 'tools/call', {
      name: 'calculator',
      arguments: { operation: 'multiply', a: 7, b: 6 }
    });
    console.log('Multiply result:', mulResult.content[0].text);

    // Test 6: Calculator - divide by zero
    console.log('\n=== Test 6: Calculator Divide by Zero ===');
    const divZeroResult = await sendRequest(proc, 'tools/call', {
      name: 'calculator',
      arguments: { operation: 'divide', a: 10, b: 0 }
    });
    console.log('Divide by zero result:', divZeroResult.content[0].text);
    console.log('isError:', divZeroResult.isError);

    // Test 7: Write file
    console.log('\n=== Test 7: Write File ===');
    const writeResult = await sendRequest(proc, 'tools/call', {
      name: 'write_file',
      arguments: { filename: 'test.txt', content: 'Hello from MCP test!' }
    });
    console.log('Write result:', writeResult.content[0].text);

    // Test 8: Read file (the one we just wrote)
    console.log('\n=== Test 8: Read File ===');
    const writeData = JSON.parse(writeResult.content[0].text);
    const readResult = await sendRequest(proc, 'tools/call', {
      name: 'read_file',
      arguments: { path: writeData.path }
    });
    console.log('Read result:', readResult.content[0].text);

    console.log('\n=== All tests passed! ===');

  } catch (error) {
    console.error('Test failed:', error);
    process.exitCode = 1;
  } finally {
    proc.kill('SIGTERM');
  }
}

runTests();
