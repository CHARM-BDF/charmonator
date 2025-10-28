import { ModelProvider } from './provider_base.mjs';
import {
  Message,
  TranscriptFragment,
  ToolCall,
  ToolResponse,
  ImageAttachment,
  DocumentAttachment
} from '../transcript.mjs';
import { ChatModel } from '../chat-model-server.mjs';
import OpenAI from 'openai';
import { AzureOpenAI } from 'openai';
import { ProviderException } from './provider_exception.mjs';
import { debug } from '../debug.mjs';
import fs from 'fs';
import path from 'path';
import { withRetryLogging } from './openai_fetch.mjs';

// Create a logger for debugging
const logFile = path.join(process.cwd(), 'openai-provider-debug.log');
function logToFile(...args) {

  // // disabled for now:
  // return;

  try {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
    ).join(' ')}\n`;

    console.log(JSON.stringify(logMessage));
    
    // fs.appendFileSync(logFile, logMessage);
    // // Also log to console if debug is enabled
    // debug(...args);
  } catch (err) {
    console.error("Error writing to log file:", err);
  }
}

export class OpenAIProvider extends ModelProvider {
  constructor(modelConfig) {
    super(modelConfig);

    this.api_key = modelConfig.api_key;
    this.modelConfig = modelConfig;

    if (modelConfig.api === 'OpenAI_Azure') {
      // Azure-specific initialization
      this.client = new AzureOpenAI({
        apiKey: modelConfig.api_key,
        endpoint: modelConfig.endpoint,
        apiVersion: modelConfig.api_version,
        deployment: modelConfig.deployment
      });
      this.model = modelConfig.deployment;
    } else {
      // Standard OpenAI
      this.client = new OpenAI({
        apiKey: modelConfig.api_key,
        maxAttempts: modelConfig.num_client_request_max_attempts // gratuitous?
      });
      this.model = modelConfig.model;
    }
    
    logToFile("OpenAIProvider initialized with model:", this.model);
  }

  createChatModel() {
    const chatModel = new OpenAIChatModel(this, this.client, { ...this.modelConfig });
    return chatModel;
  }

  async embed(text) {
    const response = await this.client.embeddings.create({
      model: this.modelConfig.model,
      input: text
    });
    return response.data[0].embedding;
  }
}


class OpenAIChatModel extends ChatModel {
  constructor(provider, client, modelConfig) {
    super(provider, client, modelConfig);
    this.model = modelConfig.model || modelConfig.deployment;
    logToFile("OpenAIChatModel initialized with model:", this.model);

    this.num_client_request_max_attempts = modelConfig.num_client_request_max_attempts;
    // "Requests time out after 10 minutes by default.""
    this.ms_client_request_timeout = modelConfig.ms_client_request_timeout;
  }

  /**
   * Extend the conversation with a new suffix from the model.
   *
   * The final parameter can be a boolean (old usage for `stream`) or an object
   * containing ephemeral invocation-time options, e.g.:
   *   { stream?: boolean, response_format?: object, ... }
   */
  async extendTranscript(prefix, callOnOutput = null, suffix = null, streamOrOptions = false) {
    let self = this;
    // Interpret the old `stream` param or the new `options` object:
    let stream = false;
    let invocationOptions = {};

    if (typeof streamOrOptions === 'boolean') {
      stream = streamOrOptions;
    } else if (streamOrOptions && typeof streamOrOptions === 'object') {
      stream = !!streamOrOptions.stream;
      invocationOptions = {...streamOrOptions};
    }

    logToFile("extendTranscript called with options:", invocationOptions);

    if (!suffix) {
      suffix = new TranscriptFragment([]);
    }

    // Convert messages to OpenAI format
    const prefixMessages = transcriptToOpenAI(prefix);
    const suffixMessages = transcriptToOpenAI(suffix);

    // Build the system message (OpenAI recommends developer/system to come first).
    let messages = [];
    if (this.system) {
      const systemMessage = { role: 'developer', content: this.system };
      messages.push(systemMessage);
    }
    messages.push(...prefixMessages, ...suffixMessages);

    // Convert enabled tools to "functions" parameter
    let functions = null;
    if (this.enabledTools && this.enabledTools.size > 0) {
      functions = Array.from(this.enabledTools.values()).map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }));
    }

    // Prepare API parameters
    const params = {
      model: this.model,
      messages: messages,
      temperature: this.temperature,
      stream: stream,
      functions: functions
    };

    // Handle max_output_tokens if provided in invocationOptions
    if (invocationOptions && typeof invocationOptions.max_output_tokens === 'number') {
      // newer models disallow setting max_tokens
      if(!(this.model.startsWith("o3")
        || this.model.startsWith("gpt5")))
      {
        params.max_tokens = invocationOptions.max_output_tokens;
      }
    }

    // Handle response_format transformation
    if (invocationOptions.response_format) {
      try {
        const { transformedFormat, wasTransformed, originalSchema } = 
          this._transformResponseFormat(invocationOptions.response_format);
        
        params.response_format = transformedFormat;
        this._responseFormatWasTransformed = wasTransformed;
        this._originalResponseFormatSchema = originalSchema;
        
        logToFile("Final response_format in parameters:", params.response_format);
      } catch (err) {
        logToFile("Error transforming response_format:", err);
        delete params.response_format;
      }
    }

    // OpenAI changed how it handles reasoning between 'chat completion' and 'responses'.
    //
    // We'll have to look for reasoning_effort in two places:
    //  - params.reasoning.effort
    //  - params.reasoning_effort
    
    // By default, let's high reasoning effort:
    let reasoning_effort = "high" ;

    // Next, let's check for any modelConfig settings:
    if (this.modelConfig.reasoning && this.modelConfig.reasoning.effort) {
      reasoning_effort = this.modelConfig.reasoning.effort;
    }
    

    // Reasoning models (like `o1`/`o1-preview`/`o3-mini`) may not support certain params
    //
    if (this.model === 'o1-preview') {
      // Remove temperature & streaming from the params
      delete params.temperature;
      delete params.stream;
    } else if (this.model.startsWith("o")) {
      // Remove temperature & streaming from the params from any reasoning model
      delete params.temperature;
      delete params.stream;

      // Set reasoning effort:
      params.reasoning_effort = reasoning_effort;

    } else if (this.model === 'gpt-5') {

      // Remove streaming and temperature from the params:
      delete params.stream;
      delete params.temperature;

      // Set reasoning effort:

      params.reasoning_effort = reasoning_effort;
    }

    // Log the final parameters before API call
    logToFile("API Request parameters:", {
      model: params.model,
      temperature: params.temperature,
      stream: params.stream,
      response_format: params.response_format,
      functions: params.functions ? `${params.functions.length} functions defined` : 'none'
    });

    // We'll define a small helper to process the response (including any function calls).
    const processResponse = async (messages, suffix) => {
      try {
        let response;
        if (stream) {
          // Streaming mode

          response = await withRetryLogging(
            () => this.client.chat.completions.create(
              params,
              { timeout: invocationOptions.ms_client_request_timeout || self.ms_client_request_timeout }
            ),
            { maxAttempts: invocationOptions.num_client_request_max_attempts || self.num_client_request_max_attempts });
          let assistantMessage = null;

          for await (const chunk of response) {
            const delta = chunk.choices[0].delta;

            if (delta.content !== undefined) {
              if (!assistantMessage) {
                assistantMessage = { role: 'assistant', content: '' };
              }
              assistantMessage.content += delta.content;
              if (callOnOutput) {
                callOnOutput(delta.content);
              }
            } else if (delta.function_call) {
              if (!assistantMessage) {
                assistantMessage = { role: 'assistant', content: null, function_call: {} };
              }
              if (delta.function_call.name) {
                assistantMessage.function_call.name = delta.function_call.name;
              }
              if (delta.function_call.arguments) {
                assistantMessage.function_call.arguments =
                  (assistantMessage.function_call.arguments || '') + delta.function_call.arguments;
              }
            }
          }

          if (assistantMessage) {
            messages.push(assistantMessage);
          }

          // If there's a function call
          if (assistantMessage?.function_call) {
            const { name, arguments: args } = assistantMessage.function_call;
            const tool = this.enabledTools.get(name);
            if (!tool) throw new Error(`Function not found: ${name}`);

            const callId = `call-${Date.now()}`;
            const toolCall = new ToolCall(name, callId, 'function', JSON.parse(args));
            const toolCallMessage = new Message('tool_call', [toolCall]);

            let newSuffix = suffix.plus(toolCallMessage);
            const toolResponse = await this.runTools(toolCallMessage);
            newSuffix = newSuffix.plus(toolResponse);

            return await this.extendTranscript(prefix, callOnOutput, newSuffix, streamOrOptions);
          } else {
            // Return the normal text
            let content = assistantMessage?.content || '';
            
            // If we transformed the response format, unwrap the result
            if (this._responseFormatWasTransformed && content) {
              content = this._unwrapResponse(content);
            }
            
            return suffix.plus(new Message('assistant', content));
          }
        } else {
          // Non-streaming mode
          try {
            response = await withRetryLogging(
                () => this.client.chat.completions.create(
                  params,
                  { timeout: invocationOptions.ms_client_request_timeout || self.ms_client_request_timeout }
                ),
                { maxAttempts: self.num_client_request_max_attempts });
            logToFile("API Response received:", { 
              finish_reason: response.choices[0].finish_reason,
              content_length: response.choices[0].message.content?.length || 0
            });
          } catch (error) {
            logToFile("API Error:", error);
            // Enhanced error handling for better error classification
            const enhancedError = this._enhanceError(error);
            throw enhancedError;
          }
          
          const choice = response.choices[0];
          const message = choice.message;

          messages.push(message);

          if (message.function_call) {
            const { name, arguments: args } = message.function_call;
            const tool = this.enabledTools.get(name);
            if (!tool) throw new Error(`Function not found: ${name}`);

            const callId = `call-${Date.now()}`;
            const toolCall = new ToolCall(name, callId, 'function', JSON.parse(args));
            const toolCallMessage = new Message('tool_call', [toolCall]);

            let newSuffix = suffix.plus(toolCallMessage);
            const toolResponse = await this.runTools(toolCallMessage);
            newSuffix = newSuffix.plus(toolResponse);

            return await this.extendTranscript(prefix, callOnOutput, newSuffix, streamOrOptions);
          } else {
            let content = message.content;
            
            // If we transformed the response format, unwrap the result
            if (this._responseFormatWasTransformed && content) {
              logToFile("Unwrapping transformed response");
              content = this._unwrapResponse(content);
              logToFile("Unwrapped content:", content);
            }
            
            if (callOnOutput) {
              callOnOutput(content);
            }
            
            return suffix.plus(new Message('assistant', content));
          }
        }
      } catch (error) {
        logToFile("Error in extendTranscript:", error);
        debug("Error in extendTranscript:", error);
        // Enhanced error handling for better error classification
        const enhancedError = this._enhanceError(error);
        throw enhancedError;
      }
    };

    return await processResponse(messages, suffix);
  }

  /**
   * Transform the response_format to ensure it's compatible with OpenAI API
   * @param {Object} responseFormat - The original response_format object
   * @returns {Object} Object containing transformed format and metadata
   */
  _transformResponseFormat(responseFormat) {
    logToFile("Original response_format:", responseFormat);
    
    // Initialize result
    const result = {
      transformedFormat: { ...responseFormat }, // Start with a clone of the original
      wasTransformed: false,
      originalSchema: null
    };
    
    // Check for different schema formats and handle each appropriately
    if (responseFormat.type === "json_schema" && responseFormat.json_schema) {
      // This is the o1 format (json_schema with nested json_schema object)
      const jsonSchema = responseFormat.json_schema;
      
      if (jsonSchema.schema && jsonSchema.schema.type && jsonSchema.schema.type !== "object") {
        // Non-object schema needs wrapping
        logToFile(`Schema type is '${jsonSchema.schema.type}', wrapping in result object`);
        
        // Store original schema for unwrapping later
        result.originalSchema = JSON.parse(JSON.stringify(jsonSchema.schema));
        result.wasTransformed = true;
        
        // Create wrapper schema that preserves the original schema inside a result property
        const wrappedSchema = {
          type: "object",
          properties: {
            result: jsonSchema.schema
          },
          required: ["result"]
        };
        
        // Replace the schema while preserving the rest of the structure
        result.transformedFormat.json_schema = {
          ...jsonSchema,
          schema: wrappedSchema
        };
      }
    } 
    else if (responseFormat.type === "json_object" && responseFormat.schema) {
      // This is the standard format (json_object with direct schema)
      if (responseFormat.schema.type && responseFormat.schema.type !== "object") {
        // Non-object schema needs wrapping
        logToFile(`Schema type is '${responseFormat.schema.type}', wrapping in result object`);
        
        // Store original schema for unwrapping later
        result.originalSchema = JSON.parse(JSON.stringify(responseFormat.schema));
        result.wasTransformed = true;
        
        // Create wrapper schema
        result.transformedFormat.schema = {
          type: "object",
          properties: {
            result: responseFormat.schema
          },
          required: ["result"]
        };
      }
    }
    // Default case - leave as is
    
    logToFile("Transformed format:", result.transformedFormat);
    return result;
  }

  /**
   * Unwrap the response if it was transformed
   * @param {string} content - The response content
   * @returns {string} Unwrapped content
   */
  _unwrapResponse(content) {
    if (!this._responseFormatWasTransformed || !content) {
      return content;
    }
    
    logToFile("Attempting to unwrap response:", content);
    
    try {
      // Parse the JSON response
      const parsed = JSON.parse(content);
      
      // If it has our result property
      if (parsed && typeof parsed === 'object' && 'result' in parsed) {
        const result = parsed.result;
        logToFile("Extracted result:", result);
        
        // Convert back to string
        return JSON.stringify(result);
      }
    } catch (error) {
      logToFile("Error unwrapping response:", error);
    }
    
    return content;
  }

  /**
   * Enhance error objects with additional classification information
   * @param {Error} error - The original error object
   * @returns {Error} Enhanced error with additional properties
   */
  _enhanceError(error) {
    // Create enhanced error object while preserving the original
    const enhancedError = new ProviderException(error)
    enhancedError.provider = 'openai';
    
    // Detect content filter violations
    const isContentFilter = this._isContentFilterError(error);
    if (isContentFilter) {
      enhancedError.interpretedErrorType = 'content_filter_violation';
      enhancedError.interpretedCode = 422; // Unprocessable Entity
      enhancedError.interpretedMessage = 'Content was filtered due to policy violations. Please try with different content.';
      logToFile('Content filter violation detected:', error.message);
    }
    else if (this._isContextOverflow(error)) {
      enhancedError.interpretedErrorType = 'context_overflow';
      enhancedError.interpretedCode = error.status || error.statusCode || 500;
      enhancedError.interpretedMessage = 'Too many tokens for model';
      logToFile('Context overflow:', error.message);
    }
    // Detect rate limiting
    else if (this._isRateLimitError(error)) {
      enhancedError.interpretedErrorType = 'rate_limit';
      enhancedError.interpretedCode = 429; // Too Many Requests
      enhancedError.interpretedMessage = 'Rate limit exceeded. Please try again later.';
      logToFile('Rate limit error detected:', error.message);
    }
    // Detect authentication errors
    else if (this._isAuthError(error)) {
      enhancedError.interpretedErrorType = 'authentication';
      enhancedError.interpretedCode = 401; // Unauthorized
      enhancedError.interpretedMessage = 'Authentication failed. Please check API credentials.';
      logToFile('Authentication error detected:', error.message);
    }
    // Detect quota/billing errors
    else if (this._isQuotaError(error)) {
      enhancedError.interpretedErrorType = 'quota_exceeded';
      enhancedError.interpretedCode = 402; // Payment Required
      enhancedError.interpretedMessage = 'API quota exceeded. Please check your billing and usage limits.';
      logToFile('Quota error detected:', error.message);
    }
    // Unclassified API errors
    else {
      enhancedError.interpretedErrorType = 'unclassified_api_error';
      enhancedError.interpretedCode = error.status || error.statusCode || 500;
      enhancedError.interpretedMessage = 'An error occurred while processing your request.';
      logToFile('Unclassified API error:', error.message);
    }
    
    return enhancedError;
  }

  /**
   * Check if error is a content filter violation
   * @param {Error} error - The error to check
   * @returns {boolean} True if this is a content filter error
   */
  _isContentFilterError(error) {
    const message = (error.message || '').toLowerCase();
    const code = (error.code || '').toLowerCase();
    
    // Check for OpenAI error codes
    if (code === 'content_filter') {
      return true;
    }
    
    // Check for Azure-specific inner error codes
    if (error.innerException
      && error.innerException.innererror
      && error.innerException.innererror.code === 'ResponsibleAIPolicyViolation') {
      return true;
    }
    
    // Check original error object structure for Azure patterns
    const originalError = error.innerException || error;
    if (originalError.error && originalError.error.innererror) {
      const innerCode = originalError.error.innererror.code;
      if (innerCode === 'ResponsibleAIPolicyViolation') {
        return true;
      }
    }
    
    // Check for specific content filter message patterns
    const contentFilterIndicators = [
      'content_filter',
      'content policy violation', 
      'content was filtered',
      'violated content policy',
      'inappropriate content',
      'content_policy_violation',
      'responsibleaipolicy',
      'responsibleaipolicyviolation',
      // Azure-specific patterns
      'the response was filtered due to the prompt triggering azure openai',
      'content management policy',
      'modify your prompt and retry',
      'azure has not provided the response due to a content filter',
      'content filter being triggered'
    ];
    
    const hasContentFilterIndicator = contentFilterIndicators.some(indicator => 
      message.includes(indicator) || code.includes(indicator)
    );
    
    // Check for finish_reason content_filter in response
    if (originalError.finish_reason === 'content_filter') {
      return true;
    }
    
    // Check for content_filter_results indicating filtering occurred
    if (originalError.content_filter_results) {
      const results = originalError.content_filter_results;
      // Check if any category was filtered
      const categories = ['hate', 'sexual', 'violence', 'self_harm', 'jailbreak'];
      for (const category of categories) {
        if (results[category] && results[category].filtered === true) {
          return true;
        }
      }
      // Check custom blocklists
      if (results.custom_blocklists && results.custom_blocklists.filtered === true) {
        return true;
      }
    }
    
    return hasContentFilterIndicator || 
           (error.status === 400 && message.includes('filter'));
  }

  _isContextOverflow(error) {
    const status = error.status || error.statusCode;
    const message = (error.message || '').toLowerCase();
    return (status === 400 && message.includes("maximum context length"))
  }

  /**
   * Check if error is a rate limit error
   * @param {Error} error - The error to check  
   * @returns {boolean} True if this is a rate limit error
   */
  _isRateLimitError(error) {
    const status = error.status || error.statusCode;
    const message = (error.message || '').toLowerCase();
    const code = (error.code || '').toLowerCase();
    
    return status === 429 || 
           message.includes('rate limit') ||
           message.includes('too many requests') ||
           code === 'rate_limit_exceeded';
  }

  /**
   * Check if error is an authentication error
   * @param {Error} error - The error to check
   * @returns {boolean} True if this is an authentication error
   */
  _isAuthError(error) {
    const status = error.status || error.statusCode;
    const message = (error.message || '').toLowerCase();
    const code = (error.code || '').toLowerCase();
    
    return status === 401 ||
           message.includes('unauthorized') ||
           message.includes('invalid api key') ||
           message.includes('authentication') ||
           code === 'invalid_api_key';
  }

  /**
   * Check if error is a quota/billing error
   * @param {Error} error - The error to check
   * @returns {boolean} True if this is a quota error
   */
  _isQuotaError(error) {
    const status = error.status || error.statusCode;
    const message = (error.message || '').toLowerCase();
    const code = (error.code || '').toLowerCase();
    
    return status === 402 ||
           message.includes('quota') ||
           message.includes('insufficient_quota') ||
           message.includes('billing') ||
           code === 'insufficient_quota';
  }
}

// -------------------------------
// HELPER FUNCTIONS
// -------------------------------

/**
 * Convert an entire TranscriptFragment to OpenAI's chat messages format
 */
function transcriptToOpenAI(transcript) {
  return transcript.messages.map(messageToOpenAI);
}

/**
 * Convert a single Message to the needed OpenAI Chat Completions structure.
 * Handles text, images (as `type: 'image_url'`), documents, tool calls, etc.
 */
function messageToOpenAI(message) {
  // 1) Tool calls -> becomes a function_call for the assistant role
  if (message.role === 'tool_call') {
    return {
      role: 'assistant',
      function_call: {
        name: message.content[0].toolName,
        arguments: JSON.stringify(message.content[0].arguments)
      },
      content: null
    };
  }

  // 2) Tool responses -> becomes a "function" role
  if (message.role === 'tool_response') {
    let responseContent = message.content[0]?.response;
    // If object, convert to string
    if (typeof responseContent === 'object') {
      responseContent = JSON.stringify(responseContent);
    }
    return {
      role: 'function',
      name: message.content[0]?.toolName,
      content: responseContent
    };
  }

  // 3) Normal user/assistant/developer messages
  //    We want to produce an array of typed items in `content`.
  let typedContent = [];

  // If content is a single string
  if (typeof message.content === 'string') {
    typedContent = [
      {
        type: 'text',
        text: message.content
      }
    ];
  }
  // If content is an array, handle each item
  else if (Array.isArray(message.content)) {
    typedContent = message.content.map((item) => {
      if (typeof item === 'string') {
        return { type: 'text', text: item };
      }
      // Check for image attachments
      else if (item instanceof ImageAttachment) {
        return {
          type: 'image_url',
          image_url: {
            url: item.imageUrl,  // can be data: or https://
            detail: "high" // Use high-quality images
          }
        };
      }
      // Check for documents
      else if (item instanceof DocumentAttachment) {
        // If you want the doc text directly:
        return { type: 'text', text: item.markdownContent };
      }
      // Fallback
      else {
        return { type: 'text', text: String(item) };
      }
    });
  }

  // Return a message object recognized by OpenAI chat
  // For Azure OpenAI, if content is just a single text item, send as string
  if (typedContent.length === 1 && typedContent[0].type === 'text') {
    return {
      role: message.role,
      content: typedContent[0].text
    };
  }
  
  // Otherwise, send as typed content array (for images, etc.)
  return {
    role: message.role,
    content: typedContent
  };
}

export default OpenAIProvider;
