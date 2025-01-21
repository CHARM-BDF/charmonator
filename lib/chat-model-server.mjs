// chat-model-server.mjs

import { Message, TranscriptFragment, ToolCall, ToolResponse } from './transcript.mjs';

import { toolRegistry } from './tools.mjs';


/**
 * Server-side ChatModel implementation that interacts with provider APIs
 */
export class ChatModel {
  constructor(provider, client, modelConfig) {
    this.provider = provider;
    this.client = client;
    this.modelConfig = modelConfig;

    console.log('ChatModel config');
    console.log(modelConfig);

    this.system = modelConfig.system;
    this.temperature = modelConfig.temperature;

    this.options = {};

    // Initialize empty maps for enabled tools
    this.enabledTools = new Map();
    this.boundSession = null;

    // Check for named tools to enable in modelConfig:
    for (const toolName of modelConfig.tools || []) {
      this.enableTool(toolName);
    }
    
  }

  setSystem(system) {
    this.system = system;
  }


  /**
   * Enable a specific tool by name
   * @param {string} toolName - Name of tool to enable
   */
  enableTool(toolName) {
    const tool = toolRegistry.getTool(toolName);
    this.enabledTools.set(toolName, tool);
  }


  /**
   * Bind this model to a specific chat session
   * @param {ChatSession} session - The session to bind to
   */
  bindSession(session) {
    this.boundSession = session;
    // Get session-specific versions of all enabled tools
    this.enabledTools = toolRegistry.getSessionTools(session);
  }  



  async runTools(msg) {
    const responses = [];

    for (const atom of msg.content) {
      if (atom instanceof ToolCall) {
        const { toolName, callId, arguments: args } = atom;

        const tool = this.enabledTools.get(toolName);
        if (!tool) {
          throw new Error(`Tool ${toolName} not found or not enabled`);
        }

        let response;
        if (tool.constructor.name === 'SessionTool') {
          if (!this.boundSession) {
            throw new Error('Session tool used without bound session');
          }
          response = await tool.run(args, this.boundSession);
        } else {
          response = await tool.run(args);
        }
        
        responses.push(new ToolResponse(toolName, callId, String(response)));
      }
    }

    return new Message('tool_response', responses);
  }  



  async extendTranscript(prefix, callOnOutput = null, suffix = null, stream = false) {
    throw new Error('extendTranscript must be implemented by provider-specific subclasses');
  }

  async replyTo(userMessage, callOnOutput = null, stream = false) {
    if (typeof userMessage === 'string') {
      userMessage = new Message('user', userMessage);
    }

    const transcript = new TranscriptFragment([userMessage]);
    const responseFragment = await this.extendTranscript(transcript, callOnOutput, null, stream);

    const lastMessage = responseFragment.messages[responseFragment.messages.length - 1];
    if (lastMessage?.role === 'assistant') {
      return lastMessage.content;
    }
    
    throw new Error('Unexpected response format from extendTranscript: ' + responseFragment);
  }

  toString() {
    return JSON.stringify({
      system: this.system,
      temperature: this.temperature,
      model: this.modelConfig.model || this.modelConfig.deployment
    }, null, 2);
  }
}

/**
 * Server-side ChatSession that maintains conversation state
 */
export class ChatSession {
  constructor(chatModel) {
    this.chatModel = chatModel;
    this.transcript = new TranscriptFragment();
  }

  get system() {
    return this.chatModel.system;
  }

  set system(system) {
    this.chatModel.setSystem(system);
  }

  async fetchRepliesTo(userMessage) {
    const msg = typeof userMessage === 'string' 
      ? new Message('user', userMessage)
      : userMessage;

    this.transcript = this.transcript.plus(msg);
    const suffix = await this.chatModel.extendTranscript(this.transcript);
    this.transcript = this.transcript.plus(suffix);
    return suffix;
  }

  async fetchReplyTo(userMessage) {
    const suffix = await this.fetchRepliesTo(userMessage);
    const lastMessage = suffix.messages[suffix.messages.length - 1];
    return lastMessage.content;
  }
}

// Export core classes as well for convenience
export { Message, TranscriptFragment, ToolCall, ToolResponse } from './transcript.mjs';
