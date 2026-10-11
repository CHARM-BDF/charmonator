// GET /healthz and GET /readyz, and CHARMONATOR_CONFIG_JSON.

import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import fetch from 'node-fetch';
import { useManagedServerFixture } from './support/managed-server-fixture.mjs';

const __port = Number(process.env.CHARMONATOR_PORT) || 5003;
const root = `http://localhost:${__port}`;

describe('Container probes', function() {
  this.timeout(10000);
  useManagedServerFixture();

  const saved = {};
  beforeEach(function() {
    for (const k of ['CHARMD_CACHE', 'CHARMD_CACHE_DIR', 'CHARMD_CACHE_S3_URI']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(function() {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('GET /healthz answers 200 at the server root', async function() {
    const r = await fetch(`${root}/healthz`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, 'ok');
  });

  it('GET /readyz is ready with no cache configured', async function() {
    const r = await fetch(`${root}/readyz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'ready');
    assert.equal(j.checks.config.ok, true);
    assert.deepEqual(j.checks.cache, { ok: true, configured: false });
  });

  it('GET /readyz is not ready when CHARMD_CACHE=on has no store, ready once a store is reachable', async function() {
    process.env.CHARMD_CACHE = 'on';
    let r = await fetch(`${root}/readyz`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).checks.cache.ok, false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charmd-readyz-'));
    try {
      process.env.CHARMD_CACHE_DIR = dir;
      r = await fetch(`${root}/readyz`);
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.checks.cache.backend, 'fs');
      assert.ok(!JSON.stringify(j).includes(dir), 'readyz must not reveal paths');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CHARMONATOR_CONFIG_JSON', function() {
  it('supplies the whole config from the environment', function() {
    const cfg = { server: { port: 1 }, models: { m: { api: 'TestPolicy', model_type: 'chat' } } };
    const out = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const { getConfig } = await import('./lib/config.mjs'); const c = getConfig(); " +
      "console.log(JSON.stringify({ models: Object.keys(c.models), t: c.models.m.ms_client_request_timeout }));"
    ], {
      env: { ...process.env, CHARMONATOR_CONFIG: '/nonexistent.json', CHARMONATOR_CONFIG_JSON: JSON.stringify(cfg) },
      encoding: 'utf8'
    });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim()), { models: ['m'], t: 600000 });
  });
});
