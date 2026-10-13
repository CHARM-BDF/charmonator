// file: lib/local-only.mjs
//
// The `local_only` model-config guard: a model marked `"local_only": true` may only
// talk to an endpoint whose host resolves to a loopback or private address, so that
// nothing a request carries (page images, transcripts) can leave the machine or the
// private network. `"local_only": "loopback"` is stricter: loopback addresses only.
//
// Checked (a) at server start, which refuses to start on a violation, (b) before
// every call the provider makes, and (c) by GET /readyz. Models without `local_only`
// are never checked, which is main's behaviour.
//
// The check resolves the hostname with the system resolver and requires *every*
// returned address to qualify. It cannot see an HTTP proxy or a server that itself
// forwards requests elsewhere (e.g. a LiteLLM-style gateway on localhost); it guards
// against misconfiguration, not against a hostile local server.

import dns from 'dns/promises';
import net from 'net';
import { interpolateEnvVars } from './config.mjs';

export class LocalOnlyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalOnlyViolation';
    this.status = 403; // not retryable (see openai_fetch.isRetryable)
  }
}

function ipv4ToInt(addr) {
  return addr.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0);
}

function inV4Cidr(addr, base, bits) {
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return ((ipv4ToInt(addr) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

/**
 * Classify an IP address literal: 'loopback', 'private' or 'public'.
 * 'private' covers RFC 1918, link-local, CGNAT (100.64/10, used by Tailscale)
 * and IPv6 unique-local/link-local.
 */
export function classifyAddress(addr) {
  let a = String(addr || '').trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const v4mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) a = v4mapped[1];

  if (net.isIPv4(a)) {
    if (inV4Cidr(a, '127.0.0.0', 8)) return 'loopback';
    if (inV4Cidr(a, '10.0.0.0', 8)
      || inV4Cidr(a, '172.16.0.0', 12)
      || inV4Cidr(a, '192.168.0.0', 16)
      || inV4Cidr(a, '169.254.0.0', 16)
      || inV4Cidr(a, '100.64.0.0', 10)) return 'private';
    return 'public';
  }
  if (net.isIPv6(a)) {
    const lower = a.toLowerCase();
    if (lower === '::1') return 'loopback';
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return 'private';       // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return 'private';       // fe80::/10
    return 'public';
  }
  return 'public';
}

/** Normalize a model config's `local_only` to null | 'private' | 'loopback'. */
export function localOnlyMode(modelConfig) {
  const v = modelConfig?.local_only;
  if (v === true || v === 'true' || v === 'private') return 'private';
  if (v === 'loopback') return 'loopback';
  return null;
}

/** The URL a model config sends requests to, or null if it has none. */
export function endpointOfModelConfig(modelConfig) {
  switch (modelConfig?.api) {
    case 'ollama':
      return interpolateEnvVars(modelConfig.host) || 'http://127.0.0.1:11434';
    case 'OpenAI_Compatible':
      return interpolateEnvVars(modelConfig.base_url) || null;
    case 'TestPolicy':
      return 'http://127.0.0.1/';  // in-process; never leaves the machine
    default:
      // Cloud APIs (OpenAI, Azure, Anthropic, Bedrock, Google) have no local endpoint.
      return null;
  }
}

/**
 * Resolve the endpoint and check every address. Returns
 *   { ok: true, host, addresses } or { ok: false, host, reason }.
 * `lookup` is injectable for tests.
 */
export async function checkLocalEndpoint(url, mode = 'private', { lookup = dns.lookup } = {}) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, host: null, reason: 'endpoint is not a valid URL' };
  }
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;

  let addresses;
  if (net.isIP(bare)) {
    addresses = [bare];
  } else {
    try {
      const results = await lookup(bare, { all: true, verbatim: true });
      addresses = results.map(r => r.address);
    } catch (err) {
      return { ok: false, host, reason: `could not resolve host (${err?.code || err?.name || 'error'})` };
    }
  }
  if (addresses.length === 0) {
    return { ok: false, host, reason: 'host resolved to no addresses' };
  }
  const allowed = mode === 'loopback' ? ['loopback'] : ['loopback', 'private'];
  const bad = addresses.filter(a => !allowed.includes(classifyAddress(a)));
  if (bad.length > 0) {
    return {
      ok: false,
      host,
      reason: `host resolves to a non-${mode === 'loopback' ? 'loopback' : 'local'} address (${bad.join(', ')})`
    };
  }
  return { ok: true, host, addresses };
}

/**
 * Check one model config. Returns null when the model is not local_only.
 */
export async function checkModelLocalOnly(modelConfig, opts = {}) {
  const mode = localOnlyMode(modelConfig);
  if (!mode) return null;
  const url = endpointOfModelConfig(modelConfig);
  if (!url) {
    return { ok: false, mode, host: null, reason: `api "${modelConfig.api}" has no local endpoint` };
  }
  return { mode, ...(await checkLocalEndpoint(url, mode, opts)) };
}

/** Throw a LocalOnlyViolation if a local_only model's endpoint is not local. */
export async function assertModelLocalOnly(modelConfig, modelName = modelConfig?.model, opts = {}) {
  const r = await checkModelLocalOnly(modelConfig, opts);
  if (r && !r.ok) {
    throw new LocalOnlyViolation(`local_only model "${modelName}" refused: ${r.reason}`);
  }
  return r;
}

/**
 * Check every local_only model in a config. Returns { ok, models: {name: result} }
 * with an entry only for models that set local_only.
 */
export async function checkConfigLocalOnly(config, opts = {}) {
  const models = {};
  let ok = true;
  for (const [name, mc] of Object.entries(config?.models || {})) {
    if (!mc || typeof mc !== 'object') continue;
    const r = await checkModelLocalOnly(mc, opts);
    if (r) {
      models[name] = r.ok
        ? { ok: true, mode: r.mode }
        : { ok: false, mode: r.mode, reason: r.reason };
      ok = ok && r.ok;
    }
  }
  return { ok, models };
}

/**
 * Under local_only, an image the model server would have to fetch over the network
 * defeats the guard (LM Studio, llama.cpp and vLLM can all fetch http(s) image URLs).
 * Only data: URLs are allowed.
 */
export function assertLocalImageUrl(url, modelName) {
  if (typeof url === 'string' && url.startsWith('data:')) return;
  throw new LocalOnlyViolation(
    `local_only model "${modelName}" refused: images must be data: URLs, not remote URLs`
  );
}
