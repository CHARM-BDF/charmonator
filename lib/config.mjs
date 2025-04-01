// lib/config.mjs

import fs from 'fs';
import path from 'path';
import os from 'os';

let config = null;

let globalConfigFile = null;

function populateConfigDefaults(configObj) {
  if (!configObj.default_system_message) {
    configObj.default_system_message = 'You are a helpful assistant.';
  }
  if (configObj.default_temperature === undefined) {
    configObj.default_temperature = 0.8;
  }
  return configObj;
}

export function setGlobalConfigFile(filePath) {
  globalConfigFile = filePath;
}

export function setConfig(configObj) {
  config = populateConfigDefaults({ ...configObj });
}

function parseAndPopulateConfig(filePath) {
  let fileContent = fs.readFileSync(filePath, 'utf-8');
  config = populateConfigDefaults(JSON.parse(fileContent));
  return config;
}

export function getConfig() {
  if (config) {
    return config;
  }

  // First, check if globalConfigFile is set, and if so, read from that:
  if (globalConfigFile) {
    return parseAndPopulateConfig(globalConfigFile)
  }

  // Next, check for an environment variable:
  const envConfigPath = process.env.CHARMONATOR_CONFIG;
  let configPath = envConfigPath;
 
  // Failing that, check for a local config file:
  if (!configPath || !fs.existsSync(configPath)) {
    configPath = path.join(os.homedir(), '.charmonator', 'config.json');
    if (!fs.existsSync(configPath)) {
      config = { models: {} };
      return config;
    }
  }

  return parseAndPopulateConfig(configPath)
}

export function getModelConfig(modelName) {
  const cfg = getConfig();
  const selectedModelName = selectModel(modelName);
  const modelConfig = cfg.models[selectedModelName];

  if (!modelConfig) {
    throw new Error(`Model ${modelName} not found in config.`);
  }

  return {
    ...modelConfig,
    system: modelConfig.system || cfg.default_system_message,
    temperature: modelConfig.temperature || cfg.default_temperature,
  };
}

// Helper function to handle model name abbreviations
function selectModel(modelName) {
  const abbreviations = {
    'gpt-3.5-turbo': 'gpt-3.5-turbo',
    'gpt-4': 'gpt-4',
    // Add more abbreviations as needed
  };
  return abbreviations[modelName] || modelName;
}


// Configuration that determines the path to services:
export function getServerPort() {
  return getConfig().server?.port || 5003;
}

export function getBaseUrl() {
  return getConfig().server?.baseUrl || '';
}

export function getCharmonatorApiPath() {
  return getConfig().server?.charmonator?.apiPath || 'api/charmonator';
}

export function getCharmonatorApiVersion() {
  return getConfig().server?.charmonator?.apiVersion || 'v1';
}

export function getFullCharmonatorApiPrefix() {
  // e.g. /api/charmonator/v1
  return `${getBaseUrl()}/${getCharmonatorApiPath()}/${getCharmonatorApiVersion()}`;
}


export function getCharmonizerApiPath() {
  return getConfig().server?.charmonizer?.apiPath || 'api/charmonizer';
}

export function getCharmonizerApiVersion() {
  return getConfig().server?.charmonizer?.apiVersion || 'v1';
}

export function getFullCharmonizerApiPrefix() {
  // e.g. /api/charmonizer/v1
  return `${getBaseUrl()}/${getCharmonizerApiPath()}/${getCharmonizerApiVersion()}`;
}





// Parameters for long-running jobs:


// Directory where job directories are stored
export function getJobsDir() {
  return getConfig().jobsDir || path.join(os.homedir(), '.charmonator', 'jobs');
}
