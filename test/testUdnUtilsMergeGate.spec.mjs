// Merge-back gate (see PCX.md): the endpoints udn-utils calls must stay mounted
// with the same paths and methods, and a request that uses none of this
// branch's new options must get the same response as on `main`.
//
// The model is mocked (a loopback HTTP server speaking the Anthropic Messages
// API) and PDF rasterization/OCR is mocked, so everything is deterministic.
// Responses, and the requests the mocked model receives, are normalized
// (UUIDs, timestamps) and compared with test/data/udn-utils-gate.json, which
// was recorded by running this same file against `main` (911ca84):
//
//   CHARMD_GATE_RECORD=1 mocha test/testUdnUtilsMergeGate.spec.mjs
//
// Re-record only from `main`, never from this branch.

import { strict as assert } from 'assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { useManagedServerFixture } from './support/managed-server-fixture.mjs';
import { getConfig } from '../lib/config.mjs';
import {
  resetPdfProcessingTestDeps,
  setPdfProcessingTestDeps
} from '../routes/charmonizer/document-conversion.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'data', 'udn-utils-gate.json');

const __port = Number(process.env.CHARMONATOR_PORT) || 5003;
const charmonator = `http://localhost:${__port}/api/charmonator/v1`;
const charmonizer = `http://localhost:${__port}/api/charmonizer/v1`;
const MOCK_MODEL = 'udn-gate-anthropic-mock';

// The endpoints listed in PCX.md's merge-back gate.
const GATE_ENDPOINTS = [
  ['POST', `${charmonator}/transcript/extension`],
  ['GET', `${charmonator}/models`],
  ['POST', `${charmonator}/documents`],
  ['POST', `${charmonator}/conversion/image`],
  ['POST', `${charmonator}/conversion/file`],
  ['POST', `${charmonizer}/conversions/documents`],
  ['GET', `${charmonizer}/conversions/documents/:jobId`],
  ['GET', `${charmonizer}/conversions/documents/:jobId/result`],
  ['POST', `${charmonizer}/chunkings`],
  ['GET', `${charmonizer}/chunkings/:jobId`],
  ['POST', `${charmonizer}/summaries`],
  ['GET', `${charmonizer}/summaries/:jobId`],
  ['GET', `${charmonizer}/summaries/:jobId/result`]
];

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalize(value, key = null) {
  if (key === 'createdAt' || key === 'timestamp' || key === 'created_at') return '<time>';
  if (typeof value === 'string') return value.replace(UUID_RE, '<uuid>');
  if (Array.isArray(value)) return value.map(v => normalize(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalize(value[k], k);
    return out;
  }
  return value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startMockAnthropic() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body: JSON.parse(body || 'null') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-mock',
        content: [{ type: 'text', text: '{"markdown":"# Synthetic page\\n\\nNo real data.","isFirstPage":true}' }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, received })));
}

async function call(method, url, { json, form } = {}) {
  const opts = { method };
  if (json !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form;
    opts.headers = form.getHeaders();
  }
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

async function pollJob(url, isDone) {
  for (let i = 0; i < 300; i++) {
    const r = await call('GET', url);
    if (isDone(r.body)) return r;
    await sleep(10);
  }
  throw new Error(`job did not finish: ${url}`);
}

const SYNTHETIC_DOC = {
  id: 'udn-gate-synthetic-doc',
  content: 'Synthetic page one.\n\nSynthetic page two.',
  chunks: {
    pages: [
      { id: 'udn-gate-synthetic-doc/pages@0', parent: 'udn-gate-synthetic-doc', start: 0, length: 19, content: 'Synthetic page one.' },
      { id: 'udn-gate-synthetic-doc/pages@1', parent: 'udn-gate-synthetic-doc', start: 21, length: 19, content: 'Synthetic page two.' }
    ]
  }
};

describe('Merge-back gate: udn-utils endpoints (PCX.md)', function() {
  this.timeout(30000);
  useManagedServerFixture();

  let mock;
  let saved;

  before(async function() {
    mock = await startMockAnthropic();
    saved = {};
    for (const k of ['ANTHROPIC_BASE_URL', 'CHARMD_CACHE', 'CHARMD_CACHE_DIR', 'CHARMD_CACHE_S3_URI', 'CHARMONATOR_DEBUG_TRANSCRIPTS']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.server.address().port}`;
    getConfig().models[MOCK_MODEL] = {
      api: 'Anthropic', api_key: 'test-key-not-real', model: 'claude-mock', model_type: 'chat',
      temperature: null, max_tokens: 1024,
      num_schema_repair_max_attempts: 0, num_defective_reply_max_attempts: 1,
      num_client_request_max_attempts: 1, ms_client_request_timeout: 10000
    };
    setPdfProcessingTestDeps({
      parsePdf: async () => ({ numpages: 2 }),
      createPdfConverter: () => async pageNumber => ({ path: `mock-page-${pageNumber}.png` }),
      readImage: async imagePath => ({ async getBuffer() { return Buffer.from(imagePath, 'utf8'); } }),
      ocrPageBuffer: async buf => ({ text: `ocr of ${buf.toString('utf8')}`, qualityScore: buf.toString('utf8').includes('-2') ? 0.1 : 0.99 }),
      unlinkFile: async p => fs.promises.unlink(p).catch(() => {})
    });
  });

  after(async function() {
    resetPdfProcessingTestDeps();
    delete getConfig().models[MOCK_MODEL];
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise(resolve => mock.server.close(resolve));
  });

  it('every gate endpoint is still mounted with its method', async function() {
    for (const [method, url] of GATE_ENDPOINTS) {
      const concrete = url.replace(':jobId', 'no-such-job');
      const r = await fetch(concrete, method === 'POST'
        ? { method, headers: { 'Content-Type': 'application/json' }, body: '{}' }
        : { method });
      const text = await r.text();
      // Express answers an unmounted route with an HTML "Cannot METHOD /path" 404.
      assert.ok(!/Cannot (GET|POST)/.test(text), `${method} ${url} is not mounted (${r.status})`);
      if (url.includes(':jobId')) {
        assert.equal(r.status, 404, `${method} ${url} should 404 a missing job`);
        assert.deepEqual(JSON.parse(text), { error: 'No such job_id' });
      }
    }
  });

  it('responses without the new options match main', async function() {
    const record = {};

    record.models = await call('GET', `${charmonator}/models`);

    record.transcript_extension = await call('POST', `${charmonator}/transcript/extension`, {
      json: {
        model: MOCK_MODEL,
        transcript: { messages: [{ role: 'user', content: [
          { type: 'text', text: 'Transcribe this synthetic page.' },
          { type: 'image', url: `data:image/png;base64,${Buffer.from('synthetic png').toString('base64')}` }
        ] }] }
      }
    });

    record.documents = await call('POST', `${charmonator}/documents`, { json: { content: 'Synthetic content.' } });

    record.conversion_image = await call('POST', `${charmonator}/conversion/image`, {
      json: { model: MOCK_MODEL, imageUrl: `data:image/png;base64,${Buffer.from('synthetic png').toString('base64')}`, description: 'A synthetic page.' }
    });

    const fileForm = new FormData();
    fileForm.append('file', Buffer.from('# Synthetic\n\nA synthetic text file.\n'), { filename: 'synthetic.txt', contentType: 'text/plain' });
    record.conversion_file = await call('POST', `${charmonator}/conversion/file`, { form: fileForm });

    const convForm = new FormData();
    convForm.append('file', Buffer.from('%PDF-1.4\n% synthetic\n%%EOF\n'), { filename: 'synthetic.pdf', contentType: 'application/pdf' });
    convForm.append('model', MOCK_MODEL);
    const conv = await call('POST', `${charmonizer}/conversions/documents`, { form: convForm });
    record.conversion_submit = conv;
    record.conversion_status = await pollJob(`${charmonizer}/conversions/documents/${conv.body.job_id}`,
      b => b.status === 'complete' || b.status === 'error');
    record.conversion_result = await call('GET', `${charmonizer}/conversions/documents/${conv.body.job_id}/result`);

    const chunk = await call('POST', `${charmonizer}/chunkings`, {
      json: { document: SYNTHETIC_DOC, strategy: 'merge_and_split', chunk_size: 1000, chunk_group: 'pages' }
    });
    record.chunking_submit = chunk;
    record.chunking_status = await pollJob(`${charmonizer}/chunkings/${chunk.body.job_id}`,
      b => b.status === 'complete' || b.status === 'error');

    const sum = await call('POST', `${charmonizer}/summaries`, {
      json: { document: SYNTHETIC_DOC, method: 'map', chunk_group: 'pages', model: MOCK_MODEL, guidance: 'Summarize.' }
    });
    record.summary_submit = sum;
    record.summary_status = await pollJob(`${charmonizer}/summaries/${sum.body.job_id}`,
      b => b.status === 'complete' || b.status === 'error');
    record.summary_result = await call('GET', `${charmonizer}/summaries/${sum.body.job_id}/result`);

    // What the (mocked) model was sent must not change either.
    record.model_requests = mock.received;

    const actual = normalize(record);

    if (process.env.CHARMD_GATE_RECORD) {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
      this.skip();
    }

    const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    // models lists the whole config; compare only its entry shape and our mock entry.
    const pick = m => ({ shape: Object.keys(m.body.models[0]).sort(), mock: m.body.models.find(x => x.id === MOCK_MODEL), status: m.status });
    assert.deepEqual(pick(actual.models), pick(expected.models));
    delete actual.models;
    delete expected.models;
    for (const k of Object.keys(expected)) {
      assert.deepEqual(actual[k], expected[k], `response for ${k} differs from main`);
    }
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  });
});
