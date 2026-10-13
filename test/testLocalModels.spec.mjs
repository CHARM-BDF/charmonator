// Local-model backends: `api: "OpenAI_Compatible"` (LM Studio, llama.cpp, MLX, vLLM,
// Ollama /v1), the Ollama provider's images/format/embeddings, and the `local_only`
// guard. Every model server here is a loopback mock that records the requests it gets;
// nothing leaves the machine.

import { strict as assert } from 'assert';
import http from 'http';
import { spawnSync } from 'child_process';
import { TranscriptFragment, Message, ImageAttachment } from '../lib/transcript.mjs';
import {
  OpenAICompatibleProvider,
  resolveCompatibleClientOptions,
  stripThink
} from '../lib/providers/provider_openai_compatible.mjs';
import { OllamaProvider, ollamaFormatOf, ollamaImageOf } from '../lib/providers/provider_ollama.mjs';
import {
  classifyAddress,
  checkLocalEndpoint,
  checkConfigLocalOnly,
  assertModelLocalOnly,
  LocalOnlyViolation
} from '../lib/local-only.mjs';

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=';
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false
};

/** A loopback server: `replies` is a queue of (req) => body objects, one per request. */
async function startMock() {
  const state = { requests: [], replies: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const rec = { method: req.method, url: req.url, headers: req.headers, body };
      state.requests.push(rec);
      const next = state.replies.shift();
      const out = typeof next === 'function' ? next(rec) : next;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out ?? {}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  state.base = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise(r => server.close(r));
  return state;
}

const chatReply = (content, extra = {}) => ({
  id: 'x', object: 'chat.completion', created: 0, model: 'm',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, ...extra } }]
});

function compat(mock, overrides = {}) {
  return new OpenAICompatibleProvider({
    api: 'OpenAI_Compatible',
    model_type: 'chat',
    base_url: `${mock.base}/v1`,
    model: 'local-model',
    system: 'You are terse.',
    temperature: 0.2,
    num_client_request_max_attempts: 1,
    ms_client_request_timeout: 5000,
    ...overrides
  });
}

const userText = (t) => new TranscriptFragment([new Message('user', t)]);

describe('OpenAI_Compatible provider', function() {
  this.timeout(10000);
  let mock;
  beforeEach(async () => { mock = await startMock(); });
  afterEach(async () => { await mock.close(); });

  it('sends a plain chat with role "system", a dummy key, and no OpenAI-only params', async function() {
    mock.replies.push(chatReply('hello'));
    // A model name starting with "o" must not be treated as an OpenAI reasoning model.
    const chat = compat(mock, { model: 'olmo-2-7b' }).createChatModel();
    const suffix = await chat.extendTranscript(userText('hi'), null, null, {});
    assert.equal(suffix.messages[0].content, 'hello');

    const [r] = mock.requests;
    assert.equal(r.url, '/v1/chat/completions');
    assert.equal(r.headers.authorization, 'Bearer not-needed');
    assert.deepEqual(r.body, {
      model: 'olmo-2-7b',
      messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'hi' }],
      temperature: 0.2
    });
  });

  it('interpolates ${ENV} in base_url and api_key, and refuses a missing base_url', function() {
    process.env.CHARMD_TEST_LOCAL_KEY = 'k-123';
    process.env.CHARMD_TEST_LOCAL_URL = 'http://127.0.0.1:1234/v1/';
    try {
      const o = resolveCompatibleClientOptions({ base_url: '${CHARMD_TEST_LOCAL_URL}', api_key: '${CHARMD_TEST_LOCAL_KEY}' });
      assert.equal(o.baseURL, 'http://127.0.0.1:1234/v1');
      assert.equal(o.apiKey, 'k-123');
      assert.equal(o.maxRetries, 0);
      assert.equal(resolveCompatibleClientOptions({ base_url: 'http://x/v1', api_key: '${CHARMD_TEST_UNSET_VAR}' }).apiKey, 'not-needed');
    } finally {
      delete process.env.CHARMD_TEST_LOCAL_KEY;
      delete process.env.CHARMD_TEST_LOCAL_URL;
    }
    assert.throws(() => resolveCompatibleClientOptions({ model: 'm' }), /needs base_url/);
  });

  it('sends images as data URLs, with detail only when image_detail is set', async function() {
    mock.replies.push(chatReply('{"markdown":"x","isFirstPage":true}'));
    mock.replies.push(chatReply('ok'));
    const t = new TranscriptFragment([
      new Message('system', 'Transcribe.'),
      new Message('user', ['Read this.', new ImageAttachment(IMG)])
    ]);
    await compat(mock, { system: undefined }).createChatModel().extendTranscript(t);
    await compat(mock, { system: undefined, image_detail: 'high' }).createChatModel().extendTranscript(t);

    assert.deepEqual(mock.requests[0].body.messages, [
      { role: 'system', content: 'Transcribe.' },
      { role: 'user', content: [{ type: 'text', text: 'Read this.' }, { type: 'image_url', image_url: { url: IMG } }] }
    ]);
    assert.deepEqual(mock.requests[1].body.messages[1].content[1], { type: 'image_url', image_url: { url: IMG, detail: 'high' } });
  });

  it('passes json_schema through (name defaulted), and drops strict when send_strict is false', async function() {
    mock.replies.push(chatReply('{"answer":"a"}'), chatReply('{"answer":"b"}'));
    const rf = { type: 'json_schema', json_schema: { schema: SCHEMA, strict: true } };
    await compat(mock).createChatModel().extendTranscript(userText('q'), null, null, { response_format: rf });
    await compat(mock, { send_strict: false }).createChatModel().extendTranscript(userText('q'), null, null, { response_format: rf });
    assert.deepEqual(mock.requests[0].body.response_format,
      { type: 'json_schema', json_schema: { name: 'response', schema: SCHEMA, strict: true } });
    assert.deepEqual(mock.requests[1].body.response_format,
      { type: 'json_schema', json_schema: { name: 'response', schema: SCHEMA } });
  });

  it('falls back to json_object + schema-in-prompt + validation when supports_json_schema is false', async function() {
    mock.replies.push(chatReply('Sure! {"wrong": 1}'), chatReply('```json\n{"answer":"42"}\n```'));
    const chat = compat(mock, { supports_json_schema: false }).createChatModel();
    const rf = { type: 'json_schema', json_schema: { name: 'a', schema: SCHEMA, strict: true } };
    const suffix = await chat.extendTranscript(userText('q'), null, null, { response_format: rf });

    assert.equal(suffix.messages[0].content, '{"answer":"42"}');
    assert.equal(mock.requests.length, 2);
    const [first, second] = mock.requests.map(r => r.body);
    assert.deepEqual(first.response_format, { type: 'json_object' });
    assert.match(first.messages[1].content, /^q\n\nRespond with only a single JSON value/);
    assert.ok(first.messages[1].content.includes(JSON.stringify(SCHEMA)));
    // The retry carries the bad reply and the validation errors.
    assert.equal(second.messages.length, 4);
    assert.equal(second.messages[2].role, 'assistant');
    assert.match(second.messages[3].content, /did not conform to the schema/);
  });

  it('states the schema in the prompt alongside json_schema with schema_in_prompt', async function() {
    mock.replies.push(chatReply('{"answer":"a"}'));
    await compat(mock, { schema_in_prompt: true }).createChatModel().extendTranscript(userText('q'), null, null, {
      response_format: { type: 'json_schema', json_schema: { name: 'a', schema: SCHEMA } }
    });
    const b = mock.requests[0].body;
    assert.equal(b.response_format.type, 'json_schema');
    assert.match(b.messages[1].content, /^q\n\nRespond with only a single JSON value/);
  });

  it('sends no response_format at all with json_fallback "none"', async function() {
    mock.replies.push(chatReply('{"answer":"x"}'));
    const chat = compat(mock, { supports_json_schema: false, json_fallback: 'none' }).createChatModel();
    await chat.extendTranscript(userText('q'), null, null, { response_format: { type: 'json_schema', json_schema: { name: 'a', schema: SCHEMA } } });
    assert.equal(mock.requests[0].body.response_format, undefined);
    assert.match(mock.requests[0].body.messages[1].content, /JSON Schema/);
  });

  it('honours max_tokens_param, system_role, extra_body and a null temperature', async function() {
    for (let i = 0; i < 4; i++) mock.replies.push(chatReply('ok'));
    const opts = { max_output_tokens: 99 };
    await compat(mock).createChatModel().extendTranscript(userText('q'), null, null, opts);
    await compat(mock, { max_tokens_param: 'max_completion_tokens', system_role: 'developer' })
      .createChatModel().extendTranscript(userText('q'), null, null, opts);
    await compat(mock, { max_tokens_param: 'none', temperature: null }).createChatModel().extendTranscript(userText('q'), null, null, opts);
    await compat(mock, { max_tokens: 512, extra_body: { chat_template_kwargs: { enable_thinking: false }, top_k: 20 } })
      .createChatModel().extendTranscript(userText('q'));

    const b = mock.requests.map(r => r.body);
    assert.equal(b[0].max_tokens, 99);
    assert.equal(b[1].max_completion_tokens, 99);
    assert.equal(b[1].max_tokens, undefined);
    assert.equal(b[1].messages[0].role, 'developer');
    assert.equal(b[2].max_tokens, undefined);
    assert.equal(b[2].temperature, undefined);
    assert.equal(b[3].max_tokens, 512);
    assert.deepEqual(b[3].chat_template_kwargs, { enable_thinking: false });
    assert.equal(b[3].top_k, 20);
    for (const body of b) {
      for (const k of ['reasoning', 'reasoning_effort', 'verbosity', 'stream']) assert.equal(body[k], undefined, k);
    }
  });

  it('strips an inline <think> block unless strip_think is false', async function() {
    mock.replies.push(chatReply('<think>hmm</think>\n\nanswer'), chatReply('<think>hmm</think>answer'));
    const a = await compat(mock).createChatModel().extendTranscript(userText('q'));
    const b = await compat(mock, { strip_think: false }).createChatModel().extendTranscript(userText('q'));
    assert.equal(a.messages[0].content, 'answer');
    assert.equal(b.messages[0].content, '<think>hmm</think>answer');
    assert.equal(stripThink('no think'), 'no think');
  });

  it('wraps a non-object schema and unwraps the reply', async function() {
    mock.replies.push(chatReply('{"result":["a","b"]}'));
    const arraySchema = { type: 'array', items: { type: 'string' } };
    const s = await compat(mock).createChatModel().extendTranscript(userText('q'), null, null, {
      response_format: { type: 'json_schema', json_schema: { name: 'list', schema: arraySchema } }
    });
    assert.equal(mock.requests[0].body.response_format.json_schema.schema.properties.result.type, 'array');
    assert.equal(s.messages[0].content, '["a","b"]');
  });

  it('embeds via /v1/embeddings with encoding_format "float"', async function() {
    mock.replies.push({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, -0.2, 0.3] }], model: 'e' });
    const v = await compat(mock, { model: 'nomic-embed', model_type: 'embedding' }).embed('Seizure');
    assert.deepEqual(v, [0.1, -0.2, 0.3]);
    assert.equal(mock.requests[0].url, '/v1/embeddings');
    assert.deepEqual(mock.requests[0].body, { model: 'nomic-embed', input: 'Seizure', encoding_format: 'float' });
  });
});

describe('Ollama provider (images, format, embeddings)', function() {
  this.timeout(10000);
  let mock;
  beforeEach(async () => { mock = await startMock(); });
  afterEach(async () => { await mock.close(); });

  const ollamaReply = (content, extra = {}) => ({
    model: 'm', created_at: '2026-01-01T00:00:00Z', done: true,
    message: { role: 'assistant', content, ...extra }
  });
  const ollama = (overrides = {}) => new OllamaProvider({
    api: 'ollama', model_type: 'chat', host: mock.base, model: 'qwen3-vl:8b', temperature: 0, ...overrides
  });

  it('translates helpers: data URL to base64, response_format to format', function() {
    assert.equal(ollamaImageOf('data:image/png;base64,QUJD'), 'QUJD');
    assert.equal(ollamaImageOf('QUJD'), 'QUJD');
    assert.deepEqual(ollamaFormatOf({ type: 'json_schema', json_schema: { name: 'x', schema: SCHEMA } }), SCHEMA);
    assert.equal(ollamaFormatOf({ type: 'json_object' }), 'json');
    assert.equal(ollamaFormatOf('json'), 'json');
    assert.equal(ollamaFormatOf(undefined), undefined);
  });

  it('sends raw base64 images and a schema format, in one request', async function() {
    mock.replies.push(ollamaReply('{"answer":"a"}'));
    const t = new TranscriptFragment([new Message('user', ['Read this.', new ImageAttachment(IMG)])]);
    const s = await ollama({ system: 'sys' }).createChatModel().extendTranscript(t, null, null, {
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema: SCHEMA } }
    });
    assert.equal(s.messages[0].content, '{"answer":"a"}');
    assert.equal(mock.requests.length, 1, 'no second pass');
    const b = mock.requests[0].body;
    assert.equal(mock.requests[0].url, '/api/chat');
    assert.deepEqual(b.messages[1], { role: 'user', content: 'Read this.', images: [IMG.split(',')[1]] });
    assert.deepEqual(b.format, SCHEMA);
    assert.deepEqual(b.options, { temperature: 0 });
    for (const k of ['think', 'keep_alive']) assert.equal(b[k], undefined);
  });

  it('adds num_ctx, num_predict, think, keep_alive only when configured', async function() {
    mock.replies.push(ollamaReply('ok'));
    mock.replies.push(ollamaReply('ok'));
    await ollama({ num_ctx: 16384, max_tokens: 4096, think: false, keep_alive: '10m', ollama_options: { top_k: 20 } })
      .createChatModel().extendTranscript(userText('q'), null, null, { max_output_tokens: 300 });
    // max_output_tokens alone is ignored, as on main.
    await ollama().createChatModel().extendTranscript(userText('q'), null, null, { max_output_tokens: 300 });
    const b = mock.requests[0].body;
    assert.deepEqual(b.options, { temperature: 0, num_ctx: 16384, num_predict: 4096, top_k: 20 });
    assert.deepEqual(mock.requests[1].body.options, { temperature: 0 });
    assert.equal(b.think, false);
    assert.equal(b.keep_alive, '10m');
  });

  it('states the schema in the prompt only with schema_in_prompt', async function() {
    mock.replies.push(ollamaReply('{"answer":"a"}'), ollamaReply('{"answer":"a"}'));
    const rf = { type: 'json_schema', json_schema: { name: 'x', schema: SCHEMA } };
    await ollama().createChatModel().extendTranscript(userText('q'), null, null, { response_format: rf });
    await ollama({ schema_in_prompt: true }).createChatModel().extendTranscript(userText('q'), null, null, { response_format: rf });
    assert.equal(mock.requests[0].body.messages.at(-1).content, 'q');
    assert.match(mock.requests[1].body.messages.at(-1).content, /^q\n\nRespond with only a single JSON value/);
    assert.deepEqual(mock.requests[1].body.format, SCHEMA);
  });

  it('embeds via /api/embed', async function() {
    mock.replies.push({ model: 'qwen3-embedding', embeddings: [[0.5, 0.25]] });
    const v = await ollama({ model: 'qwen3-embedding', model_type: 'embedding' }).embed('Ataxia');
    assert.deepEqual(v, [0.5, 0.25]);
    assert.equal(mock.requests[0].url, '/api/embed');
    assert.deepEqual(mock.requests[0].body, { model: 'qwen3-embedding', input: 'Ataxia' });
  });
});

describe('local_only guard', function() {
  this.timeout(10000);

  it('classifies addresses', function() {
    for (const a of ['127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1']) assert.equal(classifyAddress(a), 'loopback', a);
    for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.1.1', '100.100.1.1', 'fd12::1', 'fe80::1']) {
      assert.equal(classifyAddress(a), 'private', a);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::8888', 'not-an-ip']) assert.equal(classifyAddress(a), 'public', a);
  });

  it('checks endpoints, resolving hostnames and requiring every address to qualify', async function() {
    assert.equal((await checkLocalEndpoint('http://127.0.0.1:1234/v1')).ok, true);
    assert.equal((await checkLocalEndpoint('http://192.168.1.9:8080/v1')).ok, true);
    assert.equal((await checkLocalEndpoint('http://192.168.1.9:8080/v1', 'loopback')).ok, false);
    assert.equal((await checkLocalEndpoint('https://8.8.8.8/v1')).ok, false);
    const lookup = async () => [{ address: '127.0.0.1' }, { address: '93.184.216.34' }];
    const r = await checkLocalEndpoint('http://sneaky.example/v1', 'private', { lookup });
    assert.equal(r.ok, false);
    assert.match(r.reason, /93\.184\.216\.34/);
    const local = async () => [{ address: '::1' }, { address: '127.0.0.1' }];
    assert.equal((await checkLocalEndpoint('http://localhost:1234/v1', 'loopback', { lookup: local })).ok, true);
  });

  it('refuses cloud APIs and non-local endpoints, and reports per model', async function() {
    await assert.rejects(assertModelLocalOnly({ api: 'OpenAI', model: 'gpt-4o', local_only: true }), LocalOnlyViolation);
    await assert.rejects(assertModelLocalOnly({ api: 'OpenAI_Compatible', base_url: 'http://8.8.8.8/v1', local_only: true }), /refused/);
    assert.equal(await assertModelLocalOnly({ api: 'OpenAI', model: 'gpt-4o' }), null, 'no local_only, no check');
    const r = await checkConfigLocalOnly({
      models: {
        a: { api: 'ollama', host: 'http://127.0.0.1:11434', local_only: true },
        b: { api: 'OpenAI_Compatible', base_url: 'http://8.8.8.8/v1', local_only: 'loopback' },
        c: { api: 'OpenAI', model: 'gpt-4o' },
        alias: 'a'
      }
    });
    assert.equal(r.ok, false);
    assert.deepEqual(Object.keys(r.models), ['a', 'b']);
    assert.equal(r.models.a.ok, true);
    assert.equal(r.models.b.ok, false);
  });

  it('refuses to call a non-local endpoint, and makes no request', async function() {
    const mock = await startMock();
    try {
      const p = new OpenAICompatibleProvider({
        api: 'OpenAI_Compatible', base_url: 'http://8.8.8.8:9/v1', model: 'm', local_only: true,
        num_client_request_max_attempts: 1, ms_client_request_timeout: 1000
      });
      await assert.rejects(p.createChatModel().extendTranscript(userText('q')), (err) => {
        assert.equal(err.interpretedErrorType, 'local_only_violation');
        assert.equal(err.interpretedCode, 403);
        assert.match(err.interpretedMessage, /local_only model "m" refused/);
        return true;
      });
      await assert.rejects(p.embed('x'), LocalOnlyViolation);
      const o = new OllamaProvider({ api: 'ollama', host: 'http://8.8.8.8:9', model: 'm', local_only: true });
      await assert.rejects(o.createChatModel().extendTranscript(userText('q')), LocalOnlyViolation);
      await assert.rejects(o.embed('x'), LocalOnlyViolation);
    } finally {
      await mock.close();
    }
  });

  it('refuses remote image URLs under local_only, for both providers', async function() {
    const mock = await startMock();
    try {
      const t = new TranscriptFragment([new Message('user', ['x', new ImageAttachment('https://example.org/a.png')])]);
      const p = compat(mock, { local_only: true });
      await assert.rejects(p.createChatModel().extendTranscript(t), /images must be data: URLs/);
      const o = new OllamaProvider({ api: 'ollama', host: mock.base, model: 'm', local_only: true });
      await assert.rejects(o.createChatModel().extendTranscript(t), /images must be data: URLs/);
      assert.equal(mock.requests.length, 0);
    } finally {
      await mock.close();
    }
  });

  it('allows a loopback local_only model through to the server', async function() {
    const mock = await startMock();
    try {
      mock.replies.push(chatReply('fine'));
      const s = await compat(mock, { local_only: 'loopback' }).createChatModel().extendTranscript(userText('q'));
      assert.equal(s.messages[0].content, 'fine');
    } finally {
      await mock.close();
    }
  });

  it('server refuses to start when a local_only model is not local', function() {
    const cfg = {
      server: { port: 5999 },
      models: { leaky: { api: 'OpenAI_Compatible', base_url: 'http://8.8.8.8/v1', model: 'm', local_only: true } }
    };
    const out = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const { createAndStart } = await import('./lib/server.mjs'); await createAndStart();"
    ], {
      env: { ...process.env, CHARMONATOR_CONFIG: '/nonexistent.json', CHARMONATOR_CONFIG_JSON: JSON.stringify(cfg) },
      encoding: 'utf8',
      timeout: 20000
    });
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout + out.stderr, /local_only check failed: leaky/);
  });
});
