// file: lib/retained-jobs.mjs
//
// Retained jobs: a finished job kept for a period the caller chooses, so its
// result can be fetched again by job ID (or listed by a lookup key) after the
// in-memory job is gone, including across restarts.
//
// Jobs live in the result cache's store (lib/result-cache.mjs: CHARMD_CACHE_DIR
// or CHARMD_CACHE_S3_URI), so they sit inside the same data boundary as cached
// transcriptions. Without a configured store, retention is unavailable.
//
//   const retained = createRetainedJobs('my-app');
//   await retained.save(id, snapshot, { retainMs, lookup: { research_id: 'X' }, summary: {...} });
//   await retained.load(id)              -> { id, saved_at, expires_at, snapshot } or null
//   await retained.list('research_id', 'X') -> [{ id, saved_at, expires_at, summary }]
//   await retained.drop(id)
//
// The snapshot is whatever the app needs to serve the job again (JSON; base64
// any buffers). Expired jobs are deleted when they are next read or listed.
// Nothing here logs snapshot content.
//
// Configuration (environment):
//   CHARMD_RETAIN_MAX_DAYS   longest retention a request may ask for (default 30)

import crypto from 'crypto';
import { getCacheStore } from './result-cache.mjs';

export const RETAINED_FORMAT = 'charmd-retained-job-v1';
const INDEX_FORMAT = 'charmd-retained-index-v1';
const UNITS = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };

export function maxRetentionMs() {
  const days = Number(process.env.CHARMD_RETAIN_MAX_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 30) * UNITS.d;
}

/**
 * A request's `retain` value as milliseconds: "90m", "12h", "7d", "2w", or a
 * number of seconds. Empty, 0, "0" or "off" mean no retention (null).
 * Returns { ms } or { error }.
 */
export function parseRetention(value, maxMs = maxRetentionMs()) {
  if (value === undefined || value === null || value === '') return { ms: null };
  const v = String(value).trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false') return { ms: null };
  let ms = null;
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(v);
  if (m) ms = Number(m[1]) * UNITS[m[2]];
  else if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  if (!ms || !Number.isFinite(ms)) {
    return { error: 'retain must be a duration such as 12h, 7d or 2w, or a number of seconds' };
  }
  if (ms > maxMs) return { error: `retain may be at most ${Math.round(maxMs / UNITS.d)}d` };
  return { ms: Math.round(ms) };
}

const keyOf = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/**
 * The retained-job store for one app (the name keeps apps' jobs apart).
 * @param {string} app
 * @param {object} [opts]
 * @param {() => object|null} [opts.store] the store getter (tests)
 * @param {() => number} [opts.now]
 */
export function createRetainedJobs(app, opts = {}) {
  const store = opts.store || getCacheStore;
  const now = opts.now || Date.now;
  const jobKey = id => keyOf(RETAINED_FORMAT, app, 'job', String(id));
  const indexKey = (field, value) => keyOf(INDEX_FORMAT, app, field, String(value));
  const expired = entry => Date.parse(entry.expires_at) <= now();

  function requireStore() {
    const s = store();
    if (!s) throw Object.assign(new Error('retain needs a result-cache store (CHARMD_CACHE_DIR or CHARMD_CACHE_S3_URI)'), { status: 400 });
    if (typeof s.delete !== 'function') throw new Error('the result-cache store cannot delete entries');
    return s;
  }

  async function updateIndex(s, field, value, fn) {
    const key = indexKey(field, value);
    const entry = await s.get(key).catch(() => null);
    const items = fn((entry?.format === INDEX_FORMAT ? entry.items : []).filter(i => !(Date.parse(i.expires_at) <= now())));
    if (items.length) await s.put(key, { format: INDEX_FORMAT, items });
    else await s.delete(key).catch(() => {});
    return items;
  }

  return {
    /** Is there a store to retain jobs in? */
    available() {
      const s = store();
      return Boolean(s && typeof s.delete === 'function');
    },

    async save(id, snapshot, { retainMs, lookup = {}, summary = {} } = {}) {
      if (!retainMs || retainMs <= 0) throw new Error('retainMs is required');
      const s = requireStore();
      const saved_at = new Date(now()).toISOString();
      const expires_at = new Date(now() + retainMs).toISOString();
      await s.put(jobKey(id), { format: RETAINED_FORMAT, app, id: String(id), saved_at, expires_at, lookup, snapshot });
      for (const [field, value] of Object.entries(lookup)) {
        if (value === undefined || value === null || value === '') continue;
        await updateIndex(s, field, value, items =>
          [...items.filter(i => i.id !== String(id)), { id: String(id), saved_at, expires_at, summary }]);
      }
      return { saved_at, expires_at };
    },

    async load(id) {
      const s = store();
      if (!s) return null;
      const entry = await s.get(jobKey(id)).catch(() => null);
      if (entry?.format !== RETAINED_FORMAT || entry.app !== app) return null;
      if (expired(entry)) {
        await this.drop(id, entry).catch(() => {});
        return null;
      }
      return { id: entry.id, saved_at: entry.saved_at, expires_at: entry.expires_at, snapshot: entry.snapshot };
    },

    /** Retained jobs whose lookup[field] is value, newest first. */
    async list(field, value) {
      const s = store();
      if (!s) return [];
      const entry = await s.get(indexKey(field, value)).catch(() => null);
      if (entry?.format !== INDEX_FORMAT) return [];
      const live = entry.items.filter(i => !(Date.parse(i.expires_at) <= now()));
      if (live.length !== entry.items.length && typeof s.delete === 'function') {
        await updateIndex(s, field, value, items => items).catch(() => {});
      }
      return live.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
    },

    async drop(id, known = null) {
      const s = store();
      if (!s || typeof s.delete !== 'function') return false;
      const entry = known || await s.get(jobKey(id)).catch(() => null);
      if (entry?.format !== RETAINED_FORMAT || entry.app !== app) return false;
      for (const [field, value] of Object.entries(entry.lookup || {})) {
        await updateIndex(s, field, value, items => items.filter(i => i.id !== String(id))).catch(() => {});
      }
      await s.delete(jobKey(id));
      return true;
    }
  };
}
