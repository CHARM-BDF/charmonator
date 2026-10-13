// file: routes/probes.mjs
//
// Container health probes, mounted at the server root (not under baseUrl or
// the API prefixes) and ahead of request logging so probe traffic stays quiet.
//
//   GET /healthz  200 {status:"ok"} while the process is up and serving.
//   GET /readyz   200 when the config is loaded and, if a result cache is
//                 configured (or CHARMD_CACHE=on), the cache store is reachable;
//                 503 with a reason otherwise. When any model sets local_only,
//                 checks.local_only reports each such model, and a model whose
//                 endpoint is not local makes the service not ready.
//
// Neither response contains configuration values, secrets or bucket names.

import express from 'express';
import { getConfig } from '../lib/config.mjs';
import { checkCacheReadiness } from '../lib/result-cache.mjs';
import { checkConfigLocalOnly } from '../lib/local-only.mjs';

const router = express.Router();

router.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime_s: Math.round(process.uptime()) });
});

router.get('/readyz', async (req, res) => {
  const checks = {};
  let ok = true;

  try {
    const cfg = getConfig();
    const numModels = Object.keys(cfg?.models || {}).length;
    checks.config = { ok: true, models: numModels };
  } catch (err) {
    ok = false;
    checks.config = { ok: false, reason: err?.name || 'Error' };
  }

  try {
    checks.cache = await checkCacheReadiness();
    ok = ok && checks.cache.ok;
  } catch (err) {
    ok = false;
    checks.cache = { ok: false, reason: err?.name || 'Error' };
  }

  // Only present when some model sets local_only (so main's response is unchanged).
  try {
    const localOnly = await checkConfigLocalOnly(getConfig());
    if (Object.keys(localOnly.models).length > 0) {
      checks.local_only = localOnly;
      ok = ok && localOnly.ok;
    }
  } catch (err) {
    ok = false;
    checks.local_only = { ok: false, reason: err?.name || 'Error' };
  }

  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks });
});

export default router;
