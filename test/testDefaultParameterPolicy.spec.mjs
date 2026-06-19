import { strict as assert } from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const generatedConfigDir = path.join(repoRoot, 'test', 'config', 'default-parameter-policy', 'generated');

const POLICY_PROPERTIES = [
  {
    name: 'ms_client_request_timeout',
    requestField: 'ms_client_request_timeout',
    defaultValue: 600000,
    modelOverrideValue: 610001,
    globalOverrideValue: 620001,
    requestOverrideValue: 630001
  }
];

const CONFIG_CASES = {
  noOverrides: {
    fileName: 'no-overrides.json',
    port: 5103
  },
  globalOverride: {
    fileName: 'global-override.json',
    port: 5104
  },
  modelOverride: {
    fileName: 'model-override.json',
    port: 5105
  }
};

const MODELS = {
  modelSpecific: 'policy-model-specific',
  global: 'policy-global'
};

function buildModelConfig(overrides = {}) {
  const modelConfig = {
    api: 'TestPolicy',
    model_type: 'chat',
    test_policy_properties: POLICY_PROPERTIES.map(item => item.name)
  };

  for (const [propertyName, overrideValue] of Object.entries(overrides)) {
    if (overrideValue !== undefined) {
      modelConfig[propertyName] = overrideValue;
    }
  }

  return modelConfig;
}

function buildScenarioConfig(configCaseName) {
  const configCase = CONFIG_CASES[configCaseName];
  const globalOverrides = {};
  const modelSpecificOverrides = {};

  if (configCaseName === 'globalOverride') {
    for (const property of POLICY_PROPERTIES) {
      globalOverrides[property.name] = property.globalOverrideValue;
    }
  }

  if (configCaseName === 'modelOverride') {
    for (const property of POLICY_PROPERTIES) {
      modelSpecificOverrides[property.name] = property.modelOverrideValue;
    }
  }

  const config = {
    server: {
      baseUrl: '',
      port: configCase.port
    },
    ...globalOverrides,
    models: {
      [MODELS.modelSpecific]: buildModelConfig(modelSpecificOverrides),
      [MODELS.global]: buildModelConfig()
    }
  };

  return config;
}

async function writeGeneratedConfigFiles() {
  await fs.rm(generatedConfigDir, { recursive: true, force: true });
  await fs.mkdir(generatedConfigDir, { recursive: true });

  for (const configCaseName of Object.keys(CONFIG_CASES)) {
    const configCase = CONFIG_CASES[configCaseName];
    configCase.path = path.join(generatedConfigDir, configCase.fileName);
    const config = buildScenarioConfig(configCaseName);
    await fs.writeFile(configCase.path, `${JSON.stringify(config, null, 2)}\n`);
  }
}

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
    } catch (error) {
      // Server is still starting.
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for server.\n${output.stdout}\n${output.stderr}`);
}

async function startServer(configCase) {
  const output = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, ['test/helpers/run-test-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CHARMONATOR_CONFIG: configCase.path
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', chunk => {
    output.stdout += chunk.toString();
  });

  child.stderr.on('data', chunk => {
    output.stderr += chunk.toString();
  });

  const baseUrl = `http://localhost:${configCase.port}/api/charmonator/v1`;
  await waitForServer(baseUrl, child, output);

  return { child, baseUrl, output };
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

function parseResolvedValues(responseJson) {
  assert(Array.isArray(responseJson.messages), 'Response should contain messages');

  const assistantMessage = responseJson.messages.find(message => message.role === 'assistant');
  assert(assistantMessage, 'Response should contain an assistant message');
  assert.equal(typeof assistantMessage.content, 'string', 'Assistant message should be a JSON string');

  return JSON.parse(assistantMessage.content);
}

async function fetchResolvedValues({ configCase, model, requestOverrides }) {
  const server = await startServer(configCase);

  try {
    const body = {
      model,
      transcript: {
        messages: [
          { role: 'user', content: 'Report the resolved default-parameter policy values for this request.' }
        ]
      },
      ...requestOverrides
    };

    const response = await fetch(`${server.baseUrl}/transcript/extension`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const responseJson = await response.json();
    assert(response.ok, `Expected 2xx status, got ${response.status}: ${JSON.stringify(responseJson)}`);

    return parseResolvedValues(responseJson);
  } finally {
    await stopServer(server.child);
  }
}

describe('Default Parameter Policy', function() {
  this.timeout(20000);

  before(async function() {
    await writeGeneratedConfigFiles();
  });

  after(async function() {
    await fs.rm(generatedConfigDir, { recursive: true, force: true });
  });

  for (const property of POLICY_PROPERTIES) {
    describe(property.name, function() {
      describe('model-specific config', function() {
        it('uses the populateConfigDefaults value with no overrides', async function() {
          const resolved = await fetchResolvedValues({
            configCase: CONFIG_CASES.noOverrides,
            model: MODELS.modelSpecific,
            requestOverrides: {}
          });

          assert.equal(resolved[property.name], property.defaultValue);
        });

        it('uses the model-specific config override', async function() {
          const resolved = await fetchResolvedValues({
            configCase: CONFIG_CASES.modelOverride,
            model: MODELS.modelSpecific,
            requestOverrides: {}
          });

          assert.equal(resolved[property.name], property.modelOverrideValue);
        });

        it('uses the request override', async function() {
          const resolved = await fetchResolvedValues({
            configCase: CONFIG_CASES.noOverrides,
            model: MODELS.modelSpecific,
            requestOverrides: {
              [property.requestField]: property.requestOverrideValue
            }
          });

          assert.equal(resolved[property.name], property.requestOverrideValue);
        });

        it('prefers the request override over the model-specific config override', async function() {
          const resolved = await fetchResolvedValues({
            configCase: CONFIG_CASES.modelOverride,
            model: MODELS.modelSpecific,
            requestOverrides: {
              [property.requestField]: property.requestOverrideValue
            }
          });

          assert.equal(resolved[property.name], property.requestOverrideValue);
        });
      });

      describe('global config', function() {
        it('uses the populateConfigDefaults value with no overrides', async function() {
          const resolved = await fetchResolvedValues({
            configCase: CONFIG_CASES.noOverrides,
            model: MODELS.global,
            requestOverrides: {}
          });

          assert.equal(resolved[property.name], property.defaultValue);
        });

        it('uses the global config override', async function() {
          const resolved = await fetchResolvedValues({
            configCase: CONFIG_CASES.globalOverride,
            model: MODELS.global,
            requestOverrides: {}
          });

          assert.equal(resolved[property.name], property.globalOverrideValue);
        });

        it('ignores model-specific config from another model', async function() {
          const resolved = await fetchResolvedValues({
            configCase: CONFIG_CASES.modelOverride,
            model: MODELS.global,
            requestOverrides: {}
          });

          assert.equal(resolved[property.name], property.defaultValue);
        });

        it('uses the request override', async function() {
          const resolved = await fetchResolvedValues({
            configCase: CONFIG_CASES.noOverrides,
            model: MODELS.global,
            requestOverrides: {
              [property.requestField]: property.requestOverrideValue
            }
          });

          assert.equal(resolved[property.name], property.requestOverrideValue);
        });

        it('prefers the request override over the global config override', async function() {
          const resolved = await fetchResolvedValues({
            configCase: CONFIG_CASES.globalOverride,
            model: MODELS.global,
            requestOverrides: {
              [property.requestField]: property.requestOverrideValue
            }
          });

          assert.equal(resolved[property.name], property.requestOverrideValue);
        });
      });
    });
  }
});
