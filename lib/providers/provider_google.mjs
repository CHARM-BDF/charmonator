// File: lib/providers/provider_google.mjs

import { ModelProvider } from './provider_base.mjs';
import {
  ChatModel,
  Message,
  TranscriptFragment
} from '../chat-model-server.mjs';

// Import the Google Generative AI SDK
import { GoogleGenerativeAI } from '@google/generative-ai';

export class GoogleProvider extends ModelProvider {
  constructor(modelConfig) {
    super(modelConfig);
  }

  createChatModel() {
    return new GoogleChatModel(this.modelConfig);
  }
}

class GoogleChatModel extends ChatModel {
  constructor(modelConfig) {
    super(null, null, modelConfig);
    // Initialize the client using your API key.
    this._gClient = new GoogleGenerativeAI(
      this.modelConfig.api_key || process.env.GOOGLE_AI_API_KEY
    );
    // Set the model name (defaulting to "gemini-2.0-flash").
    this.modelName = this.modelConfig.model || 'gemini-2.0-flash';
    console.debug('[GoogleChatModel] Initialized with config:', this.modelConfig);
  }

  /**
   * Converts the conversation history into an array of Content objects.
   * Each object will include a "role" (allowed: "user" or "model") and a "parts" array.
   * If a message’s role is "assistant", it will be converted to "model".
   */
  _toContentArray(prefix) {
    const contents = [];
    for (const msg of prefix.messages) {
      // Skip tool calls/responses.
      if (msg.role === 'tool_call' || msg.role === 'tool_response') continue;
      // Allowed roles are "user" and "model"; map "assistant" to "model"
      let role = msg.role;
      if (role === 'assistant') {
        role = 'model';
      }
      // Convert the message content to text.
      let text = Array.isArray(msg.content) ? msg.content.join('\n') : String(msg.content);
      const contentObj = {
        role: role,
        parts: [{ text: text }]
      };
      contents.push(contentObj);
    }
    console.debug('[GoogleChatModel] Flattened content array:', JSON.stringify(contents, null, 2));
    return contents;
  }

  /**
   * Converts the API response into a TranscriptFragment.
   */
  _fromGeminiResponse(geminiResult) {
    let finalText = '';
    try {
      finalText = geminiResult?.response?.text?.() || '';
    } catch (err) {
      console.error('[GoogleChatModel] Error reading response text:', err);
    }
    console.debug('[GoogleChatModel] Raw response text:', finalText);
    return new TranscriptFragment([new Message('assistant', finalText)]);
  }

  /**
   * Extends the transcript by generating a new reply from the Gemini API.
   * Detailed logging is included.
   */
  async extendTranscript(prefix, callOnOutput = null, suffix = null, streamOrOptions = false) {
    console.debug('[GoogleChatModel] extendTranscript called with prefix:', JSON.stringify(prefix, null, 2));
    
    // Build the "contents" array from the transcript.
    const contents = this._toContentArray(prefix);
    
    // Build the request payload. Use generationConfig from the model config if provided.
    const requestPayload = {
      contents: contents,
      generationConfig: this.modelConfig.generationConfig || {}
    };
    console.debug('[GoogleChatModel] Request payload before API call:', JSON.stringify(requestPayload, null, 2));
    
    // Specify API version "v1beta" so that the SDK uses the correct endpoint.
    const model = this._gClient.getGenerativeModel({ model: this.modelName }, { apiVersion: "v1beta" });
    console.debug('[GoogleChatModel] Using model:', this.modelName, 'with API version v1beta');
    
    // Check if streaming is requested.
    const doStream = (typeof streamOrOptions === 'boolean') ? streamOrOptions : !!streamOrOptions?.stream;
    console.debug('[GoogleChatModel] Streaming requested:', doStream);
    
    if (doStream) {
      let stream;
      try {
        stream = model.generateContentStream(requestPayload);
        console.debug('[GoogleChatModel] Started streaming call.');
      } catch (err) {
        console.error('[GoogleChatModel] Error setting up streaming:', err);
        return new TranscriptFragment([new Message('assistant', 'Error calling Gemini (stream setup).')]);
      }
      
      let accumulated = '';
      try {
        for await (const chunk of stream) {
          const partial = chunk?.response?.text?.() || '';
          console.debug('[GoogleChatModel] Received stream chunk:', partial);
          accumulated += partial;
          if (callOnOutput) callOnOutput(partial);
        }
      } catch (err) {
        console.error('[GoogleChatModel] Streaming error:', err);
        return new TranscriptFragment([new Message('assistant', 'Error calling Gemini API (stream).')]);
      }
      console.debug('[GoogleChatModel] Final accumulated stream:', accumulated);
      return new TranscriptFragment([new Message('assistant', accumulated)]);
    } else {
      let geminiResult;
      try {
        geminiResult = await model.generateContent(requestPayload);
        console.debug('[GoogleChatModel] Received non-streaming result:', JSON.stringify(geminiResult, null, 2));
      } catch (err) {
        console.error('[GoogleChatModel] Gemini API error:', err);
        return new TranscriptFragment([new Message('assistant', 'Error calling Google Gemini API.')]);
      }
      return this._fromGeminiResponse(geminiResult);
    }
  }
}
