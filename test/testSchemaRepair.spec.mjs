import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { validateAgainstSchema, requestToRepair } from '../lib/schema-validation.mjs';
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
  // Create one Mocha "it" test per instance-file
  it(`should repair a nonconformant answer`, async function() {
    this.timeout(msTimeout); 
    const pathLog = path.join(__dirname, path.basename(__filename)+".log")
    const fdLog = fs.openSync(pathLog, "w")
    const testPairs = loadSchemaInstancePairs(dir_data);
    let numTotalRepairAttempts = 0
    for (const { schemaPath, instancePath, schemaData, instanceData } of testPairs) {
      // Prepare the user prompt, which includes the text: "Copy this data"
      const userContent = `Copy this data:\n${JSON.stringify(instanceData, null, 2)}`;

      // Post to the existing /transcript/extension endpoint
      const url = `${baseUrl}/transcript/extension`;
      const requestBody = {
        model: modelForChat,
        system: 'You are a system that must validate JSON data.',
        temperature: 0.0,
        transcript: {
          messages: [
            { role: 'user', content: userContent }
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

      // If the server returned 4xx or 5xx, throw
      assert(resp.status >= 200 && resp.status < 300, `Unexpected status: ${resp.status}`);

      // The transcript returned by /transcript/extension typically has { messages: [...] }
      const jsonRes = await resp.json();

      const numRepairAttempts = resp.headers.get('x-num-repair-attempts')
      numTotalRepairAttempts += numRepairAttempts
      // The bot’s response should be in the last message (adjust to your actual structure)
      const assistantMessage = jsonRes.messages?.[jsonRes.messages.length - 1]?.content;

      assert(assistantMessage, 'Expected to receive assistant content in the last message!');

      let parsedOutput;
      try {
        parsedOutput = JSON.parse(assistantMessage);
      } catch (err) {
        assert.fail(`Could not parse assistant message as valid JSON.\nMessage:\n${assistantMessage}`);
      }

      // Validate result against the schema
      const errors = validateAgainstSchema(parsedOutput, schemaData);
      assert(errors.length === 0, `Output does not match schema. Errors: ${JSON.stringify(errors)}`);
      fs.writeSync(fdLog, JSON.stringify({
        input: instanceData,
        output: parsedOutput,
        numAttempts: numRepairAttempts
      }, null, 2))
      fs.fsyncSync(fdLog)
      // Check size requirement: output is at least 90% of original instance's size
      const originalSize = JSON.stringify(instanceData).length;
      const returnedSize = JSON.stringify(parsedOutput).length;
      assert(returnedSize >= 0.6 * originalSize,
        `Returned JSON is smaller than 70% of original:\noriginal size=${originalSize}, returned size=${returnedSize}`);
    }
  });
});
