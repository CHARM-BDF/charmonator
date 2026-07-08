import { ModelProvider } from './provider_base.mjs';
import { ChatModel } from '../chat-model-server.mjs';
import { Message, TranscriptFragment } from '../transcript.mjs';

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

    for (const propertyName of this.test_policy_properties) {
      this[propertyName] = modelConfig[propertyName];
    }
  }

  async extendTranscript(prefix, callOnOutput = null, suffix = null, streamOrOptions = false) {
    let invocationOptions = {};

    if (streamOrOptions && typeof streamOrOptions === 'object') {
      invocationOptions = { ...streamOrOptions };
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
        assistantContent = this.buildConversionImageResponse(resolvedValues);
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

  buildConversionImageResponse(resolvedValues) {
    return JSON.stringify({
      markdown: JSON.stringify(resolvedValues),
      isFirstPage: false
    });
  }
}
