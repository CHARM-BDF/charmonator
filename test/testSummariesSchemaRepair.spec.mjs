import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { Message, TranscriptFragment } from '../lib/transcript.mjs';
import { jsonSafeFromException } from '../lib/providers/provider_exception.mjs';
import {
  buildStructuredOutputOptions,
  callLLM
} from '../routes/charmonizer/document-summarize.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const generatedConfigDir = path.join(repoRoot, 'test', 'config', 'summaries-schema-repair', 'generated');

const TEST_PORT = 5109;
const TEST_CONFIG_PATH = path.join(generatedConfigDir, 'config.json');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming ready.\n${output.stdout}\n${output.stderr}`);
    }

    try {
      const response = await fetch(`${baseUrl}/models`);
      if (response.ok) {
        return;
      }
    } catch (_error) {
      // Server is still starting.
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for server.\n${output.stdout}\n${output.stderr}`);
}

async function startServer() {
  const output = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, ['test/helpers/run-test-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CHARMONATOR_CONFIG: TEST_CONFIG_PATH
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', chunk => {
    output.stdout += chunk.toString();
  });

  child.stderr.on('data', chunk => {
    output.stderr += chunk.toString();
  });

  const baseUrl = `http://localhost:${TEST_PORT}/api/charmonator/v1`;
  await waitForServer(baseUrl, child, output);

  return { child, output };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for server shutdown'));
    }, 5000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function writeGeneratedConfig() {
  const config = {
    server: {
      baseUrl: '',
      port: TEST_PORT
    },
    models: {
      'schema-repair-test-model': {
        api: 'TestPolicy',
        model_type: 'chat',
        test_policy_properties: [],
        test_policy_response_mode: 'summaries'
      }
    }
  };

  await fs.rm(generatedConfigDir, { recursive: true, force: true });
  await fs.mkdir(generatedConfigDir, { recursive: true });
  await fs.writeFile(TEST_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

class FakeChatModel {
  constructor(outputs) {
    this.outputs = [...outputs];
    this.calls = [];
  }

  async extendTranscript(prefix, _callOnOutput, _suffix, options) {
    this.calls.push({
      prefix: prefix.toJSON ? prefix.toJSON() : prefix,
      options
    });

    const content = this.outputs.shift();
    return new TranscriptFragment([
      new Message('assistant', content)
    ]);
  }
}

tags().describe('Summaries schema repair', function() {
  it('should repair invalid structured summary replies before returning', async function() {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        status: {
          type: 'string',
          enum: ['known', 'unknown']
        }
      },
      required: ['name', 'status'],
      additionalProperties: false
    };
    const chatModel = new FakeChatModel([
      JSON.stringify({ name: 123, status: 'bad' }),
      JSON.stringify({ name: 'Alice', status: 'unknown' })
    ]);
    const options = buildStructuredOutputOptions(
      { jsonSchema: schema },
      {
        num_defective_reply_max_attempts: 0,
        num_schema_repair_max_attempts: 1
      }
    );

    const reply = await callLLM(chatModel, [
      { role: 'system', content: 'You are a summarizer.' },
      { role: 'user', content: 'Summarize the document.' }
    ], options);

    assert.deepEqual(JSON.parse(reply), { name: 'Alice', status: 'unknown' });
    assert.equal(chatModel.calls.length, 2);

    const secondCallMessages = chatModel.calls[1].prefix.messages;
    assert.equal(secondCallMessages.length, 4);
    assert.equal(secondCallMessages[2].role, 'assistant');
    assert.equal(secondCallMessages[2].content, JSON.stringify({ name: 123, status: 'bad' }));
    assert.equal(secondCallMessages[3].role, 'user');
    assert.match(secondCallMessages[3].content, /ValidationErrors/);
    assert.match(secondCallMessages[3].content, /"keyword": "type"/);
    assert.match(secondCallMessages[3].content, /must be string/);
  });

  it('should throw a structured provider exception when schema validation is exhausted', async function() {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' }
      },
      required: ['summary'],
      additionalProperties: false
    };
    const chatModel = new FakeChatModel([
      JSON.stringify({}),
      JSON.stringify({})
    ]);
    const options = buildStructuredOutputOptions(
      { jsonSchema: schema },
      {
        num_defective_reply_max_attempts: 0,
        num_schema_repair_max_attempts: 1
      }
    );

    await assert.rejects(
      () => callLLM(chatModel, [
        { role: 'system', content: 'You are a summarizer.' },
        { role: 'user', content: 'Summarize the document.' }
      ], options),
      error => {
        assert.equal(error.interpretedErrorType, 'schema_validation_failed');
        assert.equal(error.interpretedCode, 422);
        assert.equal(error.interpretedMessage, 'The response could not be validated after multiple attempts.');
        assert.deepEqual(error.details, {
          mostValidOutput: {},
          finalResponse: '{}'
        });
        assert.deepEqual(jsonSafeFromException(error), {
          exception: 'Error',
          nameOfInnerException: 'Error',
          message: 'The response could not be validated after multiple attempts.',
          interpretedErrorType: 'schema_validation_failed',
          interpretedCode: 422,
          interpretedMessage: 'The response could not be validated after multiple attempts.',
          details: {
            mostValidOutput: {},
            finalResponse: '{}'
          }
        });
        return true;
      }
    );
  });

  it('should add structured output options for summaries json_schema requests', function() {
    const schema = {
      type: 'array',
      items: { type: 'string' }
    };
    const options = buildStructuredOutputOptions(
      { jsonSchema: schema },
      {
        stream: false,
        num_schema_repair_max_attempts: 2
      }
    );

    assert.deepEqual(options, {
      stream: false,
      num_schema_repair_max_attempts: 2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'forced-schema',
          schema
        }
      }
    });
  });

  it('should return HTTP 422 with validation metadata for summary schema-validation exhaustion', async function() {
    await writeGeneratedConfig();
    const server = await startServer();
    const url = `http://localhost:${TEST_PORT}/api/charmonizer/v1/summaries`;

    try {
      const submitResponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document: {
            id: 'schema-fail-doc',
            content: 'This content is not important for the fake provider.'
          },
          method: 'full',
          model: 'schema-repair-test-model',
          guidance: 'Return a summary object.',
          json_schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' }
            },
            required: ['summary'],
            additionalProperties: false
          },
          num_defective_reply_max_attempts: 0,
          num_schema_repair_max_attempts: 1
        })
      });
      assert.equal(submitResponse.status, 202);

      const { job_id: jobId } = await submitResponse.json();
      assert.equal(typeof jobId, 'string');

      const statusUrl = `${url}/${jobId}`;
      const resultUrl = `${url}/${jobId}/result`;
      let statusJson = null;

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const statusResponse = await fetch(statusUrl);
        statusJson = await statusResponse.json();
        if (statusJson.status === 'error') {
          break;
        }
        if (statusJson.status === 'complete') {
          assert.fail(`Expected schema-validation exhaustion, got completion: ${JSON.stringify(statusJson)}`);
        }
        await sleep(100);
      }

      assert.equal(statusJson?.status, 'error');

      const resultResponse = await fetch(resultUrl);
      const resultJson = await resultResponse.json();

      assert.equal(resultResponse.status, 422);
      assert.equal(resultJson.status, 'error');
      assert.equal(resultJson.error.interpretedErrorType, 'schema_validation_failed');
      assert.equal(resultJson.error.interpretedCode, 422);
      assert.equal(resultJson.error.interpretedMessage, 'The response could not be validated after multiple attempts.');
      assert.deepEqual(resultJson.error.details, {
        mostValidOutput: {},
        finalResponse: '{}'
      });
    } finally {
      await stopServer(server.child);
      await fs.rm(generatedConfigDir, { recursive: true, force: true });
    }
  });
});
