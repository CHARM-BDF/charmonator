// lib/config.mjs

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirproj = path.dirname(path.dirname(__filename));


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

function populateModelConfigDefaults(configModel, configGlobal) {
  // For lack of a better opinion, falling back globally on the
  // openai library defaults, described here:
  //   "...Certain errors will be automatically retried 2 times by default,
  //   with a short exponential backoff...."
  //   "...Requests time out after 10 minutes by default..."
  //   https://github.com/openai/openai-node/blob/master/README.md

  if (configModel.max_attempts == undefined) {
    configModel.max_attempts = configGlobal.max_attempts || 2;
  }
  if (configModel.ms_client_request_timeout == undefined) {
    configModel.ms_client_request_timeout = configGlobal.ms_client_request_timeout || 600000;
  }
  return configModel;
}

function validateModelConfigDefaults(configObj) {
  configObj.max_attempts = Number(configObj.max_attempts)
  if(Number.isNaN(configObj.max_attempts) || configObj.max_attempts <= 0) {
    throw new Error(`configuration: max_attempts must be a postive number: ${modelConfig.max_attempts}`)
  }
  configObj.ms_client_request_timeout = Number(configObj.ms_client_request_timeout)
  if(Number.isNaN(configObj.ms_client_request_timeout) || configObj.ms_client_request_timeout <= 0) {
    throw new Error("configuration: ms_client_request_timeout must be a positive number")
  }
}

export function setGlobalConfigFile(filePath) {
  if(!filePath.endsWith(".json")) {
    throw new Error(`Config file must be named .json: ${filePath}`)
  }
  globalConfigFile = filePath;
}

export function setConfig(configObj) {
  config = populateConfigDefaults({ ...configObj });
}

function isModel(configObj) {
  return (
    typeof configObj == 'object'
    && configObj['model_type']
  )
}

function parseAndPopulateConfig(filePath) {
  // TODO: If we want to support secret stores, put each secret in a separate
  // environment variable like CHARMONATOR_MY_MODEL_NAME_API_KEY and parse
  // that information here.  That's what people who think about secret
  // stores are most likely to expect.
  let pathForSecret = filePath.replace(".json",".secret.json");
  let secretFileContent = {}
  if(fs.existsSync(pathForSecret)) {
    secretFileContent = JSON.parse(fs.readFileSync(pathForSecret, 'utf-8'))
  }
  let fileContent = fs.readFileSync(filePath, 'utf-8');
  config = populateConfigDefaults(JSON.parse(fileContent));
  config['secret'] = secretFileContent;
  let models = config["models"]
  for (const k of Object.keys(models)) {
    if(isModel(models[k])) {
      populateModelConfigDefaults(models[k],config)
      validateModelConfigDefaults(models[k])
    }
  }
  return config
}

function chooseConfigFile() {
  const envConfigPath = process.env.CHARMONATOR_CONFIG || '';
  if(fs.existsSync(envConfigPath))
    return envConfigPath;
  const homeConfigPath = path.join(os.homedir(), '.charmonator', 'config.json')
  if(fs.existsSync(homeConfigPath))
    return homeConfigPath;
  const relConfigPath =  path.join(__dirproj, "conf", "config.json")
  if(fs.existsSync(relConfigPath))
    return relConfigPath
  throw new Error(`Could not find config.json: ${envConfigPath} ${homeConfigPath} ${relConfigPath}`)
}

export function getConfig() {
  if (config) {
    return config;
  }

  const path = chooseConfigFile()
  config = parseAndPopulateConfig(path)
  return config
}

export function getModelConfig(modelName) {
  const cfg = getConfig();
  const selectedModelName = selectModel(modelName);
  let modelConfig = cfg.models[selectedModelName];
  if (!modelConfig) {
    throw new Error(`Model ${modelName} not found in config.`);
  }
  modelConfig = {...modelConfig}

  const api_key = (
    ((cfg.secret?.models || {})[selectedModelName] || {})["api_key"] ||
    ((cfg.models || {})[selectedModelName] || {})["api_key"]
  );

  return {
    ...modelConfig,
    api_key,
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

export function getApiKey() {
  if(getConfig().secret?.server?.api_key) {
    return getConfig().secret?.server?.api_key
  }
  return getConfig().server?.api_key;
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
