#!/usr/bin/env node
/**
 * test-endpoint-tokens.mjs
 *
 * Tests the /tokens and /tokens/count endpoints.
 *
 * Usage: node tests/test-endpoint-tokens.mjs
 *
 * Prerequisites: Server must be running (node server.mjs)
 */

import fetch from 'node-fetch';

const PORT = process.env.CHARMONATOR_PORT || 5002;
const BASE_PREFIX = process.env.CHARMONATOR_PREFIX || '/charm';
const BASE_URL = `http://localhost:${PORT}${BASE_PREFIX}/api/charmonator/v1`;

let passed = 0;
let failed = 0;

function log(message) {
  console.log(message);
}

function success(testName) {
  passed++;
  console.log(`  [PASS] ${testName}`);
}

function fail(testName, error) {
  failed++;
  console.log(`  [FAIL] ${testName}`);
  console.log(`         Error: ${error}`);
}

async function postJson(endpoint, body) {
  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  return { response, data };
}

async function testServerAvailable() {
  log('\n=== Checking Server Availability ===');
  try {
    const response = await fetch(`${BASE_URL}/models`);
    if (response.ok) {
      success('Server is running');
      return true;
    } else {
      fail('Server is running', `Status: ${response.status}`);
      return false;
    }
  } catch (err) {
    fail('Server is running', `Could not connect to ${BASE_URL}. Is the server running?`);
    return false;
  }
}

// ============================================================
// POST /tokens tests
// ============================================================

async function testTokensBasic() {
  log('\n=== POST /tokens - Basic Tests ===');

  // Test 1: Basic tokenization with default tokenizer
  try {
    const { response, data } = await postJson('/tokens', {
      text: 'Hello, world!'
    });
    if (response.ok && Array.isArray(data.tokens) && data.count > 0 && data.encoding === 'cl100k_base') {
      success('Basic tokenization with default encoding');
    } else {
      fail('Basic tokenization with default encoding', JSON.stringify(data));
    }
  } catch (err) {
    fail('Basic tokenization with default encoding', err.message);
  }

  // Test 2: Tokenization with explicit cl100k_base tokenizer
  try {
    const { response, data } = await postJson('/tokens', {
      text: 'The quick brown fox jumps over the lazy dog.',
      tokenizer: 'cl100k_base'
    });
    if (response.ok && Array.isArray(data.tokens) && data.encoding === 'cl100k_base' && data.mode === 'local') {
      success('Tokenization with cl100k_base');
    } else {
      fail('Tokenization with cl100k_base', JSON.stringify(data));
    }
  } catch (err) {
    fail('Tokenization with cl100k_base', err.message);
  }

  // Test 3: Tokenization with o200k_base tokenizer
  try {
    const { response, data } = await postJson('/tokens', {
      text: 'Testing with the newer o200k encoding.',
      tokenizer: 'o200k_base'
    });
    if (response.ok && Array.isArray(data.tokens) && data.encoding === 'o200k_base') {
      success('Tokenization with o200k_base');
    } else {
      fail('Tokenization with o200k_base', JSON.stringify(data));
    }
  } catch (err) {
    fail('Tokenization with o200k_base', err.message);
  }

  // Test 4: Token count matches array length
  try {
    const { response, data } = await postJson('/tokens', {
      text: 'Count should match array length.'
    });
    if (response.ok && data.count === data.tokens.length) {
      success('Token count matches array length');
    } else {
      fail('Token count matches array length', `count=${data.count}, tokens.length=${data.tokens?.length}`);
    }
  } catch (err) {
    fail('Token count matches array length', err.message);
  }
}

async function testTokensValidation() {
  log('\n=== POST /tokens - Validation Tests ===');

  // Test 1: Missing text field
  try {
    const { response, data } = await postJson('/tokens', {});
    if (response.status === 400 && data.error) {
      success('Missing text returns 400');
    } else {
      fail('Missing text returns 400', `Status: ${response.status}`);
    }
  } catch (err) {
    fail('Missing text returns 400', err.message);
  }

  // Test 2: Invalid text type (number)
  try {
    const { response, data } = await postJson('/tokens', { text: 12345 });
    if (response.status === 400 && data.error) {
      success('Invalid text type returns 400');
    } else {
      fail('Invalid text type returns 400', `Status: ${response.status}`);
    }
  } catch (err) {
    fail('Invalid text type returns 400', err.message);
  }

  // Test 3: Both tokenizer and model provided
  try {
    const { response, data } = await postJson('/tokens', {
      text: 'Test',
      tokenizer: 'cl100k_base',
      model: 'some-model'
    });
    if (response.status === 400 && data.error && data.error.includes('Cannot specify both')) {
      success('Both tokenizer and model returns 400');
    } else {
      fail('Both tokenizer and model returns 400', `Status: ${response.status}, Error: ${data.error}`);
    }
  } catch (err) {
    fail('Both tokenizer and model returns 400', err.message);
  }

  // Test 4: Invalid tokenizer name
  try {
    const { response, data } = await postJson('/tokens', {
      text: 'Test',
      tokenizer: 'invalid_tokenizer'
    });
    if (response.status === 400 && data.error && data.error.includes('Unsupported tokenizer')) {
      success('Invalid tokenizer returns 400');
    } else {
      fail('Invalid tokenizer returns 400', `Status: ${response.status}, Error: ${data.error}`);
    }
  } catch (err) {
    fail('Invalid tokenizer returns 400', err.message);
  }
}

// ============================================================
// POST /tokens/count tests
// ============================================================

async function testTokensCountBasic() {
  log('\n=== POST /tokens/count - Basic Tests ===');

  // Test 1: Basic count with default tokenizer
  try {
    const { response, data } = await postJson('/tokens/count', {
      text: 'Hello, world!'
    });
    if (response.ok && typeof data.count === 'number' && data.count > 0 && data.encoding === 'cl100k_base') {
      success('Basic count with default encoding');
    } else {
      fail('Basic count with default encoding', JSON.stringify(data));
    }
  } catch (err) {
    fail('Basic count with default encoding', err.message);
  }

  // Test 2: Count with cl100k_base
  try {
    const { response, data } = await postJson('/tokens/count', {
      text: 'The quick brown fox jumps over the lazy dog.',
      tokenizer: 'cl100k_base'
    });
    if (response.ok && typeof data.count === 'number' && data.mode === 'local') {
      success('Count with cl100k_base');
    } else {
      fail('Count with cl100k_base', JSON.stringify(data));
    }
  } catch (err) {
    fail('Count with cl100k_base', err.message);
  }

  // Test 3: Count with o200k_base
  try {
    const { response, data } = await postJson('/tokens/count', {
      text: 'Testing with the newer o200k encoding.',
      tokenizer: 'o200k_base'
    });
    if (response.ok && typeof data.count === 'number' && data.encoding === 'o200k_base') {
      success('Count with o200k_base');
    } else {
      fail('Count with o200k_base', JSON.stringify(data));
    }
  } catch (err) {
    fail('Count with o200k_base', err.message);
  }

  // Test 4: Empty string returns 0 tokens
  try {
    const { response, data } = await postJson('/tokens/count', {
      text: ''
    });
    // Empty string should still fail validation since we check for truthy text
    if (response.status === 400) {
      success('Empty string returns 400');
    } else if (response.ok && data.count === 0) {
      success('Empty string returns 0 tokens');
    } else {
      fail('Empty string handling', JSON.stringify(data));
    }
  } catch (err) {
    fail('Empty string handling', err.message);
  }
}

async function testTokensCountValidation() {
  log('\n=== POST /tokens/count - Validation Tests ===');

  // Test 1: Missing text field
  try {
    const { response, data } = await postJson('/tokens/count', {});
    if (response.status === 400 && data.error) {
      success('Missing text returns 400');
    } else {
      fail('Missing text returns 400', `Status: ${response.status}`);
    }
  } catch (err) {
    fail('Missing text returns 400', err.message);
  }

  // Test 2: Both tokenizer and model provided
  try {
    const { response, data } = await postJson('/tokens/count', {
      text: 'Test',
      tokenizer: 'cl100k_base',
      model: 'some-model'
    });
    if (response.status === 400 && data.error) {
      success('Both tokenizer and model returns 400');
    } else {
      fail('Both tokenizer and model returns 400', `Status: ${response.status}`);
    }
  } catch (err) {
    fail('Both tokenizer and model returns 400', err.message);
  }

  // Test 3: Invalid tokenizer name
  try {
    const { response, data } = await postJson('/tokens/count', {
      text: 'Test',
      tokenizer: 'not_a_real_tokenizer'
    });
    if (response.status === 400 && data.error) {
      success('Invalid tokenizer returns 400');
    } else {
      fail('Invalid tokenizer returns 400', `Status: ${response.status}`);
    }
  } catch (err) {
    fail('Invalid tokenizer returns 400', err.message);
  }
}

// ============================================================
// Consistency tests
// ============================================================

async function testConsistency() {
  log('\n=== Consistency Tests ===');

  // Test 1: /tokens and /tokens/count return same count
  try {
    const text = 'This is a test sentence for consistency checking.';
    const { data: tokensData } = await postJson('/tokens', { text, tokenizer: 'cl100k_base' });
    const { data: countData } = await postJson('/tokens/count', { text, tokenizer: 'cl100k_base' });

    if (tokensData.count === countData.count) {
      success('/tokens and /tokens/count return same count');
    } else {
      fail('/tokens and /tokens/count return same count',
           `tokens.count=${tokensData.count}, count.count=${countData.count}`);
    }
  } catch (err) {
    fail('/tokens and /tokens/count return same count', err.message);
  }

  // Test 2: Different encodings can produce different token counts
  try {
    const text = 'Testing different encodings for the same text.';
    const { data: cl100k } = await postJson('/tokens/count', { text, tokenizer: 'cl100k_base' });
    const { data: o200k } = await postJson('/tokens/count', { text, tokenizer: 'o200k_base' });

    // They might be the same or different, but both should be valid counts
    if (typeof cl100k.count === 'number' && typeof o200k.count === 'number') {
      success(`Different encodings produce valid counts (cl100k=${cl100k.count}, o200k=${o200k.count})`);
    } else {
      fail('Different encodings produce valid counts', 'Invalid count values');
    }
  } catch (err) {
    fail('Different encodings produce valid counts', err.message);
  }

  // Test 3: Unicode text tokenization
  try {
    const text = 'Hello, \u4e16\u754c! Emoji: \ud83d\ude00\ud83d\udc4d';
    const { response, data } = await postJson('/tokens', { text });
    if (response.ok && Array.isArray(data.tokens) && data.count > 0) {
      success('Unicode and emoji tokenization works');
    } else {
      fail('Unicode and emoji tokenization works', JSON.stringify(data));
    }
  } catch (err) {
    fail('Unicode and emoji tokenization works', err.message);
  }

  // Test 4: Long text tokenization
  try {
    const text = 'word '.repeat(1000);
    const { response, data } = await postJson('/tokens/count', { text });
    if (response.ok && data.count >= 1000) {
      success(`Long text tokenization works (${data.count} tokens)`);
    } else {
      fail('Long text tokenization works', JSON.stringify(data));
    }
  } catch (err) {
    fail('Long text tokenization works', err.message);
  }
}

// ============================================================
// Main
// ============================================================

async function runTests() {
  console.log('===========================================');
  console.log('  Charmonator /tokens Endpoint Tests');
  console.log('===========================================');
  console.log(`Server: ${BASE_URL}`);

  const serverUp = await testServerAvailable();
  if (!serverUp) {
    console.log('\nServer is not available. Please start the server first:');
    console.log('  node server.mjs');
    process.exit(1);
  }

  await testTokensBasic();
  await testTokensValidation();
  await testTokensCountBasic();
  await testTokensCountValidation();
  await testConsistency();

  console.log('\n===========================================');
  console.log('  Test Results');
  console.log('===========================================');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);
  console.log('===========================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
