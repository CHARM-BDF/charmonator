// Unit tests for Anthropic_Bedrock auth option resolution (aws_profile, aws_region,
// aws_auth, ${ENV} interpolation, default credential chain). No network to AWS:
// the one end-to-end case uses loopback mocks for the ECS credentials endpoint
// and the Bedrock runtime.

import { strict as assert } from 'assert';
import http from 'http';
import path from 'path';
import os from 'os';
import {
  AnthropicProvider,
  resolveBedrockClientOptions
} from '../lib/providers/provider_anthropic.mjs';
import { TranscriptFragment, Message } from '../lib/transcript.mjs';

const ENV_KEYS = [
  'CHARMD_TEST_AK', 'CHARMD_TEST_SK', 'CHARMD_TEST_REGION', 'CHARMD_TEST_PROFILE',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE',
  'AWS_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_EC2_METADATA_DISABLED',
  'ANTHROPIC_BEDROCK_BASE_URL'
];

describe('Anthropic_Bedrock auth options', function() {
  let saved;

  beforeEach(function() {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(function() {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('uses the default credential chain when no keys or profile are given (main behaviour)', function() {
    const r = resolveBedrockClientOptions({ api: 'Anthropic_Bedrock', aws_region: 'us-west-2' });
    assert.equal(r.mode, 'default_chain');
    assert.equal(r.clientOptions.awsRegion, 'us-west-2');
    assert.equal(r.clientOptions.awsAccessKey, undefined);
    assert.equal(typeof r.clientOptions.providerChainResolver, 'function');
  });

  it('uses static keys when both are given, with ${ENV} interpolation', function() {
    process.env.CHARMD_TEST_AK = 'AKIDEXAMPLE';
    process.env.CHARMD_TEST_SK = 'secret-example';
    process.env.CHARMD_TEST_REGION = 'us-east-2';
    const r = resolveBedrockClientOptions({
      aws_access_key: '${CHARMD_TEST_AK}',
      aws_secret_key: '${CHARMD_TEST_SK}',
      aws_session_token: 'tok',
      aws_region: '${CHARMD_TEST_REGION}'
    });
    assert.equal(r.mode, 'static');
    assert.deepEqual(r.clientOptions, {
      awsRegion: 'us-east-2',
      awsAccessKey: 'AKIDEXAMPLE',
      awsSecretKey: 'secret-example',
      awsSessionToken: 'tok'
    });
  });

  it('falls back to the default chain when key env vars are unset', function() {
    const r = resolveBedrockClientOptions({
      aws_access_key: '${CHARMD_TEST_AK}',
      aws_secret_key: '${CHARMD_TEST_SK}',
      aws_region: '${CHARMD_TEST_REGION}'
    });
    assert.equal(r.mode, 'default_chain');
    assert.deepEqual(Object.keys(r.clientOptions), ['providerChainResolver']);
  });

  it('uses a named (e.g. SSO) profile via aws_profile', async function() {
    process.env.CHARMD_TEST_PROFILE = 'example-sso';
    const r = resolveBedrockClientOptions({ aws_profile: '${CHARMD_TEST_PROFILE}', aws_region: 'us-east-1' });
    assert.equal(r.mode, 'profile');
    assert.equal(r.profile, 'example-sso');
    assert.equal(r.clientOptions.awsAccessKey, undefined);
    assert.equal(typeof r.clientOptions.providerChainResolver, 'function');
    // Resolving the chain only builds the provider; it does not fetch credentials.
    const provider = await r.clientOptions.providerChainResolver();
    assert.equal(typeof provider, 'function');
  });

  it('static keys win over aws_profile unless aws_auth says otherwise', function() {
    const cfg = { aws_access_key: 'AK', aws_secret_key: 'SK', aws_profile: 'p' };
    assert.equal(resolveBedrockClientOptions(cfg).mode, 'static');
    assert.equal(resolveBedrockClientOptions({ ...cfg, aws_auth: 'profile' }).mode, 'profile');
    const dc = resolveBedrockClientOptions({ ...cfg, aws_auth: 'default_chain' });
    assert.equal(dc.mode, 'default_chain');
    assert.deepEqual(Object.keys(dc.clientOptions), ['providerChainResolver']);
  });

  it('rejects inconsistent or unknown aws_auth values', function() {
    assert.throws(() => resolveBedrockClientOptions({ aws_auth: 'static' }), /requires non-empty aws_access_key/);
    assert.throws(() => resolveBedrockClientOptions({ aws_auth: 'profile' }), /requires a non-empty aws_profile/);
    assert.throws(() => resolveBedrockClientOptions({ aws_auth: 'magic' }), /aws_auth must be one of/);
  });

  it('wires the resolved options into the AnthropicBedrock client', function() {
    const p = new AnthropicProvider({ api: 'Anthropic_Bedrock', model: 'm', aws_profile: 'example-sso', aws_region: 'eu-west-1' });
    assert.equal(p.bedrockAuthMode, 'profile');
    assert.equal(p.client.awsRegion, 'eu-west-1');
    assert.equal(p.client.awsAccessKey, null);
    assert.equal(typeof p.client.providerChainResolver, 'function');

    const d = new AnthropicProvider({ api: 'Anthropic_Bedrock', model: 'm', aws_region: 'eu-west-1' });
    assert.equal(d.bedrockAuthMode, 'default_chain');
    assert.equal(typeof d.client.providerChainResolver, 'function');
  });

  it('shares one cached credential provider across clients', async function() {
    const a = resolveBedrockClientOptions({ aws_region: 'us-east-1' });
    const b = resolveBedrockClientOptions({ aws_region: 'us-west-2' });
    const pa = await a.clientOptions.providerChainResolver();
    assert.equal(typeof pa, 'function');
    assert.equal(pa, await a.clientOptions.providerChainResolver());
    assert.equal(pa, await b.clientOptions.providerChainResolver());
    const p1 = await resolveBedrockClientOptions({ aws_profile: 'x' }).clientOptions.providerChainResolver();
    assert.equal(p1, await resolveBedrockClientOptions({ aws_profile: 'x' }).clientOptions.providerChainResolver());
    assert.notEqual(p1, pa);
  });

  it('default chain picks up ECS task-role credentials (loopback mocks, no AWS)', async function() {
    this.timeout(15000);
    const seen = { credsRequests: 0, authorization: null };

    const credsServer = http.createServer((req, res) => {
      seen.credsRequests += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        AccessKeyId: 'ASIAMOCKECSTASKROLE',
        SecretAccessKey: 'mock-secret',
        Token: 'mock-token',
        Expiration: new Date(Date.now() + 3600e3).toISOString()
      }));
    });
    const bedrockServer = http.createServer((req, res) => {
      seen.authorization = req.headers.authorization || null;
      req.resume();
      req.on('end', () => {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'mock bedrock: stop here' }));
      });
    });
    await new Promise(r => credsServer.listen(0, '127.0.0.1', r));
    await new Promise(r => bedrockServer.listen(0, '127.0.0.1', r));

    try {
      const nowhere = path.join(os.tmpdir(), 'charmd-test-no-such-aws-file');
      process.env.AWS_CONFIG_FILE = nowhere;
      process.env.AWS_SHARED_CREDENTIALS_FILE = nowhere;
      process.env.AWS_EC2_METADATA_DISABLED = 'true';
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${credsServer.address().port}/creds`;
      process.env.ANTHROPIC_BEDROCK_BASE_URL = `http://127.0.0.1:${bedrockServer.address().port}`;

      const provider = new AnthropicProvider({
        api: 'Anthropic_Bedrock', model: 'mock-model', model_type: 'chat', aws_region: 'us-east-1', temperature: null
      });
      assert.equal(provider.bedrockAuthMode, 'default_chain');
      const chat = provider.createChatModel();
      await assert.rejects(
        chat.extendTranscript(new TranscriptFragment([new Message('user', 'hello')]))
      );
      assert.ok(seen.credsRequests >= 1, 'container credentials endpoint was not queried');
      assert.match(String(seen.authorization), /Credential=ASIAMOCKECSTASKROLE\//);
    } finally {
      await new Promise(r => credsServer.close(r));
      await new Promise(r => bedrockServer.close(r));
    }
  });
});
