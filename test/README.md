# Charmonator Testing

## Scope

Testing when done well is an exercise in mitigating risks.

This document attempts to name risks, prioritize them, and describe what we do about them.

In the following "Charmonator" refers to both the Charmonator and Charmonizer parts of the API.

### In-Scope

  - We try to mitigate against accidental changes in backward Compatibility.
  - We try to make sure data has been run through the most essential features of Charmonator.
  - We try to make sure the tests supplement the current documentation so that a reasonably motivated new user of Charmonator can figure out how to use the essential features of Charmonator.

### Out of Scope

  - Charmonator is a research system.  Many of its parts are experemental.  Uncertainty in this space is driven by factors including unknown phenomena in LLM, vendor bugs, what will be found during the collection of data, and what limitations will be found once those data are processed.  Because of these factors, it is not practical to test some parts of Charmonator as one might hope.

## Automated vs manual testing

The UI in this application is browser-based an currently relatively simple.  Because browser automation can be brittle, we only test the UI manually.

Because only humans can test against unforseen difficulties, we review changes when they are substantial in nature.  Assessing "substantial in nature" is left up to professional judgement.

Some features (e.g. budgeted summarization) have required extensive data collection and/or experimentation and so by their nature lie outside of automated testing.

## Automated testing - Conventions

We use the following conventions for automated testing.

### Test runner

When it is practical to automate tests, to organize them, this repository uses [Mocha](https://mochajs.org/) with [mocha-tags-ultra](https://www.npmjs.com/package/mocha-tags-ultra).

### Mocha test commands
Since Mocha can be invoked in many ways, the `package.json` supplies various test commands, including:
|   |   |
|---|---|
| "npm run test" | skips the `llm`-tagged tests |
| "npm run test:all" | runs everything, including `llm` tests |
| "npm run test:ci" | uses the `not:llm` tag, intended for CI environments |
| "npm run test:myfavorite" | A reminder for how to run a single mocha test during development |

Check `package.json` for the canonical list.

### Configuration via Environment Variables
Certain tests require a specific config file. By default, we load `CHARMONATOR_CONFIG=conf/config.unittest.json`, especially if the tests need particular settings (for example, using a specific LLM API key).  Tests should hard-code the keys in config.unittest.json.  When required, the Mocha test commands set `CHARMONATOR_CONFIG` before running mocha.

### Automatic Server Lifecycle
Each test file is responsible for starting and stopping the application server. We call our custom function `createAndStart()` (imported from `../lib/server.mjs`) inside a `before()` hook, and close the server in an `after()` hook. This ensures the server is ready for HTTP requests before the tests run, and that it properly shuts down afterward.

### Tagging LLM Tests
Any test that requires a live API key (for example, calls out to Anthropic, OpenAI, or similar) is tagged with `llm`. By default, the command:
```
npm test
```
runs Mocha with `--tags "not:llm"`, which means all tests requiring an actual LLM key are skipped. If you want to run the LLM tests, either remove this tag filter or run:
```
npm run test:all
```
to include everything.

### Default Reporter
Because some endpoints emit copious amounts of text, we use a custom reporter to emit a final summary
of every mocha run.  The reporter is included in the default Mocha test commands.

### Mocha/Assertion Style
We use the native Node.js `assert` module (`import { strict as assert } from 'assert';`). This provides strict assertion methods such as `assert.equal()`, `assert.deepStrictEqual()`, etc.

### Timeouts
As in production, timeouts for calls in tests to external LLM services are challenging to calibrate.  The request times vary wildly by time of day.

To prevent test hangs, we do add timeouts when LLM calls go from Charmonator/Charmonizer to outside providers.  The mocha API to set a timeout is:
```
this.timeout(msForTimeout)
```
To reconcile the best and worst case times, we provide a constant:
```
const timeoutMargin = 5;
```
If at 9am on a Saturday, the test always runs within 2000ms, then write:
```
this.timeout(2000*timeoutMargin);
```
### Polling asynchronous endpoints
There is a pattern for polling asynchronous endpoints.  See `testRest.spec.mjs`:
```
    const urlResult = `${baseCharmonizerUrl}/conversions/documents/${jobId}/result`;
    const [finalDoc, finalRes] = await pollForComplete(urlStatus, urlResult);
```
### Directory Structure
Store all test files in the `test/` folder.  Use a `.spec.mjs` extension to be recognized as a test. Each file can handle a cohesive group of related tests. Automated test data lives under `test/data/`.

## Continuous Integration

We use Github Actions to invoke our tests.  Github Actions

### Tests run in the following three situations:

  - Every time a push is made to main in the official (non forked) repository
  - Every time a PR is opened with a destination of main in the official (non forked) repository
  - Every time a branch is pushed named "ci/..." in the official (non forked) repository

### How to see my remote test run

  - Start at https://github.com/CHARM-BDF/charmonator
  - Click "Actions"
  - Under "Showing runs from all workflows", find a run for your commit/branch
  - Click the run's title hyperlink
  - In the left margin, click "Send Mocha Test Reports".
  - You should see something like "78 passed, 0 failed and 11 skipped ", followed by detailed tables of the test run.

### Implementation/Configuration
Github Actions invokes `npm run test:ci` via `.github/workflows/test.yml`.

Unlike the other Mocha test commands, test:ci communicates with github through "mocha json", a reporter built in to mocha, activated with "--reporter json".  Here an example of the data --reporter json reports for display:

    {
      "title": "should tokenize with default encoding (cl100k_base)",
      "fullTitle": "Tokens Endpoint Tests POST /tokens - Basic Tests should tokenize with default encoding (cl100k_base)",
      "file": ".../charmonator/test/testEndpointTokens.spec.mjs",
      "duration": 74,
      "currentRetry": 0,
      "speed": "medium",
      "err": {}
    },

Due to some unfortunate design decisions of Github Actions, the part of the test running that collects the test results has to be in a separate workflow, `.github/workflows/test-report.yml`.

