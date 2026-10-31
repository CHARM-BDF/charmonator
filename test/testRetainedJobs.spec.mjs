// Retained jobs (lib/retained-jobs.mjs) over the filesystem cache store.
// Snapshots are synthetic; no server, no models.

import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FsCacheStore } from '../lib/result-cache.mjs';
import { createRetainedJobs, parseRetention, maxRetentionMs } from '../lib/retained-jobs.mjs';

const H = 3600e3;

describe('retained jobs', function () {
  let dir, store, clock;
  const make = app => createRetainedJobs(app, { store: () => store, now: () => clock });

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charmd-retain-'));
    store = new FsCacheStore(dir);
    clock = Date.parse('2026-10-30T12:00:00Z');
  });
  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses retention durations', function () {
    assert.deepEqual(parseRetention(''), { ms: null });
    assert.deepEqual(parseRetention('off'), { ms: null });
    assert.deepEqual(parseRetention('0'), { ms: null });
    assert.equal(parseRetention('90m').ms, 90 * 60e3);
    assert.equal(parseRetention('12h').ms, 12 * H);
    assert.equal(parseRetention('7d').ms, 7 * 24 * H);
    assert.equal(parseRetention('2w').ms, 14 * 24 * H);
    assert.equal(parseRetention('3600').ms, H);
    assert.ok(parseRetention('soon').error);
    assert.ok(parseRetention('31d').error, 'longer than the default maximum');
    assert.equal(parseRetention('31d', 40 * 24 * H).ms, 31 * 24 * H);
    assert.equal(maxRetentionMs(), 30 * 24 * H);
  });

  it('saves, loads and lists a job until it expires', async function () {
    const r = make('app-a');
    const { expires_at } = await r.save('job-1', { tables: { t: [1, 2] } },
      { retainMs: 2 * H, lookup: { research_id: 'SYN-1' }, summary: { pages: 3 } });
    assert.equal(expires_at, '2026-10-30T14:00:00.000Z');

    const got = await r.load('job-1');
    assert.deepEqual(got.snapshot, { tables: { t: [1, 2] } });
    assert.deepEqual((await r.list('research_id', 'SYN-1')).map(i => [i.id, i.summary.pages]), [['job-1', 3]]);

    clock += 3 * H;
    assert.equal(await r.load('job-1'), null);
    assert.deepEqual(await r.list('research_id', 'SYN-1'), []);
    const left = fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.json'));
    assert.deepEqual(left, [], 'expired job and its index are deleted');
  });

  it('keeps apps apart and lists newest first', async function () {
    const a = make('app-a'), b = make('app-b');
    await a.save('j1', { n: 1 }, { retainMs: H, lookup: { research_id: 'SYN-1' } });
    clock += 1000;
    await a.save('j2', { n: 2 }, { retainMs: H, lookup: { research_id: 'SYN-1' } });
    assert.equal(await b.load('j1'), null);
    assert.deepEqual(await b.list('research_id', 'SYN-1'), []);
    assert.deepEqual((await a.list('research_id', 'SYN-1')).map(i => i.id), ['j2', 'j1']);
  });

  it('drops a job and its index entry', async function () {
    const r = make('app-a');
    await r.save('j1', { n: 1 }, { retainMs: H, lookup: { research_id: 'SYN-1' } });
    await r.save('j2', { n: 2 }, { retainMs: H, lookup: { research_id: 'SYN-1' } });
    assert.equal(await r.drop('j1'), true);
    assert.equal(await r.load('j1'), null);
    assert.deepEqual((await r.list('research_id', 'SYN-1')).map(i => i.id), ['j2']);
    assert.equal(await r.drop('j1'), false);
  });

  it('refuses to save without a store', async function () {
    const r = createRetainedJobs('app-a', { store: () => null });
    assert.equal(r.available(), false);
    await assert.rejects(r.save('j', {}, { retainMs: H }), /CHARMD_CACHE_DIR/);
    assert.equal(await r.load('j'), null);
  });
});
