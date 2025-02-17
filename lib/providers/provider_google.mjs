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
    // Initialize the client with your API key.
    this._gClient = new GoogleGenerativeAI(
      this.modelConfig.api_key || process.env.GOOGLE_AI_API_KEY
    );
    // Set the model name (defaulting to "gemini-2.0-flash").
    this.modelName = this.modelConfig.model || 'gemini-2.0-flash';
    console.debug('[GoogleChatModel] Initialized with config:', this.modelConfig);
  }

  /**
   * Converts conversation history into an array of Content objects.
   * Each object will include:
   *  - role: either "user" or "model" (mapping "assistant" to "model")
   *  - parts: an array of parts.
   * For each part:
   *  - If it's a string → add as { text: ... }
   *  - If it's an object with a property "imageUrl" or (type === "image" and "url"):
   *      - If the URL starts with "data:" then use inline_data (after stripping the prefix)
   *      - Otherwise, use fileData.
   */
  _toContentArray(prefix) {
    const contents = [];
    for (const msg of prefix.messages) {
      if (msg.role === 'tool_call' || msg.role === 'tool_response') continue;
      
      let role = (msg.role === 'assistant') ? 'model' : msg.role;
      let parts = [];
      
      const processPart = (part) => {
        if (typeof part === 'string') {
          parts.push({ text: part });
        } else if (part && typeof part === 'object') {
          // Check for ImageAttachment-like objects (with imageUrl property)
          if (('imageUrl' in part && typeof part.imageUrl === 'string') ||
              (part.type === 'image' && part.url)) {
            let url = part.imageUrl || part.url;
            let mimeType = part.mimeType || "image/jpeg";
            if (url.startsWith("data:")) {
              // Remove the prefix "data:<mime>;base64,"
              const matches = url.match(/^data:(.*?);base64,(.*)$/);
              if (matches && matches.length === 3) {
                mimeType = matches[1];
                const base64Data = matches[2];
                parts.push({ inline_data: { mime_type: mimeType, data: base64Data } });
              } else {
                console.warn('[GoogleChatModel] Unable to parse inline image data:', url);
              }
            } else {
              // Use fileData if it's a proper URL.
              parts.push({ fileData: { fileUri: url, mimeType: mimeType } });
            }
          } else {
            console.warn('[GoogleChatModel] Unrecognized content part:', part);
          }
        } else {
          parts.push({ text: String(part) });
        }
      };

      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          processPart(part);
        }
      } else if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (msg.content && typeof msg.content === 'object') {
        processPart(msg.content);
      } else {
        parts.push({ text: String(msg.content) });
      }
      
      const contentObj = { role: role, parts: parts };
      contents.push(contentObj);
    }
    console.debug('[GoogleChatModel] Flattened content array:', JSON.stringify(contents, null, 2));
    return contents;
  }

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

  async extendTranscript(prefix, callOnOutput = null, suffix = null, streamOrOptions = false) {
    console.debug('[GoogleChatModel] extendTranscript called with prefix:', JSON.stringify(prefix, null, 2));
    
    const contents = this._toContentArray(prefix);
    const requestPayload = {
      contents: contents,
      generationConfig: this.modelConfig.generationConfig || {}
    };
    console.debug('[GoogleChatModel] Request payload before API call:', JSON.stringify(requestPayload, null, 2));
    
    const model = this._gClient.getGenerativeModel({ model: this.modelName }, { apiVersion: "v1beta" });
    console.debug('[GoogleChatModel] Using model:', this.modelName, 'with API version v1beta');
    
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
