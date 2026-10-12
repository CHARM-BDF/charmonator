// parsePdfWithRetry: retries only the pdf-parse defect seen on Node 24.18+.

import { strict as assert } from 'assert';
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

  it('retries "bad XRef entry" / "Illegal character" until a parse succeeds', async function() {
    const { parse, calls } = scripted([new Error('bad XRef entry'), new Error('Illegal character: 41'), { numpages: 1 }]);
    assert.deepEqual(await parsePdfWithRetry(Buffer.from('x'), undefined, parse), { numpages: 1 });
    assert.equal(calls.length, 3);
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
