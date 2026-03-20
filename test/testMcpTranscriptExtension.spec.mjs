import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { createAndStart } from '../lib/server.mjs';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use the same port as in other tests
const __port = 5003;
const mymodel = 'my-unittest-model';
const baseCharmonatorUrl = `http://localhost:${__port}/api/charmonator/v1`;

// A unitless constant converting the expected time on a good day to
// the upper bound time for failing a test.
const timeoutMargin = 5;

tags().describe('MCP Integration Tests', function() {
  let processes;
  let server;

  // Start both the charmonator server and MCP test server before tests
  before(async function() {
    this.timeout(10000); // Allow time for both servers to start

    processes = await createAndStart();
    server = processes.server;
    console.log('Charmonator server started with MCP configuration');
  });

  // Stop both servers after tests
  after(async function() {
    // Use a reasonable timeout for cleanup
    this.timeout(10000);

    // Shutdown charmonator server
    processes.cleanup()
    console.log('Charmonator server stopped');
  });

  // Test the echo tool via transcript/extension endpoint
  tags('llm').it('should call MCP echo tool via transcript/extension', async function() {
    this.timeout(5000 * timeoutMargin);

    const url = `${baseCharmonatorUrl}/transcript/extension`;
    const body = {
      model: mymodel,
      system: 'You are a helpful assistant. Use the echo tool to respond to the user.',
      temperature: 0.0,
      tools: [
        {"name":"echo"}
      ],
      transcript: {
        messages: [
          { role: 'user', content: 'Please use the echo tool to repeat this message: "Hello from MCP test!"' }
        ]
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    assert(response.status >= 200 && response.status < 300, `Expected 2xx status, got ${response.status}`);

    const data = await response.json();
    assert(Array.isArray(data.messages), 'Response should contain messages array');

    // Verify the response contains a tool call to the echo tool
    const hasToolCall = data.messages.some(msg => 
      msg.role === 'tool_call' && 
      msg.content && 
      msg.content.some(c => c.toolName === 'echo')
    );

    assert(hasToolCall, 'Response should include a call to the echo tool');

    // Verify there's a tool response
    const hasToolResponse = data.messages.some(msg => 
      msg.role === 'tool_response' && 
      msg.content && 
      msg.content.some(c => c.toolName === 'echo')
    );

    assert(hasToolResponse, 'Response should include a tool response from the echo tool');

    // Verify the final assistant message contains the echoed message
    const finalMessage = data.messages.find(msg => msg.role === 'assistant');
    assert(finalMessage, 'Response should include a final assistant message');
    assert(finalMessage.content.includes('Hello from MCP test'), 
      'Final message should contain the echoed text');
  });

  tags('llm').it('should not call MCP echo tool without request via transcript/extension', async function() {
    this.timeout(5000 * timeoutMargin);

    const url = `${baseCharmonatorUrl}/transcript/extension`;
    const body = {
      model: mymodel,
      system: 'You are a helpful assistant. Use the echo tool to respond to the user.',
      temperature: 0.0,
      tools: [
        // no tools requested
      ],
      transcript: {
        messages: [
          { role: 'user', content: 'Please use the echo tool to repeat this message: "Hello from MCP test!"' }
        ]
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    assert(response.status >= 200 && response.status < 300, `Expected 2xx status, got ${response.status}`);

    const data = await response.json();
    console.log(JSON.stringify({data}))
    assert(Array.isArray(data.messages), 'Response should contain messages array');

    // Verify the response contains a tool call to the echo tool
    const hasToolCall = data.messages.some(msg =>
      msg.role === 'tool_call' &&
      msg.content &&
      msg.content.some(c => c.toolName === 'echo')
    );

    assert(!hasToolCall, 'Response should not include tool call not requested');
  });

  // Test the calculator tool via transcript/extension endpoint
  tags('llm').it('should call MCP calculator tool via transcript/extension', async function() {
    this.timeout(5000 * timeoutMargin);

    const url = `${baseCharmonatorUrl}/transcript/extension`;
    const body = {
      model: mymodel,
      system: 'You are a helpful assistant. Use the calculator tool to solve math problems.',
      temperature: 0.0,
      tools: [
        {"name":"calculator"}
      ],
      transcript: {
        messages: [
          { role: 'user', content: 'What is 42 * 73? Please use the calculator tool.  Do not textually reformat the response of the tool.' }
        ]
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    assert(response.status >= 200 && response.status < 300, `Expected 2xx status, got ${response.status}`);

    const data = await response.json();
    assert(Array.isArray(data.messages), 'Response should contain messages array');

    // Verify the response contains a tool call to the calculator tool
    const hasToolCall = data.messages.some(msg => 
      msg.role === 'tool_call' && 
      msg.content && 
      msg.content.some(c => c.toolName === 'calculator')
    );

    assert(hasToolCall, 'Response should include a call to the calculator tool');

    // Verify there's a tool response
    const hasToolResponse = data.messages.some(msg => 
      msg.role === 'tool_response' && 
      msg.content && 
      msg.content.some(c => c.toolName === 'calculator')
    );

    assert(hasToolResponse, 'Response should include a tool response from the calculator tool');

    // Verify the final assistant message contains the correct calculation result (42 * 73 = 3066)
    const finalMessage = data.messages.find(msg => msg.role === 'assistant');
    assert(finalMessage, 'Response should include a final assistant message');
    assert(finalMessage.content.includes('3066'), 
      'Final message should contain the correct calculation result (3066)');
  });

  // Test direct execution of MCP tools via the tools/execute endpoint
  it('should directly execute MCP tools via tools/execute endpoint', async function() {
    this.timeout(3000 * timeoutMargin);

    const url = `${baseCharmonatorUrl}/tools/execute`;
    const body = {
      toolCalls: [
        {
          toolName: 'echo',
          callId: 'test-call-1',
          arguments: {
            message: 'Direct execution test'
          }
        },
        {
          toolName: 'calc',
          callId: 'test-call-2',
          arguments: {
            operation: 'multiply',
            a: 12,
            b: 34
          }
        }
      ]
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    assert(response.status >= 200 && response.status < 300, `Expected 2xx status, got ${response.status}`);

    const data = await response.json();
    assert(Array.isArray(data.toolResponses), 'Response should contain toolResponses array');
    assert.equal(data.toolResponses.length, 2, 'Should have responses for both tool calls');

    // Verify echo response
    const echoResponse = data.toolResponses.find(r => r.toolName === 'echo');
    assert(echoResponse, 'Should have a response from the echo tool');
    assert(!echoResponse.error, 'Echo tool should not have an error');
    assert(echoResponse.content.includes('Direct execution test'), 
      'Echo response should contain the original message');

    // Verify calculator response
    const calcResponse = data.toolResponses.find(r => r.toolName === 'calc');
    assert(calcResponse, 'Should have a response from the calculator tool');
    assert(!calcResponse.error, 'Calculator tool should not have an error');
    assert(calcResponse.content.includes('408'), 
      'Calculator response should contain the correct result (12 * 34 = 408)');
  });

  // Test listing available MCP tools
  it('should list available MCP tools', async function() {
    const url = `${baseCharmonatorUrl}/tools/list`;

    const response = await fetch(url);
    assert(response.status >= 200 && response.status < 300, `Expected 2xx status, got ${response.status}`);

    const data = await response.json();
    assert(Array.isArray(data.tools), 'Response should contain tools array');

    // Verify MCP tools are in the list
    const echoTool = data.tools.find(t => t.name === 'echo');
    assert(echoTool, 'Echo tool should be in the list');

    const calcTool = data.tools.find(t => t.name === 'calc');
    assert(calcTool, 'Calculator tool should be in the list');
  });
});
