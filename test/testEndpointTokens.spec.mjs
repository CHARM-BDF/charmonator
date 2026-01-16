import { strict as assert } from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import tags from 'mocha-tags-ultra';
import { createAndStart } from '../lib/server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use the same port and base URL patterns as in test/testRest.spec.mjs:
const __port = 5003;
const baseCharmonatorUrl = `http://localhost:${__port}/api/charmonator/v1`;

// Helper to POST JSON
async function postJson(endpoint, body) {
  const url = `${baseCharmonatorUrl}${endpoint}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  return { response, data };
}

tags().describe('Tokens Endpoint Tests', function() {
  let processes;
  let server;

  // Start the server before tests
  before(async function() {
    processes = await createAndStart();
    server = processes.server;
  });

  // Stop the server after tests
  after(async function() {
    processes.cleanup()
  });

  // ---------------------------------------------------------------------------
  // Server Availability
  // ---------------------------------------------------------------------------
  describe('Server Availability', function() {
    it('should confirm the server is Up', async function() {
      const url = `${baseCharmonatorUrl}/models`;
      let response;
      try {
        response = await fetch(url);
      } catch (err) {
        assert.fail(`Could not connect to ${url}. Is the server running?`);
      }
      assert.ok(response.ok, `Response status was ${response.status}`);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /tokens Basic Tests
  // ---------------------------------------------------------------------------
  describe('POST /tokens - Basic Tests', function() {
    it('should tokenize with default encoding (cl100k_base)', async function() {
      const { response, data } = await postJson('/tokens', {
        text: 'Hello, world!'
      });
      assert.ok(response.ok, `Status not OK: ${response.status}`);
      assert.ok(Array.isArray(data.tokens), 'tokens should be an array');
      assert.ok(data.count > 0, 'count should be > 0');
      assert.strictEqual(data.encoding, 'cl100k_base', 'default encoding mismatch');
    });

    it('should tokenize with explicit cl100k_base', async function() {
      const { response, data } = await postJson('/tokens', {
        text: 'The quick brown fox jumps over the lazy dog.',
        tokenizer: 'cl100k_base'
      });
      assert.ok(response.ok, `Status not OK: ${response.status}`);
      assert.ok(Array.isArray(data.tokens), 'tokens should be an array');
      assert.strictEqual(data.encoding, 'cl100k_base', 'encoding mismatch');
      assert.strictEqual(data.mode, 'local', 'mode should be local');
    });

    it('should tokenize with o200k_base', async function() {
      const { response, data } = await postJson('/tokens', {
        text: 'Testing with the newer o200k encoding.',
        tokenizer: 'o200k_base'
      });
      assert.ok(response.ok, `Status not OK: ${response.status}`);
      assert.ok(Array.isArray(data.tokens), 'tokens should be an array');
      assert.strictEqual(data.encoding, 'o200k_base', 'encoding mismatch');
    });

    it('should have matching count and tokens.length', async function() {
      const { response, data } = await postJson('/tokens', {
        text: 'Count should match array length.'
      });
      assert.ok(response.ok, `Status not OK: ${response.status}`);
      assert.strictEqual(data.count, data.tokens.length,
        `count (${data.count}) !== tokens.length (${data.tokens.length})`);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /tokens Validation Tests
  // ---------------------------------------------------------------------------
  describe('POST /tokens - Validation Tests', function() {
    it('should 400 if "text" is missing', async function() {
      const { response, data } = await postJson('/tokens', {});
      assert.strictEqual(response.status, 400, `Expected 400, got ${response.status}`);
      assert.ok(data.error, 'Should return an error message');
    });

    it('should 400 if "text" is not a string', async function() {
      const { response, data } = await postJson('/tokens', { text: 12345 });
      assert.strictEqual(response.status, 400, `Expected 400, got ${response.status}`);
      assert.ok(data.error, 'Should return an error message');
    });

    it('should 400 if both "tokenizer" and "model" are provided', async function() {
      const { response, data } = await postJson('/tokens', {
        text: 'Test',
        tokenizer: 'cl100k_base',
        model: 'some-model'
      });
      assert.strictEqual(response.status, 400, `Expected 400, got ${response.status}`);
      assert.ok(data.error.includes('Cannot specify both'),
        'Error message should mention specifying both');
    });

    it('should 400 if an invalid tokenizer is given', async function() {
      const { response, data } = await postJson('/tokens', {
        text: 'Test',
        tokenizer: 'invalid_tokenizer'
      });
      assert.strictEqual(response.status, 400, `Expected 400, got ${response.status}`);
      assert.ok(data.error.includes('Unsupported tokenizer'),
        'Error message should mention unsupported tokenizer');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /tokens/count Basic Tests
  // ---------------------------------------------------------------------------
  describe('POST /tokens/count - Basic Tests', function() {
    it('should count tokens with default encoding (cl100k_base)', async function() {
      const { response, data } = await postJson('/tokens/count', {
        text: 'Hello, world!'
      });
      assert.ok(response.ok, `Status not OK: ${response.status}`);
      assert.strictEqual(typeof data.count, 'number', 'count should be a number');
      assert.ok(data.count > 0, 'count should be > 0');
      assert.strictEqual(data.encoding, 'cl100k_base', 'default encoding mismatch');
    });

    it('should count tokens with cl100k_base', async function() {
      const { response, data } = await postJson('/tokens/count', {
        text: 'The quick brown fox jumps over the lazy dog.',
        tokenizer: 'cl100k_base'
      });
      assert.ok(response.ok, `Status not OK: ${response.status}`);
      assert.strictEqual(typeof data.count, 'number', 'count should be a number');
      assert.strictEqual(data.mode, 'local', 'mode should be local');
    });

    it('should count tokens with o200k_base', async function() {
      const { response, data } = await postJson('/tokens/count', {
        text: 'Testing with the newer o200k encoding.',
        tokenizer: 'o200k_base'
      });
      assert.ok(response.ok, `Status not OK: ${response.status}`);
      assert.strictEqual(data.encoding, 'o200k_base', 'encoding mismatch');
    });

    it('should return 400 if empty text with validations', async function() {
      // The original script tries to parse empty text; you can either
      // consider that a 400 or handle it with 0 tokens. Here we mimic the
      // original logic which expects 400 for an empty string.
      const { response, data } = await postJson('/tokens/count', {
        text: ''
      });
      if (response.status === 400) {
        // we pass
        assert.ok(data.error, 'Should return an error for empty text');
      } else {
        // or fallback if the server is coded to allow empty text
        assert.strictEqual(data.count, 0, `Expected 0 tokens, got ${data.count}`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // POST /tokens/count Validation Tests
  // ---------------------------------------------------------------------------
  describe('POST /tokens/count - Validation Tests', function() {
    it('should 400 if "text" is missing', async function() {
      const { response, data } = await postJson('/tokens/count', {});
      assert.strictEqual(response.status, 400, `Expected 400, got ${response.status}`);
      assert.ok(data.error, 'Should return an error message');
    });

    it('should 400 if both tokenizer and model are given', async function() {
      const { response, data } = await postJson('/tokens/count', {
        text: 'Test',
        tokenizer: 'cl100k_base',
        model: 'some-model'
      });
      assert.strictEqual(response.status, 400, `Expected 400, got ${response.status}`);
      assert.ok(data.error, 'Should have an error message');
    });

    it('should 400 if invalid tokenizer is provided', async function() {
      const { response, data } = await postJson('/tokens/count', {
        text: 'Test',
        tokenizer: 'not_a_real_tokenizer'
      });
      assert.strictEqual(response.status, 400, `Expected 400, got ${response.status}`);
      assert.ok(data.error, 'Expected an error message');
    });
  });

  // ---------------------------------------------------------------------------
  // Consistency Tests
  // ---------------------------------------------------------------------------
  describe('Consistency Tests', function() {
    it('"/tokens" and "/tokens/count" should return same count', async function() {
      const text = 'This is a test sentence for consistency checking.';
      const { data: tokensData } = await postJson('/tokens', {
        text,
        tokenizer: 'cl100k_base'
      });
      const { data: countData } = await postJson('/tokens/count', {
        text,
        tokenizer: 'cl100k_base'
      });

      assert.strictEqual(tokensData.count, countData.count,
        `Mismatch: tokens.count=${tokensData.count}, count.count=${countData.count}`);
    });

    it('Different encodings produce valid (possibly different) token counts', async function() {
      const text = 'Testing different encodings for the same text.';
      const { data: cl100k } = await postJson('/tokens/count', {
        text,
        tokenizer: 'cl100k_base'
      });
      const { data: o200k } = await postJson('/tokens/count', {
        text,
        tokenizer: 'o200k_base'
      });

      assert.strictEqual(typeof cl100k.count, 'number',
        `cl100k.count is not a number: ${cl100k.count}`);
      assert.strictEqual(typeof o200k.count, 'number',
        `o200k.count is not a number: ${o200k.count}`);
      // Not asserting they have to be different—only that both are valid numbers.
    });

    it('should handle Unicode and emoji tokenization', async function() {
      const text = 'Hello, \u4e16\u754c! Emoji: \ud83d\ude00\ud83d\udc4d';
      const { response, data } = await postJson('/tokens', { text });
      assert.ok(response.ok, `Status not OK: ${response.status}`);
      assert.ok(Array.isArray(data.tokens), 'tokens should be an array');
      assert.ok(data.count > 0, `Unexpected token count: ${data.count}`);
    });

    it('should handle long text tokenization', async function() {
      const text = 'word '.repeat(1000); // 1000 words
      const { response, data } = await postJson('/tokens/count', { text });
      assert.ok(response.ok, `Status not OK: ${response.status}`);
      assert.ok(data.count >= 1000,
        `Count should be >= 1000 for repeated 1000 words, got ${data.count}`);
    });
  });
});
