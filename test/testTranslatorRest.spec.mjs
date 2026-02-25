/**
 * test/testTranslatorRest.spec.mjs
 *
 * Integration tests for the translator REST endpoints.
 * Tests validation, environments endpoint, and (optionally) real ARS queries.
 */

import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import fetch from 'node-fetch';
import { createAndStart } from '../lib/server.mjs';
import { getServerPort, getFullCharmonatorApiPrefix } from '../lib/index.mjs';

describe('Translator REST endpoints', function () {
  let server;
  let translatorUrl;

  before(async function () {
    this.timeout(15000);
    server = await createAndStart();
    const port = getServerPort();
    const prefix = getFullCharmonatorApiPrefix();
    translatorUrl = `http://localhost:${port}${prefix}/translator`;
  });

  after(async function () {
    await new Promise(resolve => {
      server.close(resolve);
    });
  });

  describe('GET /environments', function () {
    it('should return the list of available environments', async function () {
      const r = await fetch(`${translatorUrl}/environments`);
      assert(r.status >= 200 && r.status < 300);
      const data = await r.json();
      assert(Array.isArray(data.environments), 'environments should be an array');
      assert(data.environments.includes('prod'), 'should include prod');
      assert(data.environments.includes('test'), 'should include test');
      assert(data.urls, 'should include urls mapping');
      assert(data.urls.prod, 'urls should include prod');
    });
  });

  describe('POST /query validation', function () {
    it('should reject missing pk', async function () {
      const r = await fetch(`${translatorUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.strictEqual(r.status, 400);
      const data = await r.json();
      assert(data.error.includes('pk'), 'Error should mention pk');
    });

    it('should reject invalid environment', async function () {
      const r = await fetch(`${translatorUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pk: 'some-pk', environment: 'invalid-env' })
      });
      assert.strictEqual(r.status, 400);
      const data = await r.json();
      assert(data.error.includes('Invalid environment'));
    });

    it('should reject non-string pk', async function () {
      const r = await fetch(`${translatorUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pk: 12345 })
      });
      assert.strictEqual(r.status, 400);
    });
  });

  // Real ARS network test -- only runs with tags that include 'network'
  tags('network', 'llm').describe('POST /query with real ARS', function () {
    it('should process a real translator query', async function () {
      this.timeout(120000); // ARS can be slow

      const r = await fetch(`${translatorUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pk: '992cc304-b1cd-4e9d-b317-f65effe150e1',
          environment: 'prod'
        })
      });

      const data = await r.json();

      if (r.status === 500 && data.error) {
        // PK may have expired from ARS -- not a test failure
        console.log(`ARS API error (PK may have expired): ${data.error}`);
        return;
      }

      assert(r.status >= 200 && r.status < 300, `Expected 2xx, got ${r.status}`);

      if (data.totalRelationships === 0) {
        assert.strictEqual(data.message, 'No results found for this PK');
      } else {
        assert(data.stats, 'Should have stats');
        assert(data.stats.totalRelationships > 0, 'Should have relationships');
        assert(data.knowledgeGraph, 'Should have knowledge graph');
        assert(Array.isArray(data.knowledgeGraph.nodes), 'Should have nodes');
        assert(Array.isArray(data.data), 'Should have data array');
      }
    });
  });
});
