import { ModelProvider } from './provider_base.mjs';
import { ChatModel } from '../chat-model-server.mjs';
import { Message, TranscriptFragment } from '../transcript.mjs';
import { ProviderException } from './provider_exception.mjs';

export class TestPolicyProvider extends ModelProvider {
  createChatModel() {
    return new TestPolicyChatModel(this, null, { ...this.modelConfig });
  }
}

class TestPolicyChatModel extends ChatModel {
  constructor(provider, client, modelConfig) {
    super(provider, client, modelConfig);
    this.test_policy_response_mode = modelConfig.test_policy_response_mode || 'transcript/extension';
    this.test_policy_properties = Array.isArray(modelConfig.test_policy_properties)
      ? [...modelConfig.test_policy_properties]
      : ['ms_client_request_timeout'];
    this.test_policy_request_fields = modelConfig.test_policy_request_fields || {};
    this.test_policy_num_initial_defective_replies = Number(modelConfig.test_policy_num_initial_defective_replies || 0);
    this.test_policy_error = modelConfig.test_policy_error || null;
    this.test_policy_error_if_image_includes = modelConfig.test_policy_error_if_image_includes || null;
    this.test_policy_markdown_from_image = Boolean(modelConfig.test_policy_markdown_from_image);
    this.test_policy_markdown_prefix = modelConfig.test_policy_markdown_prefix || '';
    this.num_test_policy_calls = 0;

    for (const propertyName of this.test_policy_properties) {
      this[propertyName] = modelConfig[propertyName];
    }
  }

  async extendTranscript(prefix, callOnOutput = null, suffix = null, streamOrOptions = false) {
    let invocationOptions = {};

    if (streamOrOptions && typeof streamOrOptions === 'object') {
      invocationOptions = { ...streamOrOptions };
    }

    this.num_test_policy_calls += 1;

    if (this.num_test_policy_calls <= this.test_policy_num_initial_defective_replies) {
      return new TranscriptFragment([
        new Message('assistant', '')
      ]);
    }

    const decodedImageContent = this.extractDecodedImageContent(prefix);

    if (this.shouldThrowStructuredError(decodedImageContent)) {
      throw this.buildStructuredError();
    }

    const resolvedValues = {};
    for (const propertyName of this.test_policy_properties) {
      const requestField = this.test_policy_request_fields[propertyName] || propertyName;
      resolvedValues[propertyName] = invocationOptions[requestField] ?? this[propertyName];
    }

    let assistantContent = null;
    switch (this.test_policy_response_mode) {
      case 'transcript/extension':
        assistantContent = this.buildTranscriptExtensionResponse(resolvedValues);
        break;
      case 'summaries':
        assistantContent = this.buildSummariesResponse(resolvedValues);
        break;
      case 'conversion/image':
        assistantContent = this.buildConversionImageResponse(resolvedValues, decodedImageContent);
        break;
      default:
        throw new Error(`Unsupported test policy response mode: ${this.test_policy_response_mode}`);
    }

    return new TranscriptFragment([
      new Message('assistant', assistantContent)
    ]);
  }

  buildTranscriptExtensionResponse(resolvedValues) {
    return JSON.stringify(resolvedValues);
  }

  buildSummariesResponse(resolvedValues) {
    return JSON.stringify(resolvedValues);
  }

  buildConversionImageResponse(resolvedValues, decodedImageContent) {
    const markdown = this.test_policy_markdown_from_image
      ? `${this.test_policy_markdown_prefix}${decodedImageContent || ''}`
      : JSON.stringify(resolvedValues);

    return JSON.stringify({
      markdown,
      isFirstPage: false
    });
  }

  shouldThrowStructuredError(decodedImageContent) {
    if (!this.test_policy_error) {
      return false;
    }

    if (!this.test_policy_error_if_image_includes) {
      return true;
    }

    return decodedImageContent.includes(this.test_policy_error_if_image_includes);
  }

  buildStructuredError() {
    const inner = new Error(this.test_policy_error.message || 'Test policy error');
    const error = new ProviderException(inner);

    for (const [key, value] of Object.entries(this.test_policy_error)) {
      if (key === 'message') {
        continue;
      }
      error[key] = value;
    }

    return error;
  }

  extractDecodedImageContent(prefix) {
    const messageWithImage = [...prefix.messages]
      .reverse()
      .find(message => Array.isArray(message.content)
        && message.content.some(item => item?.imageUrl || item?.url));

    if (!messageWithImage) {
      return '';
    }

    const imagePart = [...messageWithImage.content]
      .reverse()
      .find(item => item?.imageUrl || item?.url);
    const imageUrl = imagePart?.imageUrl || imagePart?.url;

    if (typeof imageUrl !== 'string') {
      return '';
    }

    const dataMatch = /^data:[^;]+;base64,(.+)$/s.exec(imageUrl);
    if (!dataMatch) {
      return '';
    }

    try {
      return Buffer.from(dataMatch[1], 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
}
