// Negative test: document/conversation content must never reach stdout/stderr
// unless CHARMONATOR_DEBUG_TRANSCRIPTS=1.
//
// A sentinel string is placed in every content-bearing field (message text, a
// base64 page image, document text, descriptions, the model's reply), the
// representative request paths are exercised against an in-process server with
// a mocked Anthropic endpoint, and captured stdout/stderr is searched for the
// sentinel. A positive control with the flag on proves the capture works.

import { strict as assert } from 'assert';
import http from 'http';
import fs from 'fs';
import fetch from 'node-fetch';
import { useManagedServerFixture } from './support/managed-server-fixture.mjs';
import { getConfig } from '../lib/config.mjs';

const __port = Number(process.env.CHARMONATOR_PORT) || 5003;
const charmonator = `http://localhost:${__port}/api/charmonator/v1`;
const charmonizer = `http://localhost:${__port}/api/charmonizer/v1`;

const SENTINEL = 'PHISENTINEL-7Q3Z-Jane-Doe-MRN-000000';
const SENTINEL_REPLY = 'PHISENTINEL-REPLY-9K2W';
// Image bytes carrying the sentinel; its base64 form must not leak either.
const IMAGE_B64 = Buffer.from(`\x89PNG fake page ${SENTINEL}`, 'latin1').toString('base64');
const IMAGE_DATA_URL = `data:image/png;base64,${IMAGE_B64}`;
const PDF_DATA_URL = 'data:application/pdf;base64,'
  + Buffer.from(`%PDF-1.4 not really a pdf ${SENTINEL}`).toString('base64');

const MOCK_MODEL = 'phi-log-anthropic-mock';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startMockAnthropic() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'claude-mock',
        content: [{
          type: 'text',
          text: JSON.stringify({ markdown: `page text ${SENTINEL_REPLY}`, isFirstPage: true })
        }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received }));
  });
}

function captureOutput() {
  const chunks = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = function(chunk, ...rest) {
    chunks.push(String(chunk));
    return origOut.call(process.stdout, chunk, ...rest);
  };
  process.stderr.write = function(chunk, ...rest) {
    chunks.push(String(chunk));
    return origErr.call(process.stderr, chunk, ...rest);
  };
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  };
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function waitForJob(url) {
  for (let i = 0; i < 100; i++) {
    const r = await fetch(url);
    const j = await r.json();
    if (j.status === 'complete' || j.status === 'error') {
      return j;
    }
    await sleep(50);
  }
  throw new Error(`job did not finish: ${url}`);
}

async function exerciseContentPaths() {
  // 1) charmonator transcript extension: text + image block (the page-reading path).
  const ext = await postJson(`${charmonator}/transcript/extension`, {
    model: MOCK_MODEL,
    system: `system prompt ${SENTINEL}`,
    transcript: {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Read this fax page for ${SENTINEL}` },
          { type: 'image', url: IMAGE_DATA_URL }
        ]
      }]
    }
  });
  assert.equal(ext.status, 200, JSON.stringify(ext.body));

  // 2) charmonator conversion/image.
  const img = await postJson(`${charmonator}/conversion/image`, {
    model: MOCK_MODEL,
    imageUrl: IMAGE_DATA_URL,
    description: `fax for ${SENTINEL}`,
    preceding_content: `previous page ${SENTINEL}`
  });
  assert.equal(img.status, 200, JSON.stringify(img.body));

  // 3) charmonizer document conversion (inline PDF; it fails to parse, which is fine:
  //    both the request log and the error path are exercised).
  const conv = await postJson(`${charmonizer}/conversions/documents`, {
    model: MOCK_MODEL,
    pdf_dataurl: PDF_DATA_URL,
    description: `fax for ${SENTINEL}`,
    intent: `intent ${SENTINEL}`
  });
  assert.equal(conv.status, 200, JSON.stringify(conv.body));
  await waitForJob(`${charmonizer}/conversions/documents/${conv.body.job_id}`);
  // The route leaves its temp copy behind when PDF parsing fails; remove it.
  await fs.promises.unlink(`uploads/${conv.body.job_id}.pdf`).catch(() => {});

  const doc = {
    id: 'doc-sentinel',
    content: `Patient ${SENTINEL} presented with a synthetic complaint.`,
    chunks: {
      pages: [{
        id: 'doc-sentinel/pages@0',
        parent: 'doc-sentinel',
        start: 0,
        length: 10,
        content: `Patient ${SENTINEL} presented with a synthetic complaint.`
      }]
    }
  };

  // 4) charmonizer chunkings.
  const chunk = await postJson(`${charmonizer}/chunkings`, {
    document: doc, strategy: 'merge_and_split', chunk_size: 1000, chunk_group: 'pages'
  });
  assert.ok(chunk.status < 500, JSON.stringify(chunk.body));
  if (chunk.body?.job_id) {
    await waitForJob(`${charmonizer}/chunkings/${chunk.body.job_id}`);
  }

  // 5) charmonizer summaries (calls the mocked model).
  const sum = await postJson(`${charmonizer}/summaries`, {
    document: doc, method: 'full', model: MOCK_MODEL, guidance: `summarize ${SENTINEL}`
  });
  assert.equal(sum.status, 202, JSON.stringify(sum.body));
  await waitForJob(`${charmonizer}/summaries/${sum.body.job_id}`);
}

describe('PHI-safe logging (CHARMONATOR_DEBUG_TRANSCRIPTS)', function() {
  this.timeout(30000);
  useManagedServerFixture();

  let mock;
  let savedBaseUrl;
  let savedDebug;

  before(async function() {
    mock = await startMockAnthropic();
    savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
    savedDebug = process.env.CHARMONATOR_DEBUG_TRANSCRIPTS;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.server.address().port}`;
    getConfig().models[MOCK_MODEL] = {
      api: 'Anthropic',
      api_key: 'test-key-not-real',
      model: 'claude-mock',
      model_type: 'chat',
      temperature: null,
      tools: ['echo'],
      num_schema_repair_max_attempts: 0,
      num_defective_reply_max_attempts: 1,
      num_client_request_max_attempts: 1,
      ms_client_request_timeout: 10000
    };
  });

  after(async function() {
    delete getConfig().models[MOCK_MODEL];
    if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
    if (savedDebug === undefined) delete process.env.CHARMONATOR_DEBUG_TRANSCRIPTS;
    else process.env.CHARMONATOR_DEBUG_TRANSCRIPTS = savedDebug;
    await new Promise(resolve => mock.server.close(resolve));
  });

  it('never writes document or transcript content to stdout/stderr by default', async function() {
    delete process.env.CHARMONATOR_DEBUG_TRANSCRIPTS;
    const cap = captureOutput();
    try {
      await exerciseContentPaths();
    } finally {
      cap.restore();
    }
    const out = cap.text();

    // The mocked model really did receive the content (so the paths ran).
    assert.ok(mock.received.some(b => b.includes(SENTINEL)), 'mock model never saw the sentinel');
    // Operational logging still happens.
    assert.match(out, /"event":"request"/);
    assert.match(out, /anthropic request/);

    assert.ok(!out.includes(SENTINEL), 'sentinel leaked into logs');
    assert.ok(!out.includes(SENTINEL_REPLY), 'model reply leaked into logs');
    assert.ok(!out.includes(IMAGE_B64.slice(0, 24)), 'base64 image leaked into logs');
  });

  it('positive control: with CHARMONATOR_DEBUG_TRANSCRIPTS=1 the content is logged', async function() {
    process.env.CHARMONATOR_DEBUG_TRANSCRIPTS = '1';
    const cap = captureOutput();
    try {
      await exerciseContentPaths();
    } finally {
      cap.restore();
      delete process.env.CHARMONATOR_DEBUG_TRANSCRIPTS;
    }
    assert.ok(cap.text().includes(SENTINEL), 'capture did not see debug transcript logs');
  });
});
