// parsePdfWithRetry: hands pdf-parse an owned Uint8Array (the pooled-Buffer defect in
// pdf.js 1.10; see lib/pdf-parse-retry.mjs) and retries the known symptoms as a backstop.

import { strict as assert } from 'assert';
import fs from 'fs';
import pdfParse from 'pdf-parse';
import { parsePdfWithRetry, MAX_ATTEMPTS } from '../lib/pdf-parse-retry.mjs';

function scripted(outcomes) {
  const calls = [];
  const parse = async (buf) => {
    calls.push(buf);
    const o = outcomes.shift();
    if (o instanceof Error) throw o;
    return o;
  };
  return { parse, calls };
}

describe('parsePdfWithRetry', function() {
  this.timeout(10000);

  it('returns the first result when parsing succeeds (one call, as on main)', async function() {
    const { parse, calls } = scripted([{ numpages: 2 }]);
    assert.deepEqual(await parsePdfWithRetry(Buffer.from('x'), undefined, parse), { numpages: 2 });
    assert.equal(calls.length, 1);
  });

  it('retries "bad XRef entry" / "Illegal character" / "Invalid number" until a parse succeeds', async function() {
    const { parse, calls } = scripted([new Error('bad XRef entry'), new Error('Illegal character: 41'),
      new Error('Invalid number: > (charCode 62)'), { numpages: 1 }]);
    assert.deepEqual(await parsePdfWithRetry(Buffer.from('x'), undefined, parse), { numpages: 1 });
    assert.equal(calls.length, 4);
  });

  it('passes pdf-parse an owned Uint8Array, never a pooled Buffer', async function() {
    const pooled = Buffer.from('%PDF-1.4 small');            // small: a view into Node's shared pool
    const { parse, calls } = scripted([{ numpages: 1 }]);
    await parsePdfWithRetry(pooled, undefined, parse);
    const got = calls[0];
    assert.ok(!Buffer.isBuffer(got) && got instanceof Uint8Array);
    assert.equal(got.byteOffset, 0);
    assert.equal(got.buffer.byteLength, pooled.length);
    assert.deepEqual(Buffer.from(got), pooled);
  });

  it('parses a small PDF reliably wherever the Buffer pool offset lands (real pdf-parse)', async function() {
    // Under 4 KiB, so fs.readFileSync returns a pooled Buffer on every Node version. Passed
    // to pdf-parse directly, this file failed about a third of these parses (Node 23.6).
    const pdf = fs.readFileSync('test/data/tiny-under-4k.pdf');
    let failures = 0;
    const counting = async (b, o) => { try { return await pdfParse(b, o); } catch (e) { failures++; throw e; } };
    for (let i = 0; i < 60; i++) {
      Buffer.from('x'.repeat(1 + ((i * 97) % 300)));        // move the pool offset
      const r = await parsePdfWithRetry(pdf, undefined, counting);
      assert.equal(r.numpages, 1);
      assert.match(r.text, /charmd tiny pdf fixture/);
    }
    assert.equal(failures, 0);
  });

  it('propagates other errors at once, and gives up after MAX_ATTEMPTS', async function() {
    const a = scripted([new Error('Invalid PDF structure')]);
    await assert.rejects(parsePdfWithRetry(Buffer.from('x'), undefined, a.parse), /Invalid PDF structure/);
    assert.equal(a.calls.length, 1);
    const b = scripted(Array.from({ length: MAX_ATTEMPTS + 2 }, () => new Error('bad XRef entry')));
    await assert.rejects(parsePdfWithRetry(Buffer.from('x'), undefined, b.parse), /bad XRef entry/);
    assert.equal(b.calls.length, MAX_ATTEMPTS);
  });
});
