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
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

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
 * Supports both standard Anthropic API and Vertex AI (Google Cloud).
 */
export class AnthropicProvider extends ModelProvider {
  constructor(modelConfig) {
    super(modelConfig);
    
    // Determine whether to use Vertex AI or standard Anthropic
    if (modelConfig.google_cloud_project) {
      // Use Vertex AI via Google Cloud
      this.useVertex = true;
      this.projectId = modelConfig.google_cloud_project;
      this.region = modelConfig.google_cloud_region || 'us-east5';
      
      this.client = new AnthropicVertex({
        projectId: this.projectId,
        region: this.region,
      });
      
      console.log(`Using Anthropic Vertex AI with project: ${this.projectId}, region: ${this.region}`);
    } else {
      // Use standard Anthropic API
      this.useVertex = false;
      this.apiKey = modelConfig.api_key;
      
      this.client = new Anthropic({
        apiKey: this.apiKey,
      });
      
      console.log('Using standard Anthropic API');
    }
  }

  createChatModel() {
    return new AnthropicChatModel(this, this.client, this.modelConfig);
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
      
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        temperature: this.temperature,
        system: this.system,
        messages,
        tools,
        stream,
      });

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

      // If any tool calls were made, handle them by running the tools
      if (toolCalls.length > 0) {
        const toolCallMessage = new Message('tool_call', toolCalls);
        let newSuffix = suffix.plus(toolCallMessage);

        // Actually run those tools
        const toolResponse = await this.runTools(toolCallMessage);
        newSuffix = newSuffix.plus(toolResponse);

        // Re-invoke extendTranscript (recursively) with updated suffix
        return this.extendTranscript(prefix, callOnOutput, newSuffix, stream);
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

      // If we have a callback for streaming tokens, call it
      if (callOnOutput && !tools) {
        callOnOutput(fullReply);
      }

      // Return a new TranscriptFragment containing the assistant's reply
      return suffix.plus(new Message('assistant', fullReply));
    } catch (error) {
      console.error('Anthropic API error:', error);
      throw error;
    }
  }
}

export default AnthropicProvider;
