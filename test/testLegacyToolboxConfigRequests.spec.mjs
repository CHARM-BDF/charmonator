import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import fetch from 'node-fetch';

import { createAndStart } from '../lib/server.mjs';

// Use the same port as other tests
const __port = 5003;
const baseCharmonatorUrl = `http://localhost:${__port}/api/charmonator/v1`;
const timeoutMargin = 5;

tags('legacy').describe('Legacy toolbox config (requests)', function() {
  let processes;

  before(async function() {
    this.timeout(10000);

    assert.equal(
      process.env.CHARMONATOR_CONFIG,
      'conf/config.unittest.legacy.json',
      'Set CHARMONATOR_CONFIG=conf/config.unittest.legacy.json (use npm run test:legacy)'
    );

    processes = await createAndStart();
  });

  after(async function() {
    this.timeout(10000);
    processes.cleanup();
  });

  it('should list legacy tools on tools/list', async function() {
    const url = `${baseCharmonatorUrl}/tools/list`;
    const response = await fetch(url);
    assert(response.status >= 200 && response.status < 300, `Expected 2xx status, got ${response.status}`);

    const data = await response.json();
    assert(Array.isArray(data.tools), 'Response should contain tools array');

    const calculatorTool = data.tools.find(t => t.name === 'calculator');
    assert(calculatorTool, 'calculator tool should be in the list');

    const webSearchTool = data.tools.find(t => t.name === 'web_search');
    assert(webSearchTool, 'web_search tool should be in the list');
  });

  it('should execute legacy calculator tool via tools/execute', async function() {
    this.timeout(3000 * timeoutMargin);

    const url = `${baseCharmonatorUrl}/tools/execute`;
    const body = {
      toolCalls: [
        {
          toolName: 'calculator',
          callId: 'legacy-calc-1',
          arguments: { expression: '42 * 73' }
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
    assert.equal(data.toolResponses.length, 1, 'Should have exactly one tool response');

    const calcResponse = data.toolResponses[0];
    assert.equal(calcResponse.toolName, 'calculator');
    assert(!calcResponse.error, `calculator should not error: ${calcResponse.error}`);
    assert(String(calcResponse.content).includes('3066'), 'calculator response should contain 3066');
  });
});

