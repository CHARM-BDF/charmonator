import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { validateAgainstSchema, requestToRepair } from '../lib/schema-validation.mjs';
import { createAndStart } from '../lib/server.mjs';
import Ajv from 'ajv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Your existing server/test config parameters, as needed:
const __port = 5003;
const baseUrl = `http://localhost:${__port}/api/charmonator/v1`;
const modelForChat = 'my-unittest-model';

/**
 * Recursively get all subdirectories of a given directory
 */
function getSubdirectories(dir) {
  const results = [];
  const contents = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of contents) {
    if (entry.isDirectory()) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

/**
 * Load (schema, instance) pairs from each subdirectory under the given baseDir.
 * Each subdirectory must have one file named schema.json and one or more
 * instance files (e.g., *.json) that are not named schema.json.
 */
function loadSchemaInstancePairs(baseDir) {
  const subdirs = getSubdirectories(baseDir);
  const testCases = [];

  for (const subdir of subdirs) {
    const files = fs.readdirSync(subdir);
    const schemaFile = files.find((f) => f === 'schema.json');
    if (!schemaFile) {
      // Skip subdir if no schema.json
      continue;
    }
    const schemaPath = path.join(subdir, schemaFile);
    const schemaData = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    // Collect instance files
    for (const file of files) {
      // Skip schema.json itself
      if (file === 'schema.json') continue;
      if (!file.endsWith('.json')) continue;

      const instancePath = path.join(subdir, file);
      const instanceData = JSON.parse(fs.readFileSync(instancePath, 'utf8'));

      testCases.push({
        schemaPath,
        instancePath,
        schemaData,
        instanceData,
      });
    }
  }

  return testCases;
}

const msTimeout = 600000 // TODO: iteration, timeoutMargin
const dir_data = path.join(__dirname, 'data', 'schema_repair');

tags().describe('Test schema repair', function() {
  let server;

  before(async function () {
    server = await createAndStart()
  })

  after(async function() {
    await new Promise(resolve => {
      server.close(resolve);
    });
  })
  // Create one Mocha "it" test per instance-file
  it(`should repair a nonconformant answer`, async function() {
    this.timeout(msTimeout); 
    const pathLog = path.join(__dirname, path.basename(__filename)+".log")
    const fdLog = fs.openSync(pathLog, "w")
    const testPairs = loadSchemaInstancePairs(dir_data);
    let numTotalRepairAttempts = 0
    let brief = []
    for (const { schemaPath, instancePath, schemaData, instanceData } of testPairs) {
      // Prepare the user prompt, which includes the text: "Copy this data"
      const promptHackTest = `Copy this data:\n${JSON.stringify(instanceData, null, 2)}`;

      // Post to the existing /transcript/extension endpoint
      const url = `${baseUrl}/transcript/extension`;
      const requestBody = {
        model: modelForChat,
        system: 'You are a system that must validate JSON data.',
        temperature: 0.0,
        transcript: {
          messages: [
            { role: 'user', content: promptHackTest }
          ]
        },
        options: {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'forced_schema',
              schema: schemaData
            }
          }
        }
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      // The transcript returned by /transcript/extension typically has { messages: [...] }
      const jsonRes = await resp.json();

      const httpOk = resp.status >= 200 && resp.status < 300
      const httpMsg = httpOk ? "" : `Unexpected status: ${resp.status}\n  body: ${jsonRes}`;

      const assistantMessage = jsonRes.messages?.[jsonRes.messages.length - 1]?.content;

      let parsedOutput = null;
      try {
        parsedOutput = JSON.parse(assistantMessage);
      } catch (err) {
        assert.fail(`Could not parse assistant message as valid JSON.\nMessage:\n${assistantMessage}`);
      }

      const parseOk = !!parsedOutput

      // Validate result against the schema
      const errors = validateAgainstSchema(parsedOutput, schemaData);
      //assert(errors.length === 0, `Output does not match schema. Errors: ${JSON.stringify(errors)}`);
      const errorsOk = errors.length === 0

            // Check size requirement: output is at least 90% of original instance's size
      const originalSize = JSON.stringify(instanceData).length;
      const returnedSize = JSON.stringify(parsedOutput).length;
      const sizeOk = returnedSize >= 0.6 * originalSize;

      const numRepairAttempts = resp.headers.get('x-num-repair-attempts')
      numTotalRepairAttempts += numRepairAttempts

      const ok = parseOk && errorsOk && sizeOk;

      const b = {
        numAttempts: numRepairAttempts,
        instancePath,
        parsedOutput,
        httpOk,
        httpMsg,
        parseOk,
        errorsOk,
        sizeOk
      }
      brief.push(b)
      console.log(b)

      fs.writeSync(fdLog, JSON.stringify({
        b,
        input: instanceData,
        output: parsedOutput
      }, null, 2)+"\n")
      fs.fsyncSync(fdLog)
    }
    const allOk = (data) => {
      return brief.every(item =>
        item.httpOk &&
        item.parseOk &&
        item.errorsOk &&
        item.sizeOk
      );
    };
    // The 0-1 threshold indicates whether or not the repair prompt was needed at all.  In an
    // ideal test fixturing, we would build a way to bypass the transcript extension API and go
    // straight to schema repair, but instead we use promptHackTest, and that means we need to
    // do this cleanup.  But it would be more code, and for an unclear benefit.  What does it
    // mean if prommptHackTest gets through schema validation first try?  To me it seems that
    // the the test input is not difficult enough for the model under test, there's no way
    // we would have known that other than to have gathered the test example and seen it pass,
    // and there is no action we need to take to resolve any problem.
    const numAttemptsTotal = brief.reduce((acc, b) => (b["numAttempts"] >= 1 ? b["numAttempts"]-1 : 0) + acc, 0)
    if(!allOk) {
      console.log({
        "event": "schema repair test",
        brief
      });
      assert(allOk)
    } else {
      console.log({
        "event": "schema repair test",
        numFixesTotal: numAttemptsTotal
      });
    }
  });
});
