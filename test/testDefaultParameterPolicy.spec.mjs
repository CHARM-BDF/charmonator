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
const TEST_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=';

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

const PROPERTY_MAP = new Map(POLICY_PROPERTIES.map(property => [property.name, property]));

const ENDPOINTS = [
  {
    id: 'transcript-extension',
    method: 'POST',
    url: 'transcript/extension',
    apiPrefix: 'charmonator',
    responseMode: 'transcript/extension',
    properties: [
      'num_client_request_max_attempts',
      'ms_client_request_timeout'
    ],
    buildRequest(model, requestOverrides) {
      return {
        model,
        transcript: {
          messages: [
            { role: 'user', content: 'Report the resolved default-parameter policy values for this request.' }
          ]
        },
        ...requestOverrides
      };
    },
    async fetchResolvedValues(server, model, requestOverrides) {
      const responseJson = await fetchJson({
        method: this.method,
        url: buildEndpointUrl(server.port, this),
        body: this.buildRequest(model, requestOverrides)
      });
      return parseAssistantJsonValues(responseJson);
    }
  },
  {
    id: 'summaries',
    method: 'POST',
    url: 'summaries',
    apiPrefix: 'charmonizer',
    responseMode: 'summaries',
    properties: [
      'num_client_request_max_attempts',
      'ms_client_request_timeout'
    ],
    buildRequest(model, requestOverrides) {
      return {
        document: {
          id: 'policy-doc',
          content: 'A short document for summarization policy testing.'
        },
        method: 'full',
        model,
        guidance: 'Return the resolved policy payload.',
        annotation_field: 'policy_summary',
        ...requestOverrides
      };
    },
    async fetchResolvedValues(server, model, requestOverrides) {
      const submitResponse = await fetchJson({
        method: this.method,
        url: buildEndpointUrl(server.port, this),
        body: this.buildRequest(model, requestOverrides),
        expectedStatus: 202
      });
      const jobId = submitResponse.job_id;
      assert(jobId, 'Summaries response should contain a job_id');

      const resultDoc = await pollSummaryResult(server.port, jobId);
      const rawSummary = resultDoc?.annotations?.policy_summary;
      assert.equal(typeof rawSummary, 'string', 'Summary annotation should contain a JSON string');
      return JSON.parse(rawSummary);
    }
  },
  {
    id: 'conversion-image',
    method: 'POST',
    url: 'conversion/image',
    apiPrefix: 'charmonator',
    responseMode: 'conversion/image',
    properties: [],
    buildRequest(model, requestOverrides) {
      return {
        model,
        imageUrl: TEST_IMAGE_DATA_URL,
        describe: false,
        ...requestOverrides
      };
    },
    async fetchResolvedValues(server, model, requestOverrides) {
      const responseJson = await fetchJson({
        method: this.method,
        url: buildEndpointUrl(server.port, this),
        body: this.buildRequest(model, requestOverrides)
      });
      assert.equal(typeof responseJson.markdown, 'string', 'conversion/image should return markdown text');
      return JSON.parse(responseJson.markdown);
    }
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
  modelName(endpoint, scope) {
    return `policy-${endpoint.id}-${scope}`;
  }
};

function getProperty(propertyName) {
  const property = PROPERTY_MAP.get(propertyName);
  assert(property, `Unknown test policy property: ${propertyName}`);
  return property;
}

function buildModelConfig(endpoint, overrides = {}) {
  const testPolicyRequestFields = Object.fromEntries(
    endpoint.properties.map(propertyName => {
      const property = getProperty(propertyName);
      return [property.name, property.requestField];
    })
  );

  const modelConfig = {
    api: 'TestPolicy',
    model_type: 'chat',
    test_policy_properties: [...endpoint.properties],
    test_policy_request_fields: testPolicyRequestFields,
    test_policy_response_mode: endpoint.responseMode
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
  const models = {};

  for (const endpoint of ENDPOINTS) {
    const modelSpecificOverrides = {};

    if (configCaseName === 'globalOverride') {
      for (const propertyName of endpoint.properties) {
        const property = getProperty(propertyName);
        globalOverrides[property.name] = property.globalOverrideValue;
      }
    }

    if (configCaseName === 'modelOverride') {
      for (const propertyName of endpoint.properties) {
        const property = getProperty(propertyName);
        modelSpecificOverrides[property.name] = property.modelOverrideValue;
      }
    }

    models[MODELS.modelName(endpoint, 'model-specific')] = buildModelConfig(endpoint, modelSpecificOverrides);
    models[MODELS.modelName(endpoint, 'global')] = buildModelConfig(endpoint);
  }

  const config = {
    server: {
      baseUrl: '',
      port: configCase.port
    },
    ...globalOverrides,
    models
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

function buildEndpointUrl(port, endpoint) {
  if (endpoint.apiPrefix === 'charmonator') {
    return `http://localhost:${port}/api/charmonator/v1/${endpoint.url}`;
  }
  if (endpoint.apiPrefix === 'charmonizer') {
    return `http://localhost:${port}/api/charmonizer/v1/${endpoint.url}`;
  }
  throw new Error(`Unsupported apiPrefix: ${endpoint.apiPrefix}`);
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

  return { child, baseUrl, output, port: configCase.port };
}

async function fetchJson({ method, url, body = undefined, expectedStatus = 200 }) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const responseJson = await response.json();
  assert.equal(
    response.status,
    expectedStatus,
    `Expected ${expectedStatus} from ${method} ${url}, got ${response.status}: ${JSON.stringify(responseJson)}`
  );
  return responseJson;
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

function parseAssistantJsonValues(responseJson) {
  assert(Array.isArray(responseJson.messages), 'Response should contain messages');

  const assistantMessage = responseJson.messages.find(message => message.role === 'assistant');
  assert(assistantMessage, 'Response should contain an assistant message');
  assert.equal(typeof assistantMessage.content, 'string', 'Assistant message should be a JSON string');

  return JSON.parse(assistantMessage.content);
}

async function pollSummaryResult(port, jobId) {
  const statusUrl = `http://localhost:${port}/api/charmonizer/v1/summaries/${jobId}`;
  const resultUrl = `http://localhost:${port}/api/charmonizer/v1/summaries/${jobId}/result`;
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    const statusResponse = await fetch(statusUrl);
    const statusJson = await statusResponse.json();

    if (statusJson.status === 'complete') {
      return await fetchJson({ method: 'GET', url: resultUrl });
    }
    if (statusJson.status === 'error') {
      throw new Error(`Summaries job failed: ${JSON.stringify(statusJson)}`);
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for summaries job ${jobId}`);
}

async function fetchResolvedValues({ endpoint, configCase, modelScope, requestOverrides }) {
  const server = await startServer(configCase);

  try {
    const model = MODELS.modelName(endpoint, modelScope);
    return await endpoint.fetchResolvedValues(server, model, requestOverrides);
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

  for (const endpoint of ENDPOINTS) {
    describe(`${endpoint.method} ${endpoint.url}`, function() {
      for (const propertyName of endpoint.properties) {
        const property = getProperty(propertyName);

        describe(property.name, function() {
          describe('model-specific config', function() {
            it('uses the populateConfigDefaults value with no overrides', async function() {
              const resolved = await fetchResolvedValues({
                endpoint,
                configCase: CONFIG_CASES.noOverrides,
                modelScope: 'model-specific',
                requestOverrides: {}
              });

              assert.equal(resolved[property.name], property.defaultValue);
            });

            it('uses the model-specific config override', async function() {
              const resolved = await fetchResolvedValues({
                endpoint,
                configCase: CONFIG_CASES.modelOverride,
                modelScope: 'model-specific',
                requestOverrides: {}
              });

              assert.equal(resolved[property.name], property.modelOverrideValue);
            });

            it('uses the request override', async function() {
              const resolved = await fetchResolvedValues({
                endpoint,
                configCase: CONFIG_CASES.noOverrides,
                modelScope: 'model-specific',
                requestOverrides: {
                  [property.requestField]: property.requestOverrideValue
                }
              });

              assert.equal(resolved[property.name], property.requestOverrideValue);
            });

            it('prefers the request override over the model-specific config override', async function() {
              const resolved = await fetchResolvedValues({
                endpoint,
                configCase: CONFIG_CASES.modelOverride,
                modelScope: 'model-specific',
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
                endpoint,
                configCase: CONFIG_CASES.noOverrides,
                modelScope: 'global',
                requestOverrides: {}
              });

              assert.equal(resolved[property.name], property.defaultValue);
            });

            it('uses the global config override', async function() {
              const resolved = await fetchResolvedValues({
                endpoint,
                configCase: CONFIG_CASES.globalOverride,
                modelScope: 'global',
                requestOverrides: {}
              });

              assert.equal(resolved[property.name], property.globalOverrideValue);
            });

            it('ignores model-specific config from another model', async function() {
              const resolved = await fetchResolvedValues({
                endpoint,
                configCase: CONFIG_CASES.modelOverride,
                modelScope: 'global',
                requestOverrides: {}
              });

              assert.equal(resolved[property.name], property.defaultValue);
            });

            it('uses the request override', async function() {
              const resolved = await fetchResolvedValues({
                endpoint,
                configCase: CONFIG_CASES.noOverrides,
                modelScope: 'global',
                requestOverrides: {
                  [property.requestField]: property.requestOverrideValue
                }
              });

              assert.equal(resolved[property.name], property.requestOverrideValue);
            });

            it('prefers the request override over the global config override', async function() {
              const resolved = await fetchResolvedValues({
                endpoint,
                configCase: CONFIG_CASES.globalOverride,
                modelScope: 'global',
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
  }
});
