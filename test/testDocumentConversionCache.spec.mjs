// Document-conversion result cache, replay and the pages-so-far endpoint.
// PDF processing is mocked (no OCR, no LLM); documents are synthetic.

import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { useManagedServerFixture } from './support/managed-server-fixture.mjs';
import {
  resetPdfProcessingTestDeps,
  setPdfProcessingTestDeps
} from '../routes/charmonizer/document-conversion.mjs';
import {
  computeCacheKey,
  normalizeConversionOptions,
  parseS3Uri,
  S3CacheStore,
  FsCacheStore,
  checkCacheReadiness,
  resolveCachePolicy
} from '../lib/result-cache.mjs';

const __port = Number(process.env.CHARMONATOR_PORT) || 5003;
const base = `http://localhost:${__port}/api/charmonizer/v1/conversions/documents`;
const SENTINEL = 'PHISENTINEL-CACHE-4F8R';
const MODEL = 'test-policy-conversion-image-page-loopback';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function syntheticPdf(tag) {
  return Buffer.from(`%PDF-1.4\n% synthetic test document ${tag}\n%%EOF\n`, 'utf8');
}

function dataUrl(buf) {
  return `data:application/pdf;base64,${buf.toString('base64')}`;
}

async function submitJson(body, query = '') {
  const r = await fetch(`${base}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}

async function submitMultipart(buf, filename, fields = {}) {
  const form = new FormData();
  form.append('file', buf, { filename, contentType: 'application/pdf' });
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  const r = await fetch(base, { method: 'POST', body: form, headers: form.getHeaders() });
  return { status: r.status, body: await r.json() };
}

async function status(jobId) {
  return (await fetch(`${base}/${jobId}`)).json();
}

async function waitDone(jobId, { forStore = false } = {}) {
  for (let i = 0; i < 400; i++) {
    const s = await status(jobId);
    if (s.status === 'error') assert.fail(`job error: ${JSON.stringify(s.error)}`);
    if (s.status === 'complete' && (!forStore || s.cache?.stored)) return s;
    await sleep(10);
  }
  throw new Error('job did not finish');
}

async function result(jobId) {
  return (await fetch(`${base}/${jobId}/result`)).json();
}

describe('Document conversion cache and replay', function() {
  this.timeout(20000);
  useManagedServerFixture();

  let cacheDir;
  let ocrCalls;
  let ocrDelayMs;
  const savedEnv = {};

  before(function() {
    for (const k of ['CHARMD_CACHE', 'CHARMD_CACHE_DIR', 'CHARMD_CACHE_S3_URI']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  after(function() {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(function() {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charmd-cache-test-'));
    delete process.env.CHARMD_CACHE;
    delete process.env.CHARMD_CACHE_DIR;
    ocrCalls = 0;
    ocrDelayMs = 0;
    setPdfProcessingTestDeps({
      parsePdf: async () => ({ numpages: 3 }),
      createPdfConverter: () => async pageNumber => ({ path: `mock-page-${pageNumber}.png` }),
      readImage: async imagePath => ({ async getBuffer() { return Buffer.from(imagePath, 'utf8'); } }),
      ocrPageBuffer: async buf => {
        ocrCalls += 1;
        if (ocrDelayMs) await sleep(ocrDelayMs);
        return { text: `synthetic ${buf.toString('utf8')} ${SENTINEL}`, qualityScore: 0.99 };
      },
      // Really remove the temp PDF the route writes to uploads/; mock page paths don't exist.
      unlinkFile: async p => fs.promises.unlink(p).catch(() => {})
    });
  });

  afterEach(function() {
    resetPdfProcessingTestDeps();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('without cache options behaves as before: same status shape, no cache writes', async function() {
    const pdf = syntheticPdf('plain');
    const a = await submitJson({ model: MODEL, pdf_dataurl: dataUrl(pdf) });
    assert.equal(a.status, 200);
    assert.deepEqual(Object.keys(a.body), ['job_id']);
    const s = await waitDone(a.body.job_id);
    assert.deepEqual(Object.keys(s).sort(),
      ['createdAt', 'error', 'job_id', 'pages_converted', 'pages_total', 'status']);
    const b = await submitJson({ model: MODEL, pdf_dataurl: dataUrl(pdf), replay_pace_ms: 50 });
    await waitDone(b.body.job_id);
    assert.equal(ocrCalls, 6, 'both jobs converted live');
    assert.deepEqual(fs.readdirSync(cacheDir), []);
  });

  it('rejects bad cache options', async function() {
    const pdf = dataUrl(syntheticPdf('bad'));
    let r = await submitJson({ model: MODEL, pdf_dataurl: pdf, cache: 'sometimes' });
    assert.equal(r.status, 400);
    r = await submitJson({ model: MODEL, pdf_dataurl: pdf, cache: 'use' });
    assert.equal(r.status, 400, 'no store configured');
    assert.match(r.body.error, /CHARMD_CACHE_DIR/);
    process.env.CHARMD_CACHE_DIR = cacheDir;
    r = await submitJson({ model: MODEL, pdf_dataurl: pdf, cache: 'use', replay_pace_ms: -1 });
    assert.equal(r.status, 400);
    r = await submitJson({ model: MODEL, pdf_dataurl: pdf, cache: 'use', replay_pace_ms: 'fast' });
    assert.equal(r.status, 400);
  });

  it('cache "use": miss converts and stores, hit completes immediately with the same result', async function() {
    process.env.CHARMD_CACHE_DIR = cacheDir;
    const pdf = syntheticPdf('use');
    const a = await submitJson({ model: MODEL, pdf_dataurl: dataUrl(pdf), cache: 'use' });
    const sa = await waitDone(a.body.job_id, { forStore: true });
    assert.equal(sa.cache.policy, 'use');
    assert.equal(sa.cache.hit, false);
    assert.equal(sa.cache.stored, true);
    assert.match(sa.cache.key, /^[0-9a-f]{64}$/);
    assert.equal(ocrCalls, 3);
    const ra = await result(a.body.job_id);

    // Query-string form of the option.
    const b = await submitJson({ model: MODEL, pdf_dataurl: dataUrl(pdf) }, '?cache=use');
    const sb = await status(b.body.job_id);
    const sbDone = sb.status === 'complete' ? sb : await waitDone(b.body.job_id);
    assert.equal(sbDone.cache.hit, true);
    assert.equal(sbDone.cache.key, sa.cache.key);
    assert.equal(sbDone.pages_total, 3);
    assert.equal(sbDone.pages_converted, 3);
    assert.equal(ocrCalls, 3, 'hit did no conversion work');
    assert.deepEqual(await result(b.body.job_id), ra);

    // A different model is a different key.
    const c = await submitJson({ model: 'test-policy-conversion-image-content-filter', pdf_dataurl: dataUrl(pdf), cache: 'use' });
    const sc = await waitDone(c.body.job_id);
    assert.equal(sc.cache.hit, false);
    assert.notEqual(sc.cache.key, sa.cache.key);
  });

  it('CHARMD_CACHE=on makes "use" the default; "off" and "refresh" override it', async function() {
    process.env.CHARMD_CACHE_DIR = cacheDir;
    process.env.CHARMD_CACHE = 'on';
    const pdf = dataUrl(syntheticPdf('env'));
    await waitDone((await submitJson({ model: MODEL, pdf_dataurl: pdf })).body.job_id, { forStore: true });
    assert.equal(ocrCalls, 3);
    const hit = await waitDone((await submitJson({ model: MODEL, pdf_dataurl: pdf })).body.job_id);
    assert.equal(hit.cache.hit, true);
    assert.equal(ocrCalls, 3);

    const off = await waitDone((await submitJson({ model: MODEL, pdf_dataurl: pdf, cache: 'off' })).body.job_id);
    assert.equal(off.cache, undefined);
    assert.equal(ocrCalls, 6);

    const refresh = await waitDone((await submitJson({ model: MODEL, pdf_dataurl: pdf, cache: 'refresh' })).body.job_id, { forStore: true });
    assert.equal(refresh.cache.hit, false);
    assert.equal(refresh.cache.stored, true);
    assert.equal(ocrCalls, 9);
  });

  it('a hit carries the new request\'s filename (multipart field form)', async function() {
    process.env.CHARMD_CACHE_DIR = cacheDir;
    const pdf = syntheticPdf('names');
    const a = await submitMultipart(pdf, 'first-fax.pdf', { model: MODEL, cache: 'use' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    await waitDone(a.body.job_id, { forStore: true });
    const b = await submitMultipart(pdf, 'second-fax.pdf', { model: MODEL, cache: 'use' });
    const sb = await waitDone(b.body.job_id);
    assert.equal(sb.cache.hit, true);
    const doc = await result(b.body.job_id);
    assert.equal(doc.metadata.originating_filename, 'second-fax.pdf');
    for (const page of doc.chunks.pages) {
      assert.equal(page.metadata.originating_filename, 'second-fax.pdf');
      assert.ok(!page.content.includes('first-fax.pdf'));
    }
    assert.ok(!doc.content.includes('first-fax.pdf'));
  });

  it('replay_pace_ms reveals cached pages progressively, then completes', async function() {
    process.env.CHARMD_CACHE_DIR = cacheDir;
    const pdf = dataUrl(syntheticPdf('replay'));
    const a = await submitJson({ model: MODEL, pdf_dataurl: pdf, cache: 'use' });
    await waitDone(a.body.job_id, { forStore: true });
    const full = await result(a.body.job_id);

    const pace = 120;
    const t0 = Date.now();
    const b = await submitJson({ model: MODEL, pdf_dataurl: pdf, cache: 'use', replay_pace_ms: pace });
    await sleep(20);
    const s0 = await status(b.body.job_id);
    assert.equal(s0.status, 'processing');
    assert.equal(s0.pages_total, 3);
    assert.equal(s0.cache.hit, true);
    assert.equal(s0.replay_pace_ms, pace);
    assert.equal((await fetch(`${base}/${b.body.job_id}/result`)).status, 202);

    const seen = [];
    const counts = new Set();
    let after = 0;
    for (;;) {
      const p = await (await fetch(`${base}/${b.body.job_id}/pages?after=${after}`)).json();
      counts.add(p.pages_converted);
      for (const page of p.pages) seen.push({ n: page.metadata.page_number, t: Date.now() - t0 });
      after = p.next_after;
      if (p.status === 'complete' && after >= p.pages_total) break;
      await sleep(15);
    }
    assert.deepEqual(seen.map(x => x.n), [1, 2, 3]);
    assert.ok(counts.has(1) || counts.has(2), 'saw an intermediate page count');
    assert.ok(seen[2].t >= 3 * pace - 30, `finished too fast: ${seen[2].t}ms`);
    assert.equal(ocrCalls, 3, 'replay did no conversion work');
    assert.deepEqual(await result(b.body.job_id), full);
  });

  it('pages endpoint reports live progress for an uncached job', async function() {
    ocrDelayMs = 80;
    const a = await submitJson({ model: MODEL, pdf_dataurl: dataUrl(syntheticPdf('live')) });
    const partials = [];
    let after = 0;
    let all = [];
    for (;;) {
      const r = await fetch(`${base}/${a.body.job_id}/pages?after=${after}`);
      assert.equal(r.status, 200);
      const p = await r.json();
      if (p.status !== 'complete') partials.push(p.pages_converted);
      all = all.concat(p.pages);
      after = p.next_after;
      if (p.status === 'complete' && after >= p.pages_total) break;
      await sleep(20);
    }
    assert.deepEqual(all.map(pg => pg.metadata.page_number), [1, 2, 3]);
    assert.ok(partials.some(n => n > 0 && n < 3), `no partial progress observed: ${partials}`);
    const doc = await result(a.body.job_id);
    assert.deepEqual(all, doc.chunks.pages);

    const lim = await (await fetch(`${base}/${a.body.job_id}/pages?after=1&limit=1`)).json();
    assert.deepEqual(lim.pages.map(pg => pg.metadata.page_number), [2]);
    assert.equal(lim.next_after, 2);
    assert.equal((await fetch(`${base}/${a.body.job_id}/pages?after=-1`)).status, 400);
    assert.equal((await fetch(`${base}/no-such-job/pages`)).status, 404);
  });

  it('cache paths never log document content', async function() {
    process.env.CHARMD_CACHE_DIR = cacheDir;
    const chunks = [];
    const out = process.stdout.write;
    const err = process.stderr.write;
    process.stdout.write = function(c, ...r) { chunks.push(String(c)); return out.call(process.stdout, c, ...r); };
    process.stderr.write = function(c, ...r) { chunks.push(String(c)); return err.call(process.stderr, c, ...r); };
    try {
      const pdf = dataUrl(syntheticPdf(`log ${SENTINEL}`));
      await waitDone((await submitJson({ model: MODEL, pdf_dataurl: pdf, cache: 'use', description: SENTINEL })).body.job_id, { forStore: true });
      await waitDone((await submitJson({ model: MODEL, pdf_dataurl: pdf, cache: 'use', description: SENTINEL, replay_pace_ms: 5 })).body.job_id);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    const text = chunks.join('');
    assert.match(text, /cache hit/);
    assert.ok(!text.includes(SENTINEL));
  });
});

describe('result-cache unit', function() {
  it('normalizes equivalent options to the same key and separates real differences', function() {
    const buf = Buffer.from('synthetic');
    const a = normalizeConversionOptions({ fileMimetype: 'application/pdf', ocr_threshold: '0.70', page_numbering: 'true', describe: true });
    const b = normalizeConversionOptions({ fileMimetype: 'application/pdf', ocr_threshold: 0.7, page_numbering: true });
    assert.deepEqual(a, b);
    const k = computeCacheKey({ fileBuffer: buf, options: a, model: 'm1' });
    assert.equal(k, computeCacheKey({ fileBuffer: buf, options: b, model: 'm1' }));
    assert.notEqual(k, computeCacheKey({ fileBuffer: buf, options: a, model: 'm2' }));
    assert.notEqual(k, computeCacheKey({ fileBuffer: Buffer.from('synthetiC'), options: a, model: 'm1' }));
    assert.notEqual(k, computeCacheKey({ fileBuffer: buf, options: { ...a, description: 'x' }, model: 'm1' }));
  });

  it('resolves request policies', function() {
    const saved = process.env.CHARMD_CACHE;
    try {
      delete process.env.CHARMD_CACHE;
      assert.deepEqual(resolveCachePolicy(undefined), { policy: 'off', explicit: false });
      process.env.CHARMD_CACHE = 'on';
      assert.deepEqual(resolveCachePolicy(''), { policy: 'use', explicit: false });
      assert.deepEqual(resolveCachePolicy('Refresh'), { policy: 'refresh', explicit: true });
      assert.ok(resolveCachePolicy('maybe').error);
    } finally {
      if (saved === undefined) delete process.env.CHARMD_CACHE;
      else process.env.CHARMD_CACHE = saved;
    }
  });

  it('parses S3 URIs', function() {
    assert.deepEqual(parseS3Uri('s3://bucket/a/b'), { bucket: 'bucket', prefix: 'a/b/' });
    assert.deepEqual(parseS3Uri('s3://bucket'), { bucket: 'bucket', prefix: '' });
    assert.throws(() => parseS3Uri('https://bucket/x'));
  });

  it('S3 store speaks Get/Put/ListObjectsV2 (mock client, no network)', async function() {
    const objects = new Map();
    const sent = [];
    class GetObjectCommand { constructor(input) { this.input = input; } }
    class PutObjectCommand { constructor(input) { this.input = input; } }
    class ListObjectsV2Command { constructor(input) { this.input = input; } }
    const client = {
      async send(cmd) {
        sent.push(cmd);
        if (cmd instanceof GetObjectCommand) {
          if (!objects.has(cmd.input.Key)) {
            const e = new Error('missing'); e.name = 'NoSuchKey'; throw e;
          }
          return { Body: { transformToString: async () => objects.get(cmd.input.Key) } };
        }
        if (cmd instanceof PutObjectCommand) { objects.set(cmd.input.Key, cmd.input.Body); return {}; }
        return { KeyCount: 0 };
      }
    };
    const store = new S3CacheStore('s3://example-bucket/charmd/cache', {
      client, commands: { GetObjectCommand, PutObjectCommand, ListObjectsV2Command }, sse: 'aws:kms'
    });
    const key = 'a'.repeat(64);
    assert.equal(await store.get(key), null);
    await store.put(key, { format: 'x', result: { id: 1 } });
    assert.deepEqual(await store.get(key), { format: 'x', result: { id: 1 } });
    await store.ping();
    const put = sent.find(c => c instanceof PutObjectCommand).input;
    assert.equal(put.Bucket, 'example-bucket');
    assert.equal(put.Key, `charmd/cache/${key}.json`);
    assert.equal(put.ServerSideEncryption, 'aws:kms');
    assert.ok(sent.some(c => c instanceof ListObjectsV2Command));
    await assert.rejects(store.get('../etc/passwd'), /invalid cache key/);
  });

  it('filesystem store round-trips and reports readiness', async function() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charmd-fs-store-'));
    const saved = { d: process.env.CHARMD_CACHE_DIR, s: process.env.CHARMD_CACHE_S3_URI, c: process.env.CHARMD_CACHE };
    try {
      const store = new FsCacheStore(dir);
      const key = 'b'.repeat(64);
      assert.equal(await store.get(key), null);
      await store.put(key, { ok: true });
      assert.deepEqual(await store.get(key), { ok: true });

      delete process.env.CHARMD_CACHE_S3_URI;
      delete process.env.CHARMD_CACHE_DIR;
      delete process.env.CHARMD_CACHE;
      assert.deepEqual(await checkCacheReadiness(), { ok: true, configured: false });
      process.env.CHARMD_CACHE = 'on';
      assert.equal((await checkCacheReadiness()).ok, false);
      process.env.CHARMD_CACHE_DIR = dir;
      const r = await checkCacheReadiness();
      assert.equal(r.ok, true);
      assert.equal(r.backend, 'fs');
    } finally {
      for (const [k, v] of [['CHARMD_CACHE_DIR', saved.d], ['CHARMD_CACHE_S3_URI', saved.s], ['CHARMD_CACHE', saved.c]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
