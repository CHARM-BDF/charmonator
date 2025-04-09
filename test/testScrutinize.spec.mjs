import tags from 'mocha-tags-ultra';
import { scrutinizeViaDiff2, runsViaDiff2TestOnly } from '../lib/scrutinize.mjs';
import assert from 'assert';

/*
  The mocha-tag "llm" is used to separate llm-dependent tests from other tests:
    tags('llm').

  Run without llm via:
    npm test

  And with via:
    npm run test:all

  Note that for one npm desugars "run" while for the other does not.
  Note also: the --tags "not:llm" filter seems to work but the
    --tags "is:llm" filter advertised in the mocha-tags documentation
    seems to have a bug.  Mocha-tags seems to be unmaintained, but
    there doesn't seem to be
  */


tags().
describe('testDiff2', function() {

  before(function() {
  });

  after(function() {
  });

  it('should match', function() {
    const txt0 = `
    The quick brown fox
    `.trim();

    const txt1 = `
    The quick brown fox
    `.trim();

    const runs = runsViaDiff2TestOnly([txt0, txt1]);
    assert.deepStrictEqual(runs.map(r => r[0]), ['MATCH'])
  });

  it('should change last 2', function() {
    const txt0 = `
    The quick broun foxe
    `.trim();

    const txt1 = `
    The quick brown fox
    `.trim();

    const runs = runsViaDiff2TestOnly([txt0, txt1]);
    assert.deepStrictEqual(runs.map(r => r[0]), ['MATCH', 'DELETE', 'INSERT'])
  });

  it('should change middle 2', function() {
    const txt0 = `
    The quyk broun fox
    `.trim();

    const txt1 = `
    The quick brown fox
    `.trim();

    const runs = runsViaDiff2TestOnly([txt0, txt1]);
    assert.deepStrictEqual(runs.map(r => r[0]), ['MATCH', 'DELETE', 'INSERT', 'MATCH'])
  });

  it('should change first two', function() {
    const txt0 = `
    The quick brown fox
    `.trim();

    const txt1 = `
    Þe quyk brown fox
    `.trim();

    const runs = runsViaDiff2TestOnly([txt0, txt1]);
    assert.deepStrictEqual(runs.map(r => r[0]), ['DELETE', 'INSERT', 'MATCH'])
  });

  it('should markup middle 2', function() {
    const txt0 = `
    The quyk broun fox
    `.trim();

    const txt1 = `
    The quick brown fox
    `.trim();

    const markup = scrutinizeViaDiff2([txt0, txt1]);
    assert.equal(markup,
      'The <ocr var="0">quyk broun </ocr><ocr var="1">quick brown </ocr>fox')
  });

  tags('llm').
  it('how to tag when we want to check with an LLM', function () {
  })
});
