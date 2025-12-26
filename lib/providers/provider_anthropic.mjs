// file: provider_anthropic.mjs

import { ModelProvider } from './provider_base.mjs';
import { ChatModel } from '../chat-model-server.mjs';
import {
  Message,
  TranscriptFragment,
  ToolCall,
  ToolResponse,
  ImageAttachment,
  DocumentAttachment,
} from '../transcript.mjs';
import { ToolKind } from '../tool-definition.mjs';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

// Helper: parse data URLs for images
function parseDataUrl(dataUrl) {
  // For example: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..."
  const match = /^data:(?<mime>[^;]+);base64,(?<data>.+)$/.exec(dataUrl);
  if (!match) {
    // If it fails to parse, you can default to "image/png" or handle it differently.
    return {
      mediaType: 'image/png',
      base64Data: '',
    };
  }
  return {
    mediaType: match.groups.mime,
    base64Data: match.groups.data,
  };
}

/**
 * Validate a tool's format before sending to Anthropic.
 * (This is just a logger in this sample.)
 */
function validateToolFormat(tool) {
  console.log('Validating tool format:', {
    name: tool.name,
    hasDescription: !!tool.description,
    hasInputSchema: !!tool.input_schema,
    schemaType: tool.input_schema?.type,
    schemaProperties: Object.keys(tool.input_schema?.properties || {}),
  });
}

/**
 * Convert a single Message into Anthropic's "messages" format.
 * This function also handles images by converting data URLs
 * into {type:"image", source:{type:"base64", media_type, data}} blocks.
 */
function messageToAnthropic(message) {
  // 1) If it's a tool_call or tool_response, handle those first.
  if (message.role === 'tool_call') {
    // Convert each ToolCall into an array of text + "tool_use" blocks
    const anthropicToolCalls = [];
    for (const callPart of message.content) {
      if (callPart instanceof ToolCall) {
        const rationaleText = callPart.rationale
          ? `<thinking>${callPart.rationale}</thinking>`
          : `<thinking>Choosing the best tool.</thinking>`;

        // Add the rationale as a text block
        anthropicToolCalls.push({
          type: 'text',
          text: rationaleText,
        });

        // Then add the actual "tool_use" block
        anthropicToolCalls.push({
          type: 'tool_use',
          id: callPart.callId,
          name: callPart.toolName,
          input: callPart.arguments,
        });
      } else {
        // If for some reason there's a string or other content
        anthropicToolCalls.push({
          type: 'text',
          text: String(callPart),
        });
      }
    }
    return {
      role: 'assistant',
      content: anthropicToolCalls,
    };
  }

  if (message.role === 'tool_response') {
    // Convert each ToolResponse into an array of "tool_result" blocks
    const anthropicToolResponses = message.content
      .filter((resp) => resp instanceof ToolResponse)
      .map((resp) => {
        return {
          type: 'tool_result',
          tool_use_id: resp.callId,
          content: resp.response, // The result content
        };
      });

    return {
      role: 'user',
      content: anthropicToolResponses,
    };
  }

  // 2) For normal "user"/"assistant" roles, convert textual + image content
  const role = message.role === 'user' ? 'user' : 'assistant';

  // If it's a single string, just wrap in a text block
  if (typeof message.content === 'string') {
    return {
      role,
      content: [{ type: 'text', text: message.content }],
    };
  }

  // Otherwise, assume it's an array: each element could be text, images, docs, etc.
  if (Array.isArray(message.content)) {
    const contentBlocks = message.content.map((item) => {
      // If plain string
      if (typeof item === 'string') {
        return { type: 'text', text: item };
      }
      // If it's an image, parse out base64 data, etc.
      else if (item instanceof ImageAttachment) {
        const { mediaType, base64Data } = parseDataUrl(item.imageUrl);
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType || 'image/png',
            data: base64Data,
          },
        };
      }
      // If it's a DocumentAttachment, treat it as text
      else if (item instanceof DocumentAttachment) {
        return { type: 'text', text: item.markdownContent };
      }
      // Fallback: convert to text
      return { type: 'text', text: String(item) };
    });

    return {
      role,
      content: contentBlocks,
    };
  }

  // Fallback if content type is unexpected
  return {
    role,
    content: [{ type: 'text', text: String(message.content) }],
  };
}

// --------------------------------------------------------------------

/**
 * AnthropicProvider: implements createChatModel() to produce an AnthropicChatModel instance.
 */
export class AnthropicProvider extends ModelProvider {
  constructor(modelConfig) {
    super(modelConfig);

    if (modelConfig.api === 'Anthropic_Bedrock') {
      // AWS Bedrock backend
      this.client = new AnthropicBedrock({
        awsAccessKey: modelConfig.aws_access_key,
        awsSecretKey: modelConfig.aws_secret_key,
        awsRegion: modelConfig.aws_region,
      });
    } else {
      // Standard Anthropic API
      this.apiKey = modelConfig.api_key;
      this.client = new Anthropic({
        apiKey: this.apiKey,
      });
    }
  }

  createChatModel() {
    return new AnthropicChatModel(this, this.client, this.modelConfig);
  }

  /**
   * Count tokens using Anthropic's token counting API.
   * Falls back to local tiktoken approximation if API call fails.
   * @param {string} text - The text to count tokens in
   * @returns {Promise<number>} The token count
   * @see https://docs.anthropic.com/en/docs/build-with-claude/token-counting
   */
  async countTokens(text) {
    try {
      const response = await this.client.messages.countTokens({
        model: this.modelConfig.model,
        messages: [{ role: 'user', content: text }]
      });
      return response.input_tokens;
    } catch (err) {
      console.warn('[AnthropicProvider] Token counting API failed, using local approximation:', err.message);
      // Fallback to local tiktoken with cl100k_base
      const { countTokensLocal } = await import('../tokenizer.mjs');
      return countTokensLocal(text, 'cl100k_base');
    }
  }
}

/**
 * AnthropicChatModel: uses the Anthropic Messages API to handle transcripts.
 */
class AnthropicChatModel extends ChatModel {
  constructor(provider, client, modelConfig) {
    super(provider, client, modelConfig);
    this.model = modelConfig.model;
    this.maxTokens = modelConfig.max_tokens || 4096;
    this.isBedrock = modelConfig.api === 'Anthropic_Bedrock';
  }

  /**
   * Extend the conversation by sending prefix + suffix messages to Anthropic.
   *
   * We now accept a final parameter, which can be a boolean or
   * an object containing { stream?, response_format?, ... }.
   */
  async extendTranscript(prefix, callOnOutput = null, suffix = null, streamOrOptions = false) {
    // 1) Parse invocation options vs. old boolean usage.
    let stream = false;
    let invocationOptions = {};

    if (typeof streamOrOptions === 'boolean') {
      stream = streamOrOptions;
    } else if (streamOrOptions && typeof streamOrOptions === 'object') {
      stream = !!streamOrOptions.stream;
      invocationOptions = streamOrOptions;
    }

    // Bedrock requires streaming for operations that may take longer than 10 minutes
    // (e.g., Claude Haiku 4.5). Force streaming for all Bedrock requests.
    if (this.isBedrock) {
      stream = true;
    }

    // 2) Check for response_format (which we must ignore for Anthropic).
    if (invocationOptions.response_format) {
      console.log(
        '[AnthropicChatModel] WARNING: response_format was provided, but is not supported by Anthropic. Ignoring.'
      );
    }

    if (!suffix) {
      suffix = new TranscriptFragment([]);
    }

    // Convert existing transcripts to Anthropic's format
    const messages = [
      ...prefix.messages.map(messageToAnthropic),
      ...suffix.messages.map(messageToAnthropic),
    ];

    // If we have tools enabled, pass them along in the request:
    const tools = this.enabledTools && this.enabledTools.size > 0
      ? Array.from(this.enabledTools.values()).map((tool) => {
          validateToolFormat(tool);
          return {
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
          };
        })
      : undefined;

    console.log('Sending tools to Anthropic:', JSON.stringify(tools, null, 2));
    console.log('messages sent to anthropic:');
    console.log(JSON.stringify(messages, null, 2));

    try {
      // Make the request to Anthropic
      // Handle max_output_tokens override if provided
      const maxOut = invocationOptions.max_output_tokens;
      const maxTokens = (typeof maxOut === 'number' ? maxOut : this.maxTokens);

      let response;
      if (stream) {
        // For streaming, we need to collect the response from the stream
        response = await this._handleStreamingRequest({
          model: this.model,
          max_tokens: maxTokens,
          temperature: this.temperature,
          system: this.system,
          messages,
          tools,
        }, callOnOutput);
      } else {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: maxTokens,
          temperature: this.temperature,
          system: this.system,
          messages,
          tools,
          stream: false,
        });
      }

      // Check if the model made any tool calls
      const toolCalls = [];
      if (response.content) {
        let lastThinkingText = null;

        for (const part of response.content) {
          if (part.type === 'text') {
            // Possibly track "thinking" text if it includes <thinking>...
            if (part.text.includes('<thinking>')) {
              lastThinkingText = part.text;
            }
          } else if (part.type === 'tool_use') {
            // The model is requesting to use a tool
            const rationaleContent = lastThinkingText
              ? lastThinkingText.replace(/<\/?thinking>/g, '')
              : 'Deciding to use a tool.';

            toolCalls.push(
              new ToolCall(
                part.name,
                part.id,
                'function',
                part.input,
                rationaleContent
              )
            );

            // Reset
            lastThinkingText = null;
          }
        }
      }

      // If any tool calls were made, handle them with mixed-batch logic
      if (toolCalls.length > 0) {
        // Separate tool calls into server/MCP tools and client tools
        const serverCalls = [];
        const clientCalls = [];

        for (const tc of toolCalls) {
          const tool = this.enabledTools.get(tc.toolName);
          if (tool && tool.kind === ToolKind.CLIENT) {
            clientCalls.push(tc);
          } else {
            serverCalls.push(tc);
          }
        }

        let newSuffix = suffix;

        // Execute server/MCP tools first
        if (serverCalls.length > 0) {
          const serverToolCallMessage = new Message('tool_call', serverCalls);
          newSuffix = newSuffix.plus(serverToolCallMessage);
          const toolResponse = await this.runTools(serverToolCallMessage);
          newSuffix = newSuffix.plus(toolResponse);
        }

        // If there are client tools, stop recursion and return with pending client calls
        if (clientCalls.length > 0) {
          const clientToolCallMessage = new Message('tool_call', clientCalls);
          return newSuffix.plus(clientToolCallMessage);
        }

        // No client tools - recurse as normal with server tool results
        return this.extendTranscript(prefix, callOnOutput, newSuffix, streamOrOptions);
      }

      // Otherwise, gather up the plain text from the model's final output
      let fullReply = '';
      if (response.content) {
        for (const part of response.content) {
          if (part.type === 'text') {
            fullReply += part.text;
          }
        }
      }

      // If we have a callback for streaming tokens, call it (and not already done in streaming)
      if (callOnOutput && !tools && !stream) {
        callOnOutput(fullReply);
      }

      // Return a new TranscriptFragment containing the assistant's reply
      return suffix.plus(new Message('assistant', fullReply));
    } catch (error) {
      console.error('Anthropic API error:', error);
      throw error;
    }
  }

  /**
   * Handle a streaming request and return a response object that matches
   * the non-streaming format (with content array containing text and tool_use blocks).
   */
  async _handleStreamingRequest(requestParams, callOnOutput) {
    const stream = await this.client.messages.stream(requestParams);

    // Collect content blocks as they arrive
    const contentBlocks = [];
    let currentTextBlock = null;
    let currentToolUseBlock = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'text') {
          currentTextBlock = { type: 'text', text: '' };
        } else if (event.content_block.type === 'tool_use') {
          currentToolUseBlock = {
            type: 'tool_use',
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          if (currentTextBlock) {
            currentTextBlock.text += event.delta.text;
            // Call output callback for streaming text
            if (callOnOutput) {
              callOnOutput(event.delta.text);
            }
          }
        } else if (event.delta.type === 'input_json_delta') {
          // Tool use input comes as JSON deltas - accumulate them
          if (currentToolUseBlock && currentToolUseBlock._inputJson === undefined) {
            currentToolUseBlock._inputJson = '';
          }
          if (currentToolUseBlock) {
            currentToolUseBlock._inputJson += event.delta.partial_json;
          }
        }
      } else if (event.type === 'content_block_stop') {
        if (currentTextBlock) {
          contentBlocks.push(currentTextBlock);
          currentTextBlock = null;
        } else if (currentToolUseBlock) {
          // Parse the accumulated JSON input
          if (currentToolUseBlock._inputJson) {
            try {
              currentToolUseBlock.input = JSON.parse(currentToolUseBlock._inputJson);
            } catch (e) {
              console.error('Failed to parse tool input JSON:', e);
              currentToolUseBlock.input = {};
            }
            delete currentToolUseBlock._inputJson;
          }
          contentBlocks.push(currentToolUseBlock);
          currentToolUseBlock = null;
        }
      }
    }

    // Return a response object that matches the non-streaming format
    return {
      content: contentBlocks,
    };
  }
}

export default AnthropicProvider;
