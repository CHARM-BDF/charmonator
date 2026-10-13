// file: lib/log-safety.mjs
//
// PHI-safe logging helpers.
//
// charmd processes clinical documents. Anything that can carry document or
// conversation content (message arrays, tool lists and arguments, request
// bodies, page text, model replies) must not reach stdout/stderr unless an
// operator has explicitly opted in with:
//
//   CHARMONATOR_DEBUG_TRANSCRIPTS=1
//
// Operational logs (event names, URLs, sizes, counts, timings, model names,
// error classes) are always allowed.

/**
 * True when full content logging has been explicitly enabled.
 * Read on every call so tests (and operators) can toggle it at runtime.
 */
export function debugTranscriptsEnabled() {
  const v = String(process.env.CHARMONATOR_DEBUG_TRANSCRIPTS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** console.log, but only when CHARMONATOR_DEBUG_TRANSCRIPTS is enabled. */
export function logContent(...args) {
  if (debugTranscriptsEnabled()) {
    console.log(...args);
  }
}

/** console.error, but only when CHARMONATOR_DEBUG_TRANSCRIPTS is enabled. */
export function logContentError(...args) {
  if (debugTranscriptsEnabled()) {
    console.error(...args);
  }
}

// Scalar request fields that are configuration, not content, and are safe to log.
const SAFE_SCALAR_KEYS = new Set([
  'model', 'method', 'strategy', 'chunk_size', 'chunk_group', 'ocr_threshold',
  'scrutinize', 'page_numbering', 'detect_document_boundaries', 'describe',
  'continue_on_failure', 'temperature', 'max_output_tokens', 'stream',
  'context_chunks_before', 'context_chunks_after', 'annotation_field',
  'annotation_field_delta', 'merge_mode', 'tokens_budget', 'cache',
  'replay_pace_ms', 'num_schema_repair_max_attempts', 'ms_client_request_timeout',
  'num_client_request_max_attempts', 'num_defective_reply_max_attempts',
  'reasoning_effort'
]);

function sizeOf(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return -1;
  }
}

/**
 * Summarize a request body for logging without its content.
 *
 * With CHARMONATOR_DEBUG_TRANSCRIPTS enabled, the body is returned unchanged.
 * Otherwise each field is replaced by a shape description, e.g.
 *   { model: 'x', transcript: '[object, 12345 chars]', document: '[string, 900 chars]' }
 * Only whitelisted scalar configuration fields (model, method, ...) keep
 * their values, and then only if short.
 */
export function summarizeBody(body) {
  if (debugTranscriptsEnabled()) {
    return body;
  }
  if (body == null || typeof body !== 'object') {
    return body == null ? body : `[${typeof body}, ${sizeOf(body)} chars]`;
  }
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    const isScalar = v == null || ['string', 'number', 'boolean'].includes(typeof v);
    if (SAFE_SCALAR_KEYS.has(k) && isScalar && sizeOf(v) <= 200) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = `[array(${v.length}), ${sizeOf(v)} chars]`;
    } else {
      out[k] = `[${typeof v}, ${sizeOf(v)} chars]`;
    }
  }
  return out;
}

/** Size-only description of a content value, for operational logs. */
export function describeSize(value) {
  return { chars: sizeOf(value) };
}
