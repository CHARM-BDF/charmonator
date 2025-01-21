// transcript.mjs
// Core data structures for chat transcripts, messages, tools, and attachments

/**
 * Base class for all attachments
 */
export class Attachment {
  toJSON() {
    throw new Error('toJSON must be implemented by subclasses');
  }

  static fromJSON(json) {
    throw new Error('fromJSON must be implemented by subclasses');
  }
}

/**
 * Represents an image attached to a message
 */
export class ImageAttachment extends Attachment {
  constructor(imageUrl) {
    super();
    this.imageUrl = imageUrl;
  }

  toJSON() {
    return {
      type: 'image',
      url: this.imageUrl
    };
  }

  static fromJSON(json) {
    return new ImageAttachment(json.url);
  }
}

/**
 * Represents a document attached to a message
 */
export class DocumentAttachment extends Attachment {
  constructor(filename, markdownContent) {
    super();
    this.filename = filename;
    this.markdownContent = markdownContent;
  }

  toMarkdown() {
    // Find maximum number of backticks needed
    const maxBackticks = Math.max(3, 
      ...this.markdownContent.split('\n')
        .map(line => (line.match(/`+/) || [''])[0].length)
    ) + 1;

    const separator = '`'.repeat(maxBackticks);
    return `\n\n# File attached: ${this.filename}\n${separator}\n${this.markdownContent}\n${separator}`;
  }

  toJSON() {
    return {
      type: 'document',
      filename: this.filename,
      content: this.markdownContent
    };
  }

  static fromJSON(json) {
    return new DocumentAttachment(json.filename, json.content);
  }
}

export class Message {
  constructor(role, content) {
    this.role = role;
    this.content = content;
  }

  isToolCall() {
    return this.role === 'tool_call';
  }

  isToolResponse() {
    return this.role === 'tool_response';
  }

  attach(attachment) {
    if (typeof this.content === 'string') {
      this.content = [this.content];
    }
    this.content.push(attachment);
  }

  toJSON() {
    let content = this.content;
    if (Array.isArray(content)) {
      content = content.map(item => {
        if (item instanceof Attachment) {
          return item.toJSON();
        }
        return item;
      });
    }
    
    return {
      role: this.role,
      content: content
    };
  }


  static fromJSON(json) {
    let content = json.content;
  
    if (Array.isArray(content)) {
      content = content.map(item => {
        // Handle attachments
        if (item?.type === 'image') {
          return ImageAttachment.fromJSON(item);
        }
        if (item?.type === 'document') {
          return DocumentAttachment.fromJSON(item);
        }
  
        // Handle tool calls and responses
        if (json.role === 'tool_call' && item.toolName) {
          return ToolCall.fromJSON(item);
        }
        if (json.role === 'tool_response' && item.toolName) {
          return ToolResponse.fromJSON(item);
        }
  
        return item; // If not a known special type, leave as-is.
      });
    }
  
    return new Message(json.role, content);
  }
  



}

export class TranscriptFragment {
  constructor(messages = []) {
    this.messages = messages;
  }

  plus(other) {
    if (other instanceof TranscriptFragment) {
      return new TranscriptFragment([...this.messages, ...other.messages]);
    } else if (other instanceof Message) {
      return new TranscriptFragment([...this.messages, other]);
    }
    throw new Error(`Cannot add object of type ${other?.constructor?.name || typeof other} to TranscriptFragment`);
  }

  toJSON() {
    return {
      messages: this.messages.map(msg => msg.toJSON())
    };
  }

  static fromJSON(json) {
    return new TranscriptFragment(
      json.messages.map(msg => Message.fromJSON(msg))
    );
  }
}

export class ToolCall {
  constructor(toolName, callId, callType, args, rationale = null) {
    this.toolName = toolName;
    this.callId = callId;
    this.callType = callType;
    this.arguments = args;
    this.rationale = rationale;
  }

  toJSON() {
    return {
      toolName: this.toolName,
      callId: this.callId,
      callType: this.callType,
      arguments: this.arguments,
      rationale: this.rationale
    };
  }

  static fromJSON(json) {
    return new ToolCall(
      json.toolName,
      json.callId,
      json.callType,
      json.arguments,
      json.rationale || null
    );
  }
}

export class ToolResponse {
  constructor(toolName, callId, response) {
    this.toolName = toolName;
    this.callId = callId;
    this.response = response;
  }

  toJSON() {
    return {
      toolName: this.toolName,
      callId: this.callId,
      response: this.response
    };
  }

  static fromJSON(json) {
    return new ToolResponse(
      json.toolName,
      json.callId,
      json.response
    );
  }
}
