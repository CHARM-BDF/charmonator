// File: lib/retry.mjs
//
// Retry a model call that failed for a transient reason: a dropped
// connection, throttling, or a 429 or 5xx response. Validation failures,
// content-filter refusals and other errors are not retried.

const TRANSIENT_MESSAGE = /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|network|throttl|too many requests|rate limit|overloaded|service unavailable/i;

export function isTransientError(err) {
  if (!err) return false;
  if (err.interpretedErrorType === 'schema_validation_failed' || err.interpretedErrorType === 'content_filter_violation') {
    return false;
  }
  const status = Number(err.status ?? err.statusCode ?? err.interpretedCode ?? err.$metadata?.httpStatusCode);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return TRANSIENT_MESSAGE.test(`${err.name || ''} ${err.message || ''} ${err.cause?.code || ''} ${err.cause?.message || ''}`);
}

/**
 * Run fn(), retrying transient failures up to `attempts` times in all, waiting
 * `baseMs` x 2^k (with jitter) between tries.
 */
export async function withRetries(fn, { attempts = 3, baseMs = 2000, onRetry = null } = {}) {
  for (let k = 0; ; k++) {
    try {
      return await fn();
    } catch (err) {
      if (k + 1 >= attempts || !isTransientError(err)) throw err;
      const wait = Math.round(baseMs * 2 ** k * (0.75 + Math.random() / 2));
      if (onRetry) onRetry(err, k + 1, wait);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}
