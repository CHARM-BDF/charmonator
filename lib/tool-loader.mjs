/**
 * tool-loader.mjs
 *
 * Implements a config-driven tool loader. Tools can be declared as single tools
 * or as “toolboxes” (lists of references to other tools).
 *
 * Usage in your startup code:
 *
 *   import { loadToolDefinitionsFromConfig, initModelTools } from './tool-loader.mjs';
 *   import { getConfig } from './config.mjs';
 *
 *   async function startup() {
 *     const config = getConfig();
 *     const toolDefs = loadToolDefinitionsFromConfig(config);
 *     // For each model, expand & instantiate its tools:
 *     await initModelTools(config, toolDefs);
 *   }
 *
 */

import fs from 'fs/promises';

// EXAMPLE: If you want to use the toolRegistry from your code:
import { toolRegistry } from './tools.mjs';

/**
 * Parse out the top-level `config.tools` object, returning a map of
 *  toolName -> { type: 'single' | 'toolbox', [loaderConfig], [childRefs] }
 *
 * In your `config.json`, you might have something like:
 *  {
 *    "tools": {
 *      "web_search": {
 *        "package": "my-tool-lib",
 *        "class": "WebSearchTool",
 *        "options": { ... }
 *      },
 *      "calc": { "code": "./tools/calculator.js" },
 *      "my_box": { "toolbox": ["web_search", "calc"] }
 *    }
 *  }
 */
export function loadToolDefinitionsFromConfig(config) {
  const toolEntries = config.tools || {};
  const definitions = new Map();  // toolName => metadata object

  for (const [toolName, toolConf] of Object.entries(toolEntries)) {
    if (toolConf.toolbox) {
      // This entry is a "toolbox" containing an array of child names
      definitions.set(toolName, {
        type: 'toolbox',
        childRefs: toolConf.toolbox   // array of strings
      });
    } else {
      // This entry is a "single" tool definition
      // We'll store the entire object in `loaderConfig` for later instantiation
      definitions.set(toolName, {
        type: 'single',
        loaderConfig: toolConf
      });
    }
  }
  return definitions;
}

/**
 * Expand a tool reference that might be a single tool or a toolbox.
 *
 * If it’s a toolbox, recursively gather all child tools. If it’s a single tool, return [toolName].
 * This ensures that a reference to e.g. "my_box" expands to ["web_search", "calc", ...].
 *
 * We pass in a `visited` set to detect cycles.
 */
export function expandToolRefs(toolName, definitions, visited = new Set()) {
  if (visited.has(toolName)) {
    throw new Error(`Circular reference detected in toolbox: ${toolName}`);
  }
  visited.add(toolName);

  const def = definitions.get(toolName);
  if (!def) {
    throw new Error(`Tool or toolbox "${toolName}" not found in config.tools`);
  }

  if (def.type === 'toolbox') {
    let expanded = [];
    for (const child of def.childRefs) {
      const childList = expandToolRefs(child, definitions, visited);
      expanded = expanded.concat(childList);
    }
    return expanded;
  } else {
    // Single
    return [toolName];
  }
}

/**
 * Dynamically instantiate a single tool from its loaderConfig.
 *
 * For example:
 *   {
 *     "package": "my-tool-lib",
 *     "class": "WebSearchTool",
 *     "options": { "default_api": "duckduckgo" }
 *   }
 * or
 *   {
 *     "code": "./tools/calculator.js",
 *     "class": "CalculatorTool",
 *     "options": { "precision": 8 }
 *   }
 *
 * Return a new instance of `BaseTool` (or SessionTool, etc.).
 */
export async function instantiateToolFromLoaderConfig(loaderConfig) {
  // We’ll look for recognized fields: package, code, class, options
  const { package: pkg, code, class: className, options } = loaderConfig;

  let ToolClass = null;

  if (pkg) {
    // e.g. "my-tool-lib"
    const mod = await import(pkg);       // dynamic import
    if (!className) {
      throw new Error(`loaderConfig requires "class" when using "package". config=${JSON.stringify(loaderConfig)}`);
    }
    ToolClass = mod[className];
    if (!ToolClass) {
      throw new Error(`No export named "${className}" in package "${pkg}"`);
    }
  }
  else if (code) {
    // e.g. "./tools/calculator.js"
    const mod = await import(code);
    if (className) {
      ToolClass = mod[className];
      if (!ToolClass) {
        throw new Error(`No export named "${className}" in file "${code}"`);
      }
    } else if (mod.default) {
      // fallback: use default export
      ToolClass = mod.default;
    } else {
      throw new Error(`No "class" specified, and no default export found in "${code}"`);
    }
  }
  else {
    throw new Error(`Tool loaderConfig must have either "package" or "code". config=${JSON.stringify(loaderConfig)}`);
  }

  // Now create instance
  const instance = new ToolClass(options);
  // Optionally do more checks, e.g. verifying instance is a subclass of your BaseTool
  return instance;
}

/**
 * For each model in the config, gather the tool references from `modelCfg.tools`,
 * expand them (in case of toolboxes), instantiate them, and register them in the toolRegistry.
 *
 * You can also store the actual tool instances in `modelCfg._resolvedTools` if you want direct references.
 */
export async function initModelTools(config, definitions) {
  if (!config.models) return;

  for (const [modelName, modelCfg] of Object.entries(config.models)) {
    const toolRefs = modelCfg.tools || [];
    let finalToolNames = [];

    // Expand each ref to a list of single tool names
    for (const refName of toolRefs) {
      const expanded = expandToolRefs(refName, definitions);
      finalToolNames = finalToolNames.concat(expanded);
    }
    // Deduplicate
    finalToolNames = [...new Set(finalToolNames)];

    // Instantiate & register
    const instantiatedTools = [];
    for (const tName of finalToolNames) {
      const def = definitions.get(tName);
      if (!def) {
        // means config is inconsistent
        throw new Error(`No definition for tool "${tName}" (model="${modelName}")`);
      }
      if (def.type !== 'single') {
        // shouldn't happen if expandToolRefs worked
        continue;
      }

      // Actually build the tool
      const toolObj = await instantiateToolFromLoaderConfig(def.loaderConfig);

      // Register in your global tool registry
      // so that chatModel.enableTool(tName) can find it
      toolRegistry.register(toolObj);

      instantiatedTools.push(toolObj);
    }

    // If you like, store them on the model config for reference:
    modelCfg._resolvedTools = instantiatedTools;
    console.log(`Model "${modelName}" loaded tools:`, finalToolNames);
  }
}
