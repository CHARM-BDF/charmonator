// lib/providers/provider_base.mjs

export class ModelProvider {
  constructor(modelConfig) {
    this.modelConfig = modelConfig;
  }  

  createChatModel() {
    throw new Error('createChatModel() must be implemented by subclasses.');
  }

  // Other common methods can be implemented here
}

