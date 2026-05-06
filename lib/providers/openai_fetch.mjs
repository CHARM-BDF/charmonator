
/**
 * Decide whether an error is retryable.
 * - 429 (rate limit)
 * - 408 (request timeout)
 * - 5xx (server errors)
 * - network/transport errors (no status)
 */
function isRetryable(err) {
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return false;
  const status = err?.status;
  if (status === 429 || status === 408) return true;
  if (typeof status === "number" && status >= 500) return true;
  // If it's a fetch/transport error, the SDK often sets cause/message but no status
  if (!status) return true;
  return false;
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('Request aborted');
}

async function sleepWithAbort(ms, signal) {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  if (signal.aborted) {
    throw abortError(signal);
  }

  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };

    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Get a concise payload/body to log from an SDK error.
 * OpenAI API errors typically look like:
 *   { error: { message, type, param, code } }
 * The SDK also sets `message`, `status`, and sometimes `request_id`.
 */
function extractErrorPayload(err) {
  // Prefer the raw API error object if available
  const apiErr = err?.error ?? err?.response?.error;
  if (apiErr) {
    // Avoid dumping huge objects; keep it readable
    const { message, type, code, param } = apiErr;
    return { message, type, code, param };
  }
  // Fallback to the thrown message
  return { message: err?.message ?? String(err) };
}

/**
 * Exponential backoff with jitter (in ms).
 */
function backoffMs(attempt, { base = 250, cap = 8000 } = {}) {
  const exp = Math.min(cap, base * 2 ** attempt);
  // Full jitter
  return Math.floor(Math.random() * exp);
}

/**
 * Run a request with manual retries and detailed logging.
 * `doRequest` should be a function that performs one SDK call.
 */
export async function withRetryLogging(doRequest, { maxAttempts = 5, abortSignal = null } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (abortSignal?.aborted) {
      throw abortError(abortSignal);
    }
    try {
      if (attempt > 1) {
        console.log(`[retry] attempt ${attempt}/${maxAttempts}`);
      }
      const result = await doRequest();
      if (attempt > 1) {
        console.log(`[retry] succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (err) {
      lastErr = err;

      const status = err?.status ?? "(no status)";
      const payload = extractErrorPayload(err);

      console.error(
        `[retry] attempt ${attempt} failed — status: ${status} — payload: ${JSON.stringify(
          payload
        )}`
      );

      if (attempt >= maxAttempts || !isRetryable(err)) {
        // No more retries or not retryable: rethrow
        throw err;
      }

      const delay = backoffMs(attempt - 1); // attempt 1 -> backoff for index 0
      await sleepWithAbort(delay, abortSignal);
    }
  }
  // Shouldn't reach here, but just in case
  throw lastErr;
}


