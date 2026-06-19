import { ModelProvider } from './provider_base.mjs';
import { ChatModel } from '../chat-model-server.mjs';
import { Message, TranscriptFragment } from '../transcript.mjs';

const PROPERTY_RESOLVERS = {
  ms_client_request_timeout(chatModel, invocationOptions) {
    return invocationOptions.ms_client_request_timeout || chatModel.ms_client_request_timeout;
  }
};

export class TestPolicyProvider extends ModelProvider {
  createChatModel() {
    return new TestPolicyChatModel(this, null, { ...this.modelConfig });
  }
}

class TestPolicyChatModel extends ChatModel {
  constructor(provider, client, modelConfig) {
    super(provider, client, modelConfig);
    this.ms_client_request_timeout = modelConfig.ms_client_request_timeout;
    this.test_policy_properties = Array.isArray(modelConfig.test_policy_properties)
      ? [...modelConfig.test_policy_properties]
      : ['ms_client_request_timeout'];
  }

  async extendTranscript(prefix, callOnOutput = null, suffix = null, streamOrOptions = false) {
    let invocationOptions = {};

    if (streamOrOptions && typeof streamOrOptions === 'object') {
      invocationOptions = { ...streamOrOptions };
    }

    const resolvedValues = {};
    for (const propertyName of this.test_policy_properties) {
      const resolver = PROPERTY_RESOLVERS[propertyName];
      if (!resolver) {
        throw new Error(`Unsupported test policy property: ${propertyName}`);
      }
      resolvedValues[propertyName] = resolver(this, invocationOptions);
    }

    return new TranscriptFragment([
      new Message('assistant', JSON.stringify(resolvedValues))
    ]);
  }
}
