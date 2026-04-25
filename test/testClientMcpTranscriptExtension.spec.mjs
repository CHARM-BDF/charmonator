import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import fetch from 'node-fetch';
import { createAndStart } from '../lib/server.mjs';

const __port = 5003;
const mymodel = 'my-unittest-model';
const baseCharmonatorUrl = `http://localhost:${__port}/api/charmonator/v1`;

// A unitless constant converting the expected time on a good day to
// the upper bound time for failing a test.
const timeoutMargin = 5;

function findFirstToolCallMessage(messages) {
  const i = messages.find(m => m.role === 'tool_call' && Array.isArray(m.content) && m.content.length > 0);
  console.log(JSON.stringify({"event":"findToolCall", i}))
  return i
}

function findFinalAssistantMessage(messages) {
  // The server returns a suffix fragment; the final assistant message is typically last.
  // Search from end just in case.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      console.log(JSON.stringify({"event":"findFinal", message:messages[i]}))
      return messages[i];
    }
  }
  return null;
}

// Simulate a client-side MCP tool execution.
async function executeClientTool(toolName, args) {
  if (toolName === 'echo') {
    return { message: args?.message };
  }
  throw new Error(`Unknown client tool: ${toolName}`);
}

tags().describe('Client-side MCP flow (client executes tools)', function() {
  let processes;

  before(async function() {
    this.timeout(10000);
    processes = await createAndStart();
  });

  after(async function() {
    this.timeout(10000);
    await processes.cleanup();
  });

  tags('llm').it('should allow client_tools tool call + client execution + tool_response followup', async function() {
    this.timeout(5000 * timeoutMargin);

    const url = `${baseCharmonatorUrl}/transcript/extension`;

    // Step 1: ask model to call the client tool.
    const step1Body = {
      model: mymodel,
      system: 'You are a helpful assistant. Use the echo tool, then respond with the echoed message.',
      temperature: 0.0,
      client_tools: [
        {
          name: 'echo',
          description: 'Echo a message',
          input_schema: {
            type: 'object',
            properties: {
              message: { type: 'string' }
            },
            required: ['message']
          }
        }
      ],
      transcript: {
        messages: [
          { role: 'user', content: 'Please echo this exact string: "Hello from client MCP"' }
        ]
      }
    };

    const step1Resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(step1Body)
    });

    assert(step1Resp.status >= 200 && step1Resp.status < 300, `Expected 2xx status, got ${step1Resp.status}`);
    const step1Data = await step1Resp.json();
    assert(Array.isArray(step1Data.messages), 'Response should contain messages array');

    const toolCallMsg = findFirstToolCallMessage(step1Data.messages);
    assert(toolCallMsg, 'Expected a tool_call message');

    const firstCall = toolCallMsg.content[0];
    assert.equal(firstCall.toolName, 'echo');
    assert(firstCall.callId, 'Expected a callId');

    // Step 2: client executes tool locally (simulating MCP-on-client).
    const toolResult = await executeClientTool(firstCall.toolName, firstCall.arguments);

    // Step 3: send tool_response back and let model finish.
    const step2Body = {
      model: mymodel,
      system: step1Body.system,
      temperature: 0.0,
      client_tools: step1Body.client_tools,
      transcript: {
        messages: [
          ...step1Body.transcript.messages,
          // Include only the tool_call message(s) returned by the model.
          // (Do not include the server-side tool_response messages in step1Data,
          // since in the client-exec flow the client provides the tool_response.)
          ...step1Data.messages.filter(m => m.role === 'tool_call'),
          {
            role: 'tool_response',
            content: [
              {
                toolName: firstCall.toolName,
                callId: firstCall.callId,
                response: JSON.stringify(toolResult)
              }
            ]
          }
        ]
      }
    };

    const step2Resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(step2Body)
    });

    assert(step2Resp.status >= 200 && step2Resp.status < 300, `Expected 2xx status, got ${step2Resp.status}`);
    const step2Data = await step2Resp.json();
    assert(Array.isArray(step2Data.messages), 'Response should contain messages array');

    const assistantMsg = findFinalAssistantMessage(step2Data.messages);
    assert(assistantMsg, 'Expected a final assistant message');
    assert(
      String(assistantMsg.content).includes('Hello from client MCP'),
      'Final assistant message should contain echoed text'
    );
  });
});
