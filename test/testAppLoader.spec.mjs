// App loading: createRouter(ctx) for apps outside the charmd tree, the legacy
// default-export router, and discovery on CHARMONATOR_APPS_PATH.

import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import fetch from 'node-fetch';
import { AppRegistry, discoverApps, loadAppsFromConfig } from '../lib/app-loader.mjs';

function writeApp(dir, { config = {}, routes = {} } = {}) {
  fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify(config));
  for (const [name, src] of Object.entries(routes)) {
    fs.writeFileSync(path.join(dir, 'routes', name), src);
  }
}

// Outside the charmd tree, so it cannot import express by bare specifier.
const FACTORY_ROUTE = `
export function createRouter(ctx) {
  const router = ctx.express.Router();
  router.get('/v1/ctx', async (req, res) => {
    const probes = await ctx.importCharmd('lib/log-safety.mjs');
    const multer = (await ctx.importPackage('multer')).default;
    res.json({
      appId: ctx.appId,
      appDir: ctx.appDir,
      name: ctx.appConfig.name,
      hasChatModel: typeof ctx.fetchChatModel === 'function',
      hasGetConfig: typeof ctx.getConfig === 'function',
      importedCharmd: typeof probes === 'object',
      importedPackage: typeof multer === 'function',
    });
  });
  return router;
}
`;

async function serve(registry) {
  const app = express();
  for (const [appId, router] of registry.appRouters) {
    app.use(registry.getApp(appId).config.baseRoute, router);
  }
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, root: `http://127.0.0.1:${server.address().port}` };
}

describe('App loader', function() {
  let tmp;
  beforeEach(function() { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charmd-apps-')); });
  afterEach(function() { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('mounts createRouter(ctx) from an app outside the charmd tree', async function() {
    const dir = path.join(tmp, 'outside');
    writeApp(dir, { config: { name: 'Outside' }, routes: { 'v1.mjs': FACTORY_ROUTE } });
    const registry = new AppRegistry();
    await registry.registerApp('outside', dir, {});
    const { server, root } = await serve(registry);
    try {
      const r = await fetch(`${root}/apps/outside/v1/ctx`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), {
        appId: 'outside', appDir: dir, name: 'Outside',
        hasChatModel: true, hasGetConfig: true, importedCharmd: true, importedPackage: true,
      });
    } finally {
      server.close();
    }
  });

  it('still mounts a default-export router', async function() {
    // Inside the charmd tree, like existing apps, so `express` resolves.
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'test', 'tmp-app-'));
    try {
      writeApp(dir, { routes: { 'main.mjs': `
import express from 'express';
import fetch from 'node-fetch';
const router = express.Router();
router.get('/hello', (req, res) => res.json({ hello: 'legacy' }));
export default router;
` } });
      const registry = new AppRegistry();
      await registry.registerApp('legacy', dir, {});
      const { server, root } = await serve(registry);
      try {
        const r = await fetch(`${root}/apps/legacy/hello`);
        assert.deepEqual(await r.json(), { hello: 'legacy' });
      } finally {
        server.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers apps on CHARMONATOR_APPS_PATH', function() {
    writeApp(path.join(tmp, 'many', 'b'));
    writeApp(path.join(tmp, 'many', 'a'));
    fs.mkdirSync(path.join(tmp, 'many', 'not-an-app'));
    writeApp(path.join(tmp, 'single'));
    const found = discoverApps([path.join(tmp, 'many'), path.join(tmp, 'single')].join(path.delimiter));
    assert.deepEqual(found.map(f => f.appId), ['a', 'b', 'single']);
    assert.equal(found[2].directory, path.join(tmp, 'single'));
  });

  it('loads discovered apps, lets config win, and honours enabled:false in config', async function() {
    for (const id of ['found', 'overridden', 'off']) {
      writeApp(path.join(tmp, 'apps', id), { config: { enabled: true }, routes: { 'v1.mjs': FACTORY_ROUTE } });
    }
    writeApp(path.join(tmp, 'elsewhere'), { config: { name: 'Elsewhere' }, routes: { 'v1.mjs': FACTORY_ROUTE } });
    const registry = new AppRegistry();
    await loadAppsFromConfig({
      apps: {
        overridden: { directory: path.join(tmp, 'elsewhere') },
        off: { directory: path.join(tmp, 'apps', 'off'), enabled: false },
      },
    }, { registry, env: { CHARMONATOR_APPS_PATH: path.join(tmp, 'apps') } });
    assert.deepEqual([...registry.getAllApps().keys()].sort(), ['found', 'overridden']);
    assert.equal(registry.getApp('overridden').directory, path.join(tmp, 'elsewhere'));
  });

  it('ignores a CHARMONATOR_APPS_PATH entry that does not exist', function() {
    assert.deepEqual(discoverApps(path.join(tmp, 'missing')), []);
  });
});
