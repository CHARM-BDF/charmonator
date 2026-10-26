// lib/locate.mjs with a stub vision model: boxes come back as fractions of
// the page, missing quotes are reported, the image is resized first, and a
// cached answer is reused.

import { strict as assert } from 'assert';
import { Jimp } from 'jimp';
import { locateQuotes } from '../lib/locate.mjs';
import { Message, TranscriptFragment } from '../lib/transcript.mjs';
import { setCacheStoreForTesting } from '../lib/result-cache.mjs';

async function page(width, height) {
  return new Jimp({ width, height, color: 0xffffffff }).getBuffer('image/png');
}

function stub(reply) {
  const calls = [];
  const factory = () => ({
    async extendTranscript(prefix) {
      const content = prefix.messages[prefix.messages.length - 1].content;
      calls.push(content);
      return new TranscriptFragment([new Message('assistant', JSON.stringify(reply(content)))]);
    }
  });
  return { factory, calls };
}

describe('locateQuotes', function () {
  it('returns boxes as fractions of the resized page, and reports quotes it cannot find', async function () {
    const image = await page(2400, 3000);   // resized to 1200 x 1500
    const { factory, calls } = stub(() => ({ boxes: [
      { i: 1, found: true, x0: 600, y0: 300, x1: 120, y1: 330 },   // corners in either order
      { i: 2, found: false, x0: null, y0: null, x1: null, y1: null }
    ] }));
    const out = await locateQuotes({ image, quotes: ['Near-total resection', 'not on this page', 'Near-total resection'], chatModelFactory: factory });
    assert.deepEqual(out.boxes, [
      { quote: 'Near-total resection', found: true, box: [0.1, 0.2, 0.5, 0.22] },
      { quote: 'not on this page', found: false, box: null }
    ]);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /This page image is 1200 x 1500 pixels/);
  });

  it('makes no call without quotes, and checks its arguments', async function () {
    const { factory, calls } = stub(() => ({ boxes: [] }));
    assert.deepEqual(await locateQuotes({ image: await page(100, 100), quotes: [' '], chatModelFactory: factory }),
      { boxes: [], cached: false });
    assert.equal(calls.length, 0);
    await assert.rejects(locateQuotes({ image: Buffer.alloc(0), quotes: ['x'], chatModelFactory: factory }), /image/);
    await assert.rejects(locateQuotes({ image: await page(10, 10), quotes: ['x'] }), /model is required/);
  });

  it('reuses a cached answer for the same model, page and quotes', async function () {
    const entries = new Map();
    setCacheStoreForTesting({ async get(k) { return entries.get(k) ?? null; }, async put(k, v) { entries.set(k, v); } });
    try {
      const image = await page(1200, 1500);
      const { factory, calls } = stub(() => ({ boxes: [{ i: 1, found: true, x0: 0, y0: 0, x1: 600, y1: 150 }] }));
      const args = { image, quotes: ['a quote'], model: 'stub', chatModelFactory: factory, cache: 'use' };
      const first = await locateQuotes(args);
      const second = await locateQuotes(args);
      assert.equal(calls.length, 1);
      assert.equal(first.cached, false);
      assert.equal(second.cached, true);
      assert.deepEqual(second.boxes, first.boxes);
    } finally {
      setCacheStoreForTesting(null);
    }
  });
});
