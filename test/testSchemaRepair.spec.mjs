import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { validateAgainstSchema, requestToRepair } from '../lib/schema-validation.mjs';
import { fetchChatModel } from '../lib/core.mjs';
import { Message, TranscriptFragment } from '../lib/transcript.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const dir_data = path.join(__dirname, 'data', 'extra', 'schema_repair');

tags().describe('Test schema repair', function() {
  // Create one Mocha "it" test per instance-file
  tags('llm').it(`should repair a nonconformant answer`, async function() {
    this.timeout(msTimeout); 
    const pathLog = path.join(__dirname, path.basename(__filename)+".log")
    const fdLog = fs.openSync(pathLog, "w")
    const testPairs = loadSchemaInstancePairs(dir_data)
      .map((pair) => ({
        ...pair,
        initialErrors: validateAgainstSchema(pair.instanceData, pair.schemaData)
      }))
      .filter((pair) => pair.initialErrors.length > 0);
    assert(testPairs.length > 0, `No nonconformant fixtures found in ${dir_data}`);
    const chatModel = fetchChatModel(modelForChat);
    chatModel.system = [
      'You repair one invalid JSON response to satisfy the requested schema.',
      'Return only the repaired JSON instance.',
      'Do not include schema metadata, explanations, or wrapper objects unless they are required by the schema and present in the invalid response.'
    ].join(' ');
    chatModel.temperature = 0.0;
    let brief = []
    for (const { schemaPath, instancePath, schemaData, instanceData, initialErrors } of testPairs) {
      const invalidSuffix = new TranscriptFragment([
        new Message('assistant', JSON.stringify(instanceData, null, 2))
      ]);
      const repairPrompt = requestToRepair(invalidSuffix, initialErrors);

      const repairTranscript = new TranscriptFragment([
        new Message('user', repairPrompt)
      ]);
      const repairedSuffix = await chatModel.extendTranscript(
        repairTranscript,
        null,
        null,
        {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'forced_schema',
              schema: schemaData
            }
          }
        }
      );

      const repairedMessages = repairedSuffix.toJSON().messages || [];
      const assistantMessage = repairedMessages[repairedMessages.length - 1]?.content;

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

      const b = {
        schemaPath,
        instancePath,
        parsedOutput,
        initialErrorsCount: initialErrors.length,
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
    fs.closeSync(fdLog)
    const allOk = (data) => {
      return brief.every(item =>
        item.parseOk &&
        item.errorsOk &&
        item.sizeOk
      );
    };
    if(!allOk) {
      console.log({
        "event": "schema repair test",
        brief
      });
      assert(allOk)
    } else {
      console.log({
        "event": "schema repair test",
        repairedCases: brief.length
      });
    }
  });
});
