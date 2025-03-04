// chat-model-client.mjs

import { TranscriptFragment, Message } from './transcript-core.mjs';

export class ChatModel {
  constructor(modelId, options = {}) {
    this.modelId = modelId;
    this.system = options.system || 'You are a helpful assistant.';
    this.temperature = options.temperature || 0.7;
    this.tools = options.tools || [];
    this.apiUrl = options.apiUrl || 'http://localhost:3000/v1/chat';
  }

  async extendTranscript(prefix) {
    const response = await fetch(`${this.apiUrl}/transcript/extension`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.modelId,
        system: this.system,
        temperature: this.temperature,
        transcript: prefix.toJSON(),
        tools: this.tools
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to extend transcript');
    }

    const suffixJson = await response.json();
    return TranscriptFragment.fromJSON(suffixJson);
  }
}

export class ChatSession {
  constructor(chatModel) {
    this.chatModel = chatModel;
    this.transcript = new TranscriptFragment();
  }

  async sendMessage(content) {
    const message = new Message('user', content);
    this.transcript = this.transcript.plus(message);
    
    const suffix = await this.chatModel.extendTranscript(this.transcript);
    this.transcript = this.transcript.plus(suffix);
    
    return suffix;
  }
}

// Example usage:
/*
const model = new ChatModel('openai:gpt-4', {
  system: 'You are a math tutor.',
  tools: [{
    name: 'calculator',
    description: 'Basic calculator',
    input_schema: {
      type: 'object',
      properties: {
        expression: { type: 'string' }
      }
    }
  }]
});

const session = new ChatSession(model);
const response = await session.sendMessage('What is 2 + 2?');
console.log(response.messages[0].content);
*/
