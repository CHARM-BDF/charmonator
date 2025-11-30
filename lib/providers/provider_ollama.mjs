// File: provider_ollama.mjs

import { ModelProvider } from './provider_base.mjs';
import { ChatModel, Message, TranscriptFragment } from '../chat-model-server.mjs';
import { ToolCall, ToolResponse, ImageAttachment } from '../transcript.mjs';
import { Ollama } from 'ollama';

export class OllamaProvider extends ModelProvider {
  constructor(modelConfig) {
    super(modelConfig);
    this.host = modelConfig.host || 'http://127.0.0.1:11434';
    this.client = new Ollama({ host: this.host });
    this.model = modelConfig.model;
  }

  createChatModel() {
    return new OllamaChatModel(this, this.client, this.modelConfig);
  }

  async embed(text) {
    // TODO: Implement embedding
    throw new Error('embed() not implemented for OllamaProvider.');
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
          images.push(item.imageUrl);
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

    console.log('\n[OllamaChatModel.extendTranscript] Entered with prefix:\n', prefix);
    console.log('Suffix so far:\n', suffix);

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
    console.log(JSON.stringify(messagesToSend, null, 2));

    // 2) Build tool definitions for Ollama
    const tools = this._enabledToolsToOllama();
    console.log('[OllamaChatModel] Tools definition sent to Ollama:', JSON.stringify(tools, null, 2));

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

    // If a response_format is provided, Ollama calls that "format"
    if (invocationOptions.response_format) {
      // In Ollama, "format" can be "json" or a JSON schema object
      // If the model doesn't support it, we might warn
      // For minimal changes, we just pass it and let Ollama handle or error
      requestOptions.format = invocationOptions.response_format;

      // Alternatively, if you want to warn for certain older models:
      // console.warn(`Model "${this.model}" may not support 'response_format'. Passing anyway.`);
    }

    console.log('[OllamaChatModel] Sending request to Ollama:', JSON.stringify(requestOptions, null, 2));

    let mainResponse;
    let finalAssistantText = '';

    try {
      if (stream) {
        // Streaming
        const responseStream = await this.client.chat(requestOptions);
        let lastChunk = null;
        for await (const part of responseStream) {
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
        console.log('[OllamaChatModel] Received non-streamed response:', JSON.stringify(mainResponse, null, 2));
        if (mainResponse?.message?.content) {
          finalAssistantText = mainResponse.message.content;
        }
      }
    } catch (error) {
      console.error('[OllamaChatModel] Error calling Ollama:', error);
      throw error;
    }

    // 4) "Second pass" if non-streaming, to ensure we see any "tool_calls":
    let toolCalls = [];
    if (!stream) {
      try {
        const secondPass = await this.client.chat({
          ...requestOptions,
          stream: false // forcibly ensure we get a final JSON
        });
        console.log('[OllamaChatModel] "Second pass" response to detect tool calls:\n', secondPass);
        if (secondPass?.message?.tool_calls && Array.isArray(secondPass.message.tool_calls)) {
          toolCalls = secondPass.message.tool_calls;
          // If there's a text body, might differ slightly from first pass:
          if (secondPass.message.content) {
            finalAssistantText = secondPass.message.content;
          }
        }
      } catch (err) {
        console.warn('[OllamaChatModel] Could not do second pass for tool calls. Error:', err);
      }
    }

    // 5) If we found tool calls, run them
    if (toolCalls.length > 0) {
      // 5a) conditionally append the assistant text (only if it’s non-empty)
      if (finalAssistantText && finalAssistantText.trim() !== '') {
        suffix = suffix.plus(new Message('assistant', finalAssistantText));
      } else {
        console.log('[OllamaChatModel] Skipping empty assistant message that only held tool calls.');
      }

      for (const tcall of toolCalls) {
        const { name, arguments: argObj } = tcall.function ?? {};
        const callId = `call-${Date.now()}`;
        console.log('[OllamaChatModel] Building ToolCall for name:', name, 'with args:', argObj);

        const newToolCall = new ToolCall(name, callId, 'function', argObj);
        const toolCallMsg = new Message('tool_call', [newToolCall]);
        suffix = suffix.plus(toolCallMsg);

        console.log('[OllamaChatModel] Running the tool now...');
        const toolResponseMsg = await this.runTools(toolCallMsg);
        suffix = suffix.plus(toolResponseMsg);

        console.log('[OllamaChatModel] Tool responded with:\n', toolResponseMsg);
      }

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
