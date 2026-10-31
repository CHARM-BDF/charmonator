// file: lib/result-cache.mjs
//
// Content-addressed result cache for charmonizer document-conversion jobs.
//
//   key = sha256 over (format tag, file bytes, normalized conversion options, model name)
//
// Two store backends share one interface:
//
//   get(key)        -> entry object, or null on a miss
//   put(key, entry) -> stores the entry (overwrites)
//   delete(key)     -> removes the entry (no error if it is missing)
//   ping()          -> resolves if the store is reachable (used by /readyz)
//   describe()      -> { backend, location } with no secrets
//
// Configuration (environment):
//   CHARMD_CACHE_DIR=/path            filesystem backend (one JSON file per key)
//   CHARMD_CACHE_S3_URI=s3://bucket/prefix
//                                     S3 backend (AWS SDK v3, default credential chain;
//                                     region from AWS_REGION / profile)
//   CHARMD_CACHE_S3_SSE=aws:kms|AES256   optional ServerSideEncryption on put
//   CHARMD_CACHE_S3_KMS_KEY_ID=...    optional SSE-KMS key id (with aws:kms)
//   CHARMD_CACHE=on                   cache policy "use" for requests that do not say
//
// If both CHARMD_CACHE_S3_URI and CHARMD_CACHE_DIR are set, S3 wins.
//
// Cached entries contain transcriptions, i.e. PHI when the inputs are PHI: the
// directory or bucket must sit inside the same PHI boundary as the service.
// Nothing in this module logs entry content; logs carry key prefixes only.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const CACHE_FORMAT = 'charmd-docconv-v1';
export const CACHE_POLICIES = ['use', 'refresh', 'off'];

// ------------------------------------------------------------------ keys

function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Normalize the options that affect a conversion's output, so that equivalent
 * requests ("true" vs true, "0.70" vs 0.7, missing vs default) share a key.
 * Takes a job record (or anything with the same fields).
 */
export function normalizeConversionOptions(job) {
  const mime = String(job.fileMimetype || '').toLowerCase();
  const kind = mime.includes('pdf') ? 'pdf'
    : mime.includes('officedocument.wordprocessingml.document') ? 'docx'
    : mime;
  const str = v => (v == null || v === '' ? null : String(v));
  const bool = v => String(v).toLowerCase() === 'true';
  return {
    kind,
    ocr_threshold: Number.parseFloat(job.ocr_threshold ?? 0.7),
    scrutinize: str(job.scrutinize) ?? 'none',
    page_numbering: typeof job.page_numbering === 'boolean' ? job.page_numbering : bool(job.page_numbering ?? 'true'),
    description: str(job.description),
    intent: str(job.intent),
    graphic_instructions: str(job.graphic_instructions),
    detect_document_boundaries: typeof job.detect_document_boundaries === 'boolean'
      ? job.detect_document_boundaries : bool(job.detect_document_boundaries ?? 'false'),
    describe: typeof job.describe === 'boolean' ? job.describe : bool(job.describe ?? 'true'),
    tags: job.tags == null || job.tags === '' ? null : parseMaybeJson(job.tags),
    continue_on_failure: typeof job.continue_on_failure === 'boolean'
      ? job.continue_on_failure : bool(job.continue_on_failure ?? 'false')
  };
}

/**
 * sha256 over (format tag, file bytes, normalized options, model name), each
 * length-prefixed so field boundaries cannot be confused.
 */
export function computeCacheKey({ fileBuffer, options, model }) {
  const h = crypto.createHash('sha256');
  const part = buf => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(b.length));
    h.update(len);
    h.update(b);
  };
  part(CACHE_FORMAT);
  part(fileBuffer);
  part(canonicalJson(options));
  part(model == null ? '' : String(model));
  return h.digest('hex');
}

// ------------------------------------------------------------------ backends

const KEY_RE = /^[0-9a-f]{64}$/;

function assertKey(key) {
  if (!KEY_RE.test(key)) throw new Error('invalid cache key');
}

export class FsCacheStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  describe() {
    return { backend: 'fs', location: this.dir };
  }

  _path(key) {
    assertKey(key);
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  async get(key) {
    try {
      const text = await fs.promises.readFile(this._path(key), 'utf8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(key, entry) {
    const file = this._path(key);
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
    await fs.promises.rename(tmp, file);
  }

  async delete(key) {
    await fs.promises.rm(this._path(key), { force: true });
  }

  async ping() {
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.promises.access(this.dir, fs.constants.R_OK | fs.constants.W_OK);
  }
}

export function parseS3Uri(uri) {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(String(uri || '').trim());
  if (!m || !m[1]) throw new Error('CHARMD_CACHE_S3_URI must look like s3://bucket/prefix');
  let prefix = m[2] || '';
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return { bucket: m[1], prefix };
}

async function streamToString(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (typeof body.transformToString === 'function') return body.transformToString('utf8');
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

export class S3CacheStore {
  /**
   * @param {string} uri s3://bucket/prefix
   * @param {object} [opts]
   * @param {object} [opts.client] an S3Client-compatible object with send(command) (tests)
   * @param {object} [opts.commands] { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } (tests)
   * @param {string} [opts.sse] ServerSideEncryption value for puts
   * @param {string} [opts.kmsKeyId] SSEKMSKeyId for puts
   */
  constructor(uri, opts = {}) {
    const { bucket, prefix } = parseS3Uri(uri);
    this.bucket = bucket;
    this.prefix = prefix;
    this._client = opts.client || null;
    this._commands = opts.commands || null;
    this.sse = opts.sse || null;
    this.kmsKeyId = opts.kmsKeyId || null;
  }

  describe() {
    return { backend: 's3', location: `s3://${this.bucket}/${this.prefix}` };
  }

  async _sdk() {
    if (!this._commands || !this._client) {
      const sdk = await import('@aws-sdk/client-s3');
      this._commands = this._commands || sdk;
      this._client = this._client || new sdk.S3Client({});
    }
    return { client: this._client, cmd: this._commands };
  }

  _objectKey(key) {
    assertKey(key);
    return `${this.prefix}${key}.json`;
  }

  async get(key) {
    const { client, cmd } = await this._sdk();
    try {
      const out = await client.send(new cmd.GetObjectCommand({ Bucket: this.bucket, Key: this._objectKey(key) }));
      return JSON.parse(await streamToString(out.Body));
    } catch (err) {
      const status = err?.$metadata?.httpStatusCode;
      if (err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey' || status === 404) return null;
      throw err;
    }
  }

  async put(key, entry) {
    const { client, cmd } = await this._sdk();
    const input = {
      Bucket: this.bucket,
      Key: this._objectKey(key),
      Body: JSON.stringify(entry),
      ContentType: 'application/json'
    };
    if (this.sse) input.ServerSideEncryption = this.sse;
    if (this.kmsKeyId) input.SSEKMSKeyId = this.kmsKeyId;
    await client.send(new cmd.PutObjectCommand(input));
  }

  async delete(key) {
    const { client, cmd } = await this._sdk();
    await client.send(new cmd.DeleteObjectCommand({ Bucket: this.bucket, Key: this._objectKey(key) }));
  }

  async ping() {
    const { client, cmd } = await this._sdk();
    await client.send(new cmd.ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, MaxKeys: 1 }));
  }
}

// ------------------------------------------------------------------ selection

let memo = { signature: null, store: null };
let testOverride = null;

/** Tests only: force a store (or null to clear the override). */
export function setCacheStoreForTesting(store) {
  testOverride = store;
}

/** The configured store, or null if neither CHARMD_CACHE_DIR nor CHARMD_CACHE_S3_URI is set. */
export function getCacheStore() {
  if (testOverride) return testOverride;
  const s3 = (process.env.CHARMD_CACHE_S3_URI || '').trim();
  const dir = (process.env.CHARMD_CACHE_DIR || '').trim();
  const sse = (process.env.CHARMD_CACHE_S3_SSE || '').trim();
  const kms = (process.env.CHARMD_CACHE_S3_KMS_KEY_ID || '').trim();
  const signature = JSON.stringify([s3, dir, sse, kms]);
  if (memo.signature !== signature) {
    let store = null;
    if (s3) store = new S3CacheStore(s3, { sse: sse || null, kmsKeyId: kms || null });
    else if (dir) store = new FsCacheStore(dir);
    memo = { signature, store };
  }
  return memo.store;
}

/** Default policy for requests that do not pass `cache`: "use" if CHARMD_CACHE=on, else "off". */
export function defaultCachePolicy() {
  const v = String(process.env.CHARMD_CACHE || '').trim().toLowerCase();
  return (v === 'on' || v === '1' || v === 'true' || v === 'use') ? 'use' : 'off';
}

/**
 * Resolve the effective policy from a request value (body field or query).
 * Returns { policy } or { error }.
 */
export function resolveCachePolicy(requested) {
  if (requested === undefined || requested === null || requested === '') {
    return { policy: defaultCachePolicy(), explicit: false };
  }
  const v = String(requested).trim().toLowerCase();
  if (!CACHE_POLICIES.includes(v)) {
    return { error: `cache must be one of ${CACHE_POLICIES.join(', ')}` };
  }
  return { policy: v, explicit: true };
}

/** For /readyz: is a configured store reachable? */
export async function checkCacheReadiness() {
  const store = getCacheStore();
  const enabledByDefault = defaultCachePolicy() === 'use';
  if (!store) {
    if (enabledByDefault) {
      return { ok: false, configured: false, reason: 'CHARMD_CACHE=on but neither CHARMD_CACHE_DIR nor CHARMD_CACHE_S3_URI is set' };
    }
    return { ok: true, configured: false };
  }
  try {
    await store.ping();
    return { ok: true, configured: true, backend: store.describe().backend, enabled_by_default: enabledByDefault };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      backend: store.describe().backend,
      reason: `cache store unreachable: ${err?.name || 'Error'}`
    };
  }
}
