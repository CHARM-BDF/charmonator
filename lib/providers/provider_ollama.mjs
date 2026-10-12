// File: provider_ollama.mjs

import { ModelProvider } from './provider_base.mjs';
import { ChatModel, Message, TranscriptFragment } from '../chat-model-server.mjs';
import { ToolCall, ToolResponse, ImageAttachment } from '../transcript.mjs';
import { ToolKind } from '../tool-definition.mjs';
import { Ollama } from 'ollama';
import nodeFetch from 'node-fetch';
import { Readable } from 'stream';
import { logContent } from '../log-safety.mjs';
import { interpolateEnvVars } from '../config.mjs';
import { assertModelLocalOnly, assertLocalImageUrl, localOnlyMode } from '../local-only.mjs';
import { schemaInstruction } from './provider_openai_compatible.mjs';

/**
 * A fetch for ollama-js with a configurable timeout. Node's global fetch (undici)
 * gives up after 300 s without response headers, and a non-streamed Ollama reply
 * sends no headers until generation ends, so a slow local model reading a dense
 * page fails at five minutes. node-fetch has no such cap; the timeout here is the
 * model's ms_client_request_timeout (default 600000). The response is re-wrapped
 * as a WHATWG Response because ollama-js reads streams with body.getReader().
 */
export function makeOllamaFetch(timeoutMs, baseFetch = nodeFetch) {
  return async (url, init = {}) => {
    const res = await baseFetch(url, { ...init, timeout: timeoutMs });
    const noBody = res.status === 204 || res.status === 304 || !res.body;
    const body = noBody ? null : (typeof res.body.getReader === 'function' ? res.body : Readable.toWeb(res.body));
    return new globalThis.Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()]
    });
  };
}

/**
 * Translate charmd's response_format (OpenAI-shaped) into Ollama's `format`:
 * a JSON schema object, or the string "json". On main the OpenAI object was passed
 * through unchanged, which Ollama treats as a (meaningless) schema.
 */
export function ollamaFormatOf(responseFormat) {
  const rf = responseFormat;
  if (!rf) return undefined;
  if (typeof rf === 'string') return rf;
  if (rf.type === 'json_schema') return rf.json_schema?.schema ?? 'json';
  if (rf.type === 'json_object') return rf.schema ?? 'json';
  if (rf.type === 'text') return undefined;
  return rf; // already a bare JSON schema
}

/**
 * Ollama wants raw base64 in `images`, not a data: URL. ollama-js passes strings
 * through untouched, so on main a data: URL reached Ollama verbatim and the image
 * was rejected. Non-data strings (paths, http URLs) are left as they were.
 */
export function ollamaImageOf(imageUrl) {
  if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
    const comma = imageUrl.indexOf(',');
    return comma >= 0 ? imageUrl.slice(comma + 1) : imageUrl;
  }
  return imageUrl;
}

export class OllamaProvider extends ModelProvider {
  constructor(modelConfig) {
    super(modelConfig);
    this.host = interpolateEnvVars(modelConfig.host) || 'http://127.0.0.1:11434';
    const timeoutMs = Number(modelConfig.ms_client_request_timeout) || 600000;
    this.client = new Ollama({
      host: this.host,
      fetch: makeOllamaFetch(timeoutMs, modelConfig._fetch || nodeFetch)
    });
    this.model = modelConfig.model;
  }

  createChatModel() {
    return new OllamaChatModel(this, this.client, this.modelConfig);
  }

  /** Embed one string via Ollama's /api/embed. */
  async embed(text) {
    await assertModelLocalOnly(this.modelConfig, this.model);
    const request = { model: this.model, input: text };
    if (this.modelConfig.keep_alive !== undefined) request.keep_alive = this.modelConfig.keep_alive;
    if (this.modelConfig.embedding_dimensions) request.dimensions = Number(this.modelConfig.embedding_dimensions);
    const response = await this.client.embed(request);
    const vec = response?.embeddings?.[0];
    if (!Array.isArray(vec)) {
      throw new Error(`Ollama model "${this.model}" returned no embedding`);
    }
    return vec;
  }
}

class OllamaChatModel extends ChatModel {
  constructor(provider, client, modelConfig) {
    super(provider, client, modelConfig);
    this.model = modelConfig.model;
  }

  /**
   * Convert an entire TranscriptFragment to Ollama’s messages array: { role, content, [images] }.
   */
  _transcriptToOllamaMessages(prefix, suffix) {
    const prefixMsgs = prefix?.messages ?? [];
    const suffixMsgs = suffix?.messages ?? [];
    const combined = [...prefixMsgs, ...suffixMsgs];

    return combined.map(m => this._toOllamaMessage(m));
  }

  /**
   * Convert a single Message to Ollama’s expected shape: { role, content, images }
   */
  _toOllamaMessage(msg) {
    // Map roles to the set Ollama expects
    let role = msg.role;
    if (!['system','user','assistant','tool','function'].includes(role)) {
      // Merge tool_call/tool_response into 'assistant' or 'function' as you see fit
      if (role === 'tool_call' || role === 'tool_response') {
        role = 'assistant';
      } else {
        role = 'user';
      }
    }

    let textChunks = [];
    let images = [];

    if (typeof msg.content === 'string') {
      textChunks.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (typeof item === 'string') {
          textChunks.push(item);
        } else if (item instanceof ImageAttachment) {
          if (localOnlyMode(this.modelConfig)) assertLocalImageUrl(item.imageUrl, this.model);
          images.push(ollamaImageOf(item.imageUrl));
        } else if (item instanceof ToolCall) {
          // You can store a textual representation if you want:
          textChunks.push(`[ToolCall: ${item.toolName}, arguments: ${JSON.stringify(item.arguments)}]`);
        } else if (item instanceof ToolResponse) {
          textChunks.push(`[ToolResponse from ${item.toolName}: ${item.response}]`);
        } else {
          textChunks.push(String(item));
        }
      }
    }

    const finalText = textChunks.join('\n');
    if (images.length > 0) {
      return { role, content: finalText, images };
    } else {
      return { role, content: finalText };
    }
  }

  /**
   * Convert enabled tools to Ollama’s "tools" array:
   *    [ { type: 'function', function: {...} }, ... ]
   */
  _enabledToolsToOllama() {
    const results = [];
    for (const [_, toolInstance] of this.enabledTools.entries()) {
      results.push({
        type: 'function',
        function: {
          name: toolInstance.name,
          description: toolInstance.description,
          parameters: toolInstance.input_schema
        }
      });
    }
    return results;
  }

  /**
   * Extend the conversation with a new suffix from the model.
   *
   * The final parameter can be a boolean (old usage for `stream`) or an object
   * containing ephemeral invocation-time options, e.g.:
   *   { stream?: boolean, response_format?: object, ... }
   */
  async extendTranscript(prefix, callOnOutput = null, suffix = null, streamOrOptions = false) {
    // Interpret the old `stream` param or the new `options` object:
    let stream = false;
    let invocationOptions = {};

    if (typeof streamOrOptions === 'boolean') {
      stream = streamOrOptions;
    } else if (streamOrOptions && typeof streamOrOptions === 'object') {
      stream = !!streamOrOptions.stream;
      invocationOptions = streamOrOptions;
    }

    if (!suffix) suffix = new TranscriptFragment([]);

    await assertModelLocalOnly(this.modelConfig, this.model);

    logContent('\n[OllamaChatModel.extendTranscript] Entered with prefix:\n', prefix);
    logContent('Suffix so far:\n', suffix);

    const finalSuffix = await this._multiStepLoop(prefix, suffix, callOnOutput, stream, invocationOptions);
    return finalSuffix;
  }

  /**
   * Loop until no more tool calls remain. (Tool calls can chain.)
   */
  async _multiStepLoop(prefix, suffix, callOnOutput, stream, invocationOptions, depth = 0) {
    if (depth > 10) {
      console.warn('OllamaChatModel: Exceeded 10 tool-call loops. Stopping.');
      return suffix;
    }

    // 1) Build request messages
    let messagesToSend = this._transcriptToOllamaMessages(prefix, suffix);

    // Prepend system message if set
    if (this.system) {
      messagesToSend = [{ role: 'system', content: this.system }, ...messagesToSend];
    }
    console.log(`[OllamaChatModel] Step #${depth}. Building request to Ollama with messages:`);
    logContent(JSON.stringify(messagesToSend, null, 2));

    // 2) Build tool definitions for Ollama
    const tools = this._enabledToolsToOllama();
    logContent('[OllamaChatModel] Tools definition sent to Ollama:', JSON.stringify(tools, null, 2));

    // 3) Build request object
    const requestOptions = {
      model: this.model,
      messages: messagesToSend,
      stream: Boolean(stream),
      tools,
      options: {
        temperature: this.temperature ?? 0.8
      }
    };

    // Optional model-config knobs (absent: main's request shape).
    const mc = this.modelConfig;
    if (mc.num_ctx != null) requestOptions.options.num_ctx = Number(mc.num_ctx);
    // num_predict comes from the model config only. A request's max_output_tokens is
    // ignored here, as on main (summaries pass a token *target* there, which as a hard
    // cap would truncate Ollama summaries that main lets run to completion).
    if (mc.max_tokens != null) requestOptions.options.num_predict = Number(mc.max_tokens);
    if (mc.ollama_options && typeof mc.ollama_options === 'object') {
      Object.assign(requestOptions.options, mc.ollama_options);
    }
    if (mc.think !== undefined) requestOptions.think = mc.think;
    if (mc.keep_alive !== undefined) requestOptions.keep_alive = mc.keep_alive;

    // response_format (OpenAI-shaped) becomes Ollama's "format": a schema or "json".
    const format = ollamaFormatOf(invocationOptions.response_format);
    if (format !== undefined) {
      requestOptions.format = format;
      // Opt-in: Ollama recommends also stating the schema in the prompt; without it,
      // small models under the format grammar can fill a string until num_predict.
      if (mc.schema_in_prompt && format && typeof format === 'object') {
        const lastUser = requestOptions.messages.map(m => m.role).lastIndexOf('user');
        if (lastUser >= 0) {
          const m = requestOptions.messages[lastUser];
          requestOptions.messages[lastUser] = { ...m, content: `${m.content}\n\n${schemaInstruction(format)}` };
        }
      }
    }

    logContent('[OllamaChatModel] Sending request to Ollama:', JSON.stringify(requestOptions, null, 2));

    let mainResponse;
    let finalAssistantText = '';

    try {
      if (stream) {
        // Streaming
        const responseStream = await this.client.chat(requestOptions);
        let lastChunk = null;
        this._streamedToolCalls = [];
        for await (const part of responseStream) {
          if (Array.isArray(part?.message?.tool_calls)) {
            this._streamedToolCalls.push(...part.message.tool_calls);
          }
          if (part?.message?.content) {
            lastChunk = part.message.content;
            finalAssistantText += lastChunk;
            if (callOnOutput) callOnOutput(lastChunk);
          }
          if (part.done) {
            console.log('[OllamaChatModel] Streaming ended. Stats:', {
              total_duration: part.total_duration,
              eval_count: part.eval_count,
              eval_duration: part.eval_duration
            });
          }
        }
        // We do not get the full final object with tool_calls in streaming mode,
        // so we may do a second pass if you want. For brevity, we skip it here.
      } else {
        // Non-streaming => a single final response
        mainResponse = await this.client.chat(requestOptions);
        logContent('[OllamaChatModel] Received non-streamed response:', JSON.stringify(mainResponse, null, 2));
        if (mainResponse?.message?.content) {
          finalAssistantText = mainResponse.message.content;
        }
      }
    } catch (error) {
      console.error('[OllamaChatModel] Error calling Ollama:', error);
      throw error;
    }

    // 4) Tool calls. Non-streaming: they are on the one response (main issued the
    //    same request a second time just to read them, doubling every call).
    //    Streaming: collected from the chunks.
    let toolCalls = [];
    if (!stream && Array.isArray(mainResponse?.message?.tool_calls)) {
      toolCalls = mainResponse.message.tool_calls;
    } else if (stream && Array.isArray(this._streamedToolCalls)) {
      toolCalls = this._streamedToolCalls;
    }

    // 5) If we found tool calls, handle them with mixed-batch logic
    if (toolCalls.length > 0) {
      // 5a) conditionally append the assistant text (only if it's non-empty)
      if (finalAssistantText && finalAssistantText.trim() !== '') {
        suffix = suffix.plus(new Message('assistant', finalAssistantText));
      } else {
        console.log('[OllamaChatModel] Skipping empty assistant message that only held tool calls.');
      }

      // Separate tool calls into server/MCP and client tools
      const serverCalls = [];
      const clientCalls = [];

      for (const tcall of toolCalls) {
        const { name, arguments: argObj } = tcall.function ?? {};
        const tool = this.enabledTools.get(name);
        const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const newToolCall = new ToolCall(name, callId, 'function', argObj);

        if (tool && tool.kind === ToolKind.CLIENT) {
          clientCalls.push(newToolCall);
        } else {
          serverCalls.push(newToolCall);
        }
      }

      // Execute server/MCP tools first
      for (const tc of serverCalls) {
        logContent('[OllamaChatModel] Building ToolCall for name:', tc.toolName, 'with args:', tc.arguments);
        const toolCallMsg = new Message('tool_call', [tc]);
        suffix = suffix.plus(toolCallMsg);

        console.log('[OllamaChatModel] Running the server tool now...');
        const toolResponseMsg = await this.runTools(toolCallMsg);
        suffix = suffix.plus(toolResponseMsg);

        logContent('[OllamaChatModel] Tool responded with:\n', toolResponseMsg);
      }

      // If there are client tools, stop and return with pending client calls
      if (clientCalls.length > 0) {
        console.log('[OllamaChatModel] Client tools detected. Stopping recursion to let client handle.');
        const clientToolCallMsg = new Message('tool_call', clientCalls);
        return suffix.plus(clientToolCallMsg);
      }

      // No client tools - recurse as normal
      console.log(`[OllamaChatModel] Tools were called. Re-invoking _multiStepLoop with depth=${depth + 1}...`);
      return this._multiStepLoop(prefix, suffix, callOnOutput, stream, invocationOptions, depth + 1);
    }

    // If no further tool calls:
    if (stream) {
      // In streaming mode, we've already appended text as we streamed (if you do partial).
      // But if we want to store it in the final suffix:
      if (finalAssistantText && finalAssistantText.trim() !== '') {
        suffix = suffix.plus(new Message('assistant', finalAssistantText));
      }
    } else {
      // Non-streaming => only now do we finalize the assistant text.
      if (finalAssistantText && finalAssistantText.trim() !== '') {
        suffix = suffix.plus(new Message('assistant', finalAssistantText));
      }
    }

    console.log(`[OllamaChatModel] Done. No further tool calls at depth=${depth}. Returning suffix.`);
    return suffix;
  }
}

export default OllamaProvider;
