// The provenance viewer (docs/provenance-viewer.md) and the pdf.js build it
// loads are served by charmd itself, so the page needs nothing from outside
// the deployment.

import { strict as assert } from 'assert';
import fetch from 'node-fetch';
import { useManagedServerFixture } from './support/managed-server-fixture.mjs';

const __port = Number(process.env.CHARMONATOR_PORT) || 5003;
const root = `http://localhost:${__port}`;

describe('Provenance viewer', function() {
  useManagedServerFixture();

  for (const [path, type] of [
    ['/viewer/provenance.html', /text\/html/],
    ['/viewer/provenance.js', /javascript/],
    ['/viewer/provenance.css', /text\/css/],
    ['/viewer/pdfjs/pdf.min.mjs', /javascript/],
    ['/viewer/pdfjs/pdf.worker.min.mjs', /javascript/]
  ]) {
    it(`serves ${path}`, async function() {
      const res = await fetch(root + path);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), type);
    });
  }

  it('loads pdf.js from charmd, not a CDN', async function() {
    const html = await (await fetch(`${root}/viewer/provenance.html`)).text();
    const js = await (await fetch(`${root}/viewer/provenance.js`)).text();
    assert.doesNotMatch(html + js, /https?:\/\//);
    assert.match(js, /\.\/pdfjs\/pdf\.min\.mjs/);
  });
});
