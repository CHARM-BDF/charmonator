import { strict as assert } from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const generatedConfigDir = path.join(repoRoot, 'test', 'config', 'transcript-defective-retry', 'generated');
const configPath = path.join(generatedConfigDir, 'config.json');
const port = 5111;
const model = 'test-transcript-defective-retry';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeConfig() {
  const config = {
    server: {
      baseUrl: '',
      port
    },
    models: {
      [model]: {
        api: 'TestPolicy',
        model_type: 'chat',
        test_policy_response_mode: 'transcript/extension',
        test_policy_num_initial_defective_replies: 2
      }
    }
  };

  await fs.rm(generatedConfigDir, { recursive: true, force: true });
  await fs.mkdir(generatedConfigDir, { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function waitForServer(child, output) {
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming ready.\n${output.stdout}\n${output.stderr}`);
    }

    try {
      const response = await fetch(`http://localhost:${port}/api/charmonator/v1/models`);
      if (response.ok) {
        return;
      }
    } catch (error) {
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
      CHARMONATOR_CONFIG: configPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', chunk => {
    output.stdout += chunk.toString();
  });

  child.stderr.on('data', chunk => {
    output.stderr += chunk.toString();
  });

  await waitForServer(child, output);
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

async function postTranscriptExtension(numDefectiveReplyMaxAttempts) {
  const response = await fetch(`http://localhost:${port}/api/charmonator/v1/transcript/extension`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      transcript: {
        messages: [
          { role: 'user', content: 'Return the resolved policy payload.' }
        ]
      },
      num_defective_reply_max_attempts: numDefectiveReplyMaxAttempts
    })
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

describe('Transcript Extension defective reply retries', function() {
  this.timeout(20000);

  let server = null;

  before(async function() {
    await writeConfig();
    server = await startServer();
  });

  after(async function() {
    await stopServer(server?.child);
    await fs.rm(generatedConfigDir, { recursive: true, force: true });
  });

  it('should fail when defective replies exceed num_defective_reply_max_attempts', async function() {
    const response = await postTranscriptExtension(1);

    assert.equal(response.status, 500);
    assert.equal(typeof response.body, 'string');
    assert.match(response.body, /Exhausted num_defective_reply_max_attempts/);
  });

  it('should retry defective replies until a nondefective assistant message is returned', async function() {
    const response = await postTranscriptExtension(2);

    assert.equal(response.status, 200);
    assert(Array.isArray(response.body.messages), 'Response should contain messages');

    const assistantMessage = response.body.messages.find(message => message.role === 'assistant');
    assert(assistantMessage, 'Response should contain an assistant message');

    const parsed = JSON.parse(assistantMessage.content);
    assert.equal(parsed.ms_client_request_timeout, 600000);
  });
});
