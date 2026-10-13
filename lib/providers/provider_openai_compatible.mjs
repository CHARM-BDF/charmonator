// file: lib/providers/provider_openai_compatible.mjs
//
// `api: "OpenAI_Compatible"`: a local (or self-hosted) server that speaks the OpenAI
// Chat Completions and Embeddings wire format -- LM Studio, llama.cpp's llama-server,
// mlx_lm.server / mlx_vlm.server, vLLM, Ollama's /v1, and the like.
//
// Why a separate api rather than `base_url` on `OpenAI`: the OpenAI provider sniffs
// model names (`o*` and `gpt-5*` lose temperature/stream and gain reasoning_effort;
// `o3*` loses max_tokens), sends the system prompt as role `developer`, and lets the
// SDK fall back to OPENAI_BASE_URL / OPENAI_API_KEY from the environment. Each of those
// is wrong for a local server (a local model named `olmo-...` would be treated as a
// reasoning model), and changing them on `OpenAI` would change main's behaviour. Here
// nothing is sniffed: per-server quirks are explicit config flags, and the only
// endpoint ever contacted is `base_url`. There is no fallback to any remote endpoint.
//
// Model-config fields (all optional except base_url and model):
//   base_url              e.g. "http://127.0.0.1:1234/v1" (required; ${ENV} interpolated)
//   api_key               default "not-needed"; ${ENV} interpolated (by getModelConfig)
//   model                 the server's model id
//   supports_json_schema  default true. false: send response_format json_object (or
//                         nothing, see json_fallback), put the schema in the prompt,
//                         and validate the reply here, re-asking on failure.
//   json_fallback         "json_object" (default) | "none" -- what to send when
//                         supports_json_schema is false.
//   json_fallback_attempts default 2: total tries for the prompt-only fallback.
//   send_strict           default true. false: drop json_schema.strict.
//   schema_in_prompt      default false. true: also state the schema in the last user
//                         message. Small models under grammar-constrained decoding can
//                         otherwise fill a string field until max_tokens.
//   max_tokens_param      "max_tokens" (default) | "max_completion_tokens" | "none"
//   max_tokens            default output cap when a request gives no max_output_tokens.
//   system_role           "system" (default) | "developer"
//   image_detail          omitted by default; "low" | "high" | "auto" if a server wants it.
//   extra_body            object merged into every chat request, e.g.
//                         {"chat_template_kwargs": {"enable_thinking": false}} or
//                         {"reasoning_effort": "low"}. Nothing OpenAI-only (reasoning,
//                         reasoning_effort, verbosity) is sent unless placed here.
//   strip_think           default true: drop a leading <think>...</think> block from
//                         replies of servers that inline reasoning in content.
//   embedding_dimensions  sent as `dimensions` on /embeddings when set.
//   local_only            true | "loopback": see lib/local-only.mjs.
//   ms_client_request_timeout, num_client_request_max_attempts: as for other models
//                         (default 600000 ms per call and 2 attempts).

import OpenAI from 'openai';
import { ModelProvider } from './provider_base.mjs';
import { OpenAIChatModel, messageToOpenAI } from './provider_openai.mjs';
import { Message, TranscriptFragment, ToolCall } from '../transcript.mjs';
import { ToolKind } from '../tool-definition.mjs';
import { withRetryLogging } from './openai_fetch.mjs';
import { interpolateEnvVars } from '../config.mjs';
import { validateAgainstSchema } from '../schema-validation.mjs';
import { assertModelLocalOnly, assertLocalImageUrl, localOnlyMode, LocalOnlyViolation } from '../local-only.mjs';
import { logContent } from '../log-safety.mjs';

export const DEFAULT_LOCAL_API_KEY = 'not-needed';

function isAbortLike(error, signal) {
  return Boolean(
    signal?.aborted
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.message === 'Request was aborted.'
    || error?.message === 'Client disconnected'
  );
}

/** Resolve the connection options; throws on a missing base_url (never defaults to a remote host). */
export function resolveCompatibleClientOptions(modelConfig) {
  const baseURL = interpolateEnvVars(modelConfig.base_url || '').trim().replace(/\/+$/, '');
  if (!baseURL) {
    throw new Error(`OpenAI_Compatible model "${modelConfig.model}" needs base_url (e.g. "http://127.0.0.1:1234/v1")`);
  }
  const apiKey = interpolateEnvVars(modelConfig.api_key || '').trim() || DEFAULT_LOCAL_API_KEY;
  return {
    baseURL,
    apiKey,
    // Retries are done by withRetryLogging, not the SDK.
    maxRetries: 0,
    timeout: Number(modelConfig.ms_client_request_timeout) || 600000
  };
}

/** Pull the JSON schema (if any) out of any response_format shape charmd accepts. */
export function schemaOfResponseFormat(rf) {
  if (!rf || typeof rf !== 'object') return null;
  if (rf.type === 'json_schema') return rf.json_schema?.schema ?? null;
  if (rf.type === 'json_object') return rf.schema ?? null;
  return null;
}

export function stripCodeFence(text) {
  return String(text ?? '').trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
}

export function stripThink(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
}

export function schemaInstruction(schema) {
  return 'Respond with only a single JSON value (no prose, no code fences) that conforms to this JSON Schema:\n'
    + JSON.stringify(schema);
}

function appendTextToLastUser(messages, text) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      messages[i] = { ...m, content: `${m.content}\n\n${text}` };
    } else if (Array.isArray(m.content)) {
      messages[i] = { ...m, content: [...m.content, { type: 'text', text }] };
    } else {
      messages[i] = { ...m, content: text };
    }
    return messages;
  }
  messages.push({ role: 'user', content: text });
  return messages;
}

export class OpenAICompatibleProvider extends ModelProvider {
  constructor(modelConfig) {
    super(modelConfig);
    this.model = modelConfig.model;
    this.clientOptions = resolveCompatibleClientOptions(modelConfig);
    // fetch is injectable for tests (modelConfig._fetch); defaults to the SDK's own.
    this.client = new OpenAI({
      ...this.clientOptions,
      ...(modelConfig._fetch ? { fetch: modelConfig._fetch } : {})
    });
  }

  createChatModel() {
    return new OpenAICompatibleChatModel(this, this.client, { ...this.modelConfig });
  }

  async embed(text) {
    await assertModelLocalOnly(this.modelConfig, this.model);
    const body = {
      model: this.model,
      input: text,
      // The SDK defaults to base64 and then decodes it; several local servers ignore
      // encoding_format and return floats, which the SDK would then mis-decode.
      encoding_format: 'float'
    };
    if (this.modelConfig.embedding_dimensions) {
      body.dimensions = Number(this.modelConfig.embedding_dimensions);
    }
    const response = await withRetryLogging(
      () => this.client.embeddings.create(body, { timeout: this.clientOptions.timeout }),
      { maxAttempts: Number(this.modelConfig.num_client_request_max_attempts) || 1 }
    );
    const vec = response?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) {
      throw new Error(`OpenAI_Compatible model "${this.model}" returned no embedding`);
    }
    return vec;
  }
}

export class OpenAICompatibleChatModel extends OpenAIChatModel {
  constructor(provider, client, modelConfig) {
    super(provider, client, modelConfig);
    this.model = modelConfig.model;
  }

  /**
   * Build the request body. Pure apart from reading this.* (exported shape is tested).
   * Returns { params, schema, fallback, wasTransformed }.
   */
  buildRequest(prefix, suffix, invocationOptions = {}, stream = false) {
    const mc = this.modelConfig;
    const systemRole = mc.system_role || 'system';
    const localOnly = localOnlyMode(mc);

    const convert = (m) => {
      // messageToOpenAI keeps only the first call/response of a batch; send them all.
      if (m.role === 'tool_call' && Array.isArray(m.content) && m.content.length > 1) {
        return [{
          role: 'assistant',
          content: null,
          tool_calls: m.content.map(tc => ({
            id: tc.callId, type: 'function',
            function: { name: tc.toolName, arguments: JSON.stringify(tc.arguments) }
          }))
        }];
      }
      if (m.role === 'tool_response' && Array.isArray(m.content) && m.content.length > 1) {
        return m.content.map(tr => ({
          role: 'tool',
          tool_call_id: tr.callId,
          content: typeof tr.response === 'object' ? JSON.stringify(tr.response) : tr.response
        }));
      }
      const out = messageToOpenAI(m);
      if (out.role === 'system' || out.role === 'developer') out.role = systemRole;
      if (Array.isArray(out.content)) {
        out.content = out.content.map(part => {
          if (part.type !== 'image_url') return part;
          if (localOnly) assertLocalImageUrl(part.image_url?.url, mc.model);
          const image_url = { url: part.image_url.url };
          if (mc.image_detail) image_url.detail = mc.image_detail;
          return { type: 'image_url', image_url };
        });
      }
      return [out];
    };

    let messages = [];
    if (this.system) messages.push({ role: systemRole, content: this.system });
    messages.push(...(prefix?.messages ?? []).flatMap(convert), ...(suffix?.messages ?? []).flatMap(convert));

    const params = { model: this.model, messages };
    if (this.temperature !== null && this.temperature !== undefined) {
      params.temperature = this.temperature;
    }
    if (stream) params.stream = true;

    if (this.enabledTools && this.enabledTools.size > 0) {
      params.tools = Array.from(this.enabledTools.values()).map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
      }));
    }

    const maxTokens = typeof invocationOptions.max_output_tokens === 'number'
      ? invocationOptions.max_output_tokens
      : (mc.max_tokens != null ? Number(mc.max_tokens) : null);
    const maxParam = mc.max_tokens_param || 'max_tokens';
    if (maxTokens != null && maxParam !== 'none') {
      params[maxParam] = maxTokens;
    }

    let schema = null;
    let fallback = false;
    let wasTransformed = false;
    const rf = invocationOptions.response_format;
    if (rf && typeof rf === 'object' && rf.type !== 'text') {
      // Normalize {type:"json_object", schema} to json_schema, then wrap non-object schemas.
      let normalized = rf;
      if (rf.type === 'json_object' && rf.schema) {
        normalized = { type: 'json_schema', json_schema: { name: 'response', schema: rf.schema } };
      }
      const t = this._transformResponseFormat(normalized);
      wasTransformed = t.wasTransformed;
      const finalFormat = t.transformedFormat;
      schema = schemaOfResponseFormat(finalFormat);

      if (finalFormat.type === 'json_schema' && mc.supports_json_schema !== false) {
        const js = { ...finalFormat.json_schema };
        if (!js.name) js.name = 'response';
        if (mc.send_strict === false) delete js.strict;
        params.response_format = { type: 'json_schema', json_schema: js };
        if (mc.schema_in_prompt && schema) appendTextToLastUser(params.messages, schemaInstruction(schema));
      } else if (finalFormat.type === 'json_schema' || finalFormat.type === 'json_object') {
        fallback = Boolean(schema);
        if ((mc.json_fallback || 'json_object') === 'json_object') {
          params.response_format = { type: 'json_object' };
        }
        if (schema) appendTextToLastUser(params.messages, schemaInstruction(schema));
      }
    }

    if (mc.extra_body && typeof mc.extra_body === 'object') {
      Object.assign(params, mc.extra_body);
    }

    return { params, schema, fallback, wasTransformed };
  }

  async _complete(params, invocationOptions) {
    const timeout = invocationOptions.ms_client_request_timeout || this.ms_client_request_timeout;
    const maxAttempts = invocationOptions.num_client_request_max_attempts || this.num_client_request_max_attempts || 1;
    const signal = invocationOptions.abort_signal;
    const call = () => this.client.chat.completions.create(params, { timeout, signal });
    const response = await withRetryLogging(call, { maxAttempts, abortSignal: signal });

    if (!params.stream) {
      const choice = response?.choices?.[0];
      if (!choice) return null;
      return { content: choice.message?.content ?? '', tool_calls: choice.message?.tool_calls ?? [] };
    }

    let content = '';
    const toolCalls = [];
    for await (const chunk of response) {
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        if (this._callOnOutput) this._callOnOutput(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? toolCalls.length;
        if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
    return { content, tool_calls: toolCalls.filter(Boolean) };
  }

  async extendTranscript(prefix, callOnOutput = null, suffix = null, streamOrOptions = false, depth = 0) {
    let stream = false;
    let invocationOptions = {};
    if (typeof streamOrOptions === 'boolean') {
      stream = streamOrOptions;
    } else if (streamOrOptions && typeof streamOrOptions === 'object') {
      stream = Boolean(streamOrOptions.stream);
      invocationOptions = { ...streamOrOptions };
    }
    if (!suffix) suffix = new TranscriptFragment([]);
    this._callOnOutput = stream ? callOnOutput : null;

    if (depth > 10) {
      console.warn('[OpenAICompatibleChatModel] Exceeded 10 tool-call rounds. Stopping.');
      return suffix;
    }

    try {
      await assertModelLocalOnly(this.modelConfig, this.model);
      const { params, schema, fallback, wasTransformed } = this.buildRequest(prefix, suffix, invocationOptions, stream);
      logContent('[OpenAICompatibleChatModel] request:', JSON.stringify(params));

      const attempts = fallback ? Math.max(1, Number(this.modelConfig.json_fallback_attempts ?? 2)) : 1;
      let reply = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        reply = await this._complete(params, invocationOptions);
        if (!reply) {
          // Defective (no choices): the caller's num_defective_reply_max_attempts retries.
          return suffix.plus(new Message('assistant', []));
        }
        if (!fallback || reply.tool_calls.length > 0) break;

        const text = stripCodeFence(this.modelConfig.strip_think === false ? reply.content : stripThink(reply.content));
        let errors;
        try {
          errors = validateAgainstSchema(JSON.parse(text), schema);
        } catch (err) {
          errors = [`reply is not valid JSON (${err?.name || 'Error'})`];
        }
        if (errors.length === 0) {
          reply.content = text;
          break;
        }
        console.log({ event: 'OpenAI_Compatible json fallback: reply failed schema validation', attempt, attempts, num_errors: errors.length });
        if (attempt < attempts) {
          params.messages = [
            ...params.messages,
            { role: 'assistant', content: reply.content ?? '' },
            {
              role: 'user',
              content: `That reply did not conform to the schema: ${JSON.stringify(errors).slice(0, 2000)}\n\n${schemaInstruction(schema)}`
            }
          ];
        }
      }

      if (reply.tool_calls.length > 0) {
        return await this._handleToolCalls(reply, prefix, callOnOutput, suffix, streamOrOptions, depth);
      }

      let content = reply.content ?? '';
      if (this.modelConfig.strip_think !== false) content = stripThink(content);
      if (schema || fallback) content = stripCodeFence(content);
      if (wasTransformed && content) {
        this._responseFormatWasTransformed = true;
        content = this._unwrapResponse(content);
      }
      if (!stream && callOnOutput) callOnOutput(content);
      return suffix.plus(new Message('assistant', content));
    } catch (error) {
      if (isAbortLike(error, invocationOptions.abort_signal)) throw error;
      const enhanced = this._enhanceError(error);
      enhanced.provider = 'openai_compatible';
      if (error instanceof LocalOnlyViolation) {
        enhanced.interpretedErrorType = 'local_only_violation';
        enhanced.interpretedCode = 403;
        enhanced.interpretedMessage = error.message;
      }
      throw enhanced;
    }
  }

  async _handleToolCalls(reply, prefix, callOnOutput, suffix, streamOrOptions, depth) {
    if (reply.content && reply.content.trim() !== '') {
      suffix = suffix.plus(new Message('assistant', reply.content));
    }
    const serverCalls = [];
    const clientCalls = [];
    for (const tc of reply.tool_calls) {
      const name = tc.function?.name;
      let args = tc.function?.arguments ?? {};
      if (typeof args === 'string') {
        try { args = args.trim() ? JSON.parse(args) : {}; } catch { args = { _raw: args }; }
      }
      const tool = this.enabledTools.get(name);
      if (!tool) throw new Error(`Function not found: ${name}`);
      const call = new ToolCall(name, tc.id || `call-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'function', args);
      (tool.kind === ToolKind.CLIENT ? clientCalls : serverCalls).push(call);
    }
    for (const call of serverCalls) {
      const callMsg = new Message('tool_call', [call]);
      suffix = suffix.plus(callMsg);
      suffix = suffix.plus(await this.runTools(callMsg));
    }
    if (clientCalls.length > 0) {
      return suffix.plus(new Message('tool_call', clientCalls));
    }
    return this.extendTranscript(prefix, callOnOutput, suffix, streamOrOptions, depth + 1);
  }
}

export default OpenAICompatibleProvider;
