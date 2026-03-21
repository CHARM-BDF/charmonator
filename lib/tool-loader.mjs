/**
 * tool-loader.mjs
 *
 * Implements a config-driven tool loader for the legacy tool format.
 *
 * LEGACY FORMAT:
 * {
 *   "tools": {
 *     "web_search": { "code": "./tools/web_search.mjs", "class": "WebSearchTool" },
 *     "my_box": { "toolbox": ["web_search"] }
 *   },
 *   "models": {
 *     "gpt-4o": { "tools": ["web_search", "my_box"] }
 *   }
 * }
 */

import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import { toolRegistry } from './tools.mjs';
import { ToolKind, ToolDefinition } from './tool-definition.mjs';

// Get the charmonator root directory (parent of lib/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHARMONATOR_ROOT = path.resolve(__dirname, '..');

/**
 * Parse out the top-level `config.tools` object (legacy format)
 */
export function loadToolDefinitionsFromConfig(config) {
  const toolEntries = config.tools || {};
  const definitions = new Map();

  for (const [toolName, toolConf] of Object.entries(toolEntries)) {
    if (toolConf.toolbox) {
      // This entry is a "toolbox" containing an array of child names
      definitions.set(toolName, {
        type: 'toolbox',
        childRefs: toolConf.toolbox
      });
    } else {
      // This entry is a "single" tool definition
      definitions.set(toolName, {
        type: 'single',
        loaderConfig: toolConf
      });
    }
  }
  return definitions;
}

/**
 * Expand a tool reference that might be a single tool or a toolbox (legacy format)
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
    return [toolName];
  }
}

/**
 * Dynamically instantiate a single tool from its loaderConfig (legacy format)
 */
export async function instantiateToolFromLoaderConfig(loaderConfig) {
  const { package: pkg, code, class: className, options } = loaderConfig;

  let ToolClass = null;

  if (pkg) {
    const mod = await import(pkg);
    if (!className) {
      throw new Error(`loaderConfig requires "class" when using "package". config=${JSON.stringify(loaderConfig)}`);
    }
    ToolClass = mod[className];
    if (!ToolClass) {
      throw new Error(`No export named "${className}" in package "${pkg}"`);
    }
  }
  else if (code) {
    let modulePath = code;
    // Resolve relative paths from charmonator root, not cwd
    if (code.startsWith('./') || code.startsWith('../')) {
      modulePath = pathToFileURL(path.resolve(CHARMONATOR_ROOT, code)).href;
    }
    const mod = await import(modulePath);
    if (className) {
      ToolClass = mod[className];
      if (!ToolClass) {
        throw new Error(`No export named "${className}" in file "${code}"`);
      }
    } else if (mod.default) {
      ToolClass = mod.default;
    } else {
      throw new Error(`No "class" specified, and no default export found in "${code}"`);
    }
  }
  else {
    throw new Error(`Tool loaderConfig must have either "package" or "code". config=${JSON.stringify(loaderConfig)}`);
  }

  const instance = new ToolClass(options);
  // Set default kind to server for legacy tools
  if (!instance.kind) {
    instance.kind = ToolKind.SERVER;
  }
  return instance;
}

/**
 * For each model in the config, gather and instantiate tools (legacy format)
 */
export async function initModelTools(config, definitions) {
  // Compatibility: if MCP is configured, treat any model-level tool references
  // that aren't legacy config.tools entries as MCP tools. This supports configs
  // where models specify tools: ["echo"] and MCP tool aliases live under config.mcp.tools.
  const hasMcp = !!(config.mcp && (config.mcp.servers || config.mcp.tools));
  if (hasMcp && config.models) {
    for (const [modelName, modelCfg] of Object.entries(config.models)) {
      if (typeof modelCfg === 'string') continue;
      if (!Array.isArray(modelCfg.tools)) continue;

      const legacyRefs = modelCfg.tools;
      const remainingRefs = [];

      for (const refName of legacyRefs) {
        if (definitions.has(refName)) {
          remainingRefs.push(refName);
        } else {
          // Assume it's an MCP tool alias/name.
          if (!modelCfg._mcp_tools) modelCfg._mcp_tools = [];
          modelCfg._mcp_tools.push(refName);
        }
      }

      // Keep legacy refs only.
      modelCfg.tools = remainingRefs;
      if (modelCfg._mcp_tools.length > 0) {
        console.log(`Model "${modelName}" MCP tools:`, modelCfg._mcp_tools);
      }
    }
  }

  // Legacy format processing
  if (!config.models) return;

  for (const [modelName, modelCfg] of Object.entries(config.models)) {
    if (typeof modelCfg === 'string') {
      continue;
    }
    const toolRefs = modelCfg.tools || [];
    let finalToolNames = [];

    for (const refName of toolRefs) {
      const expanded = expandToolRefs(refName, definitions);
      finalToolNames = finalToolNames.concat(expanded);
    }
    finalToolNames = [...new Set(finalToolNames)];

    const instantiatedTools = [];
    const loadedToolNames = [];
    for (const tName of finalToolNames) {
      const def = definitions.get(tName);
      if (!def) {
        console.warn(`[ToolLoader] No definition for tool "${tName}" (model="${modelName}"), skipping`);
        continue;
      }
      if (def.type !== 'single') {
        continue;
      }

      try {
        const toolObj = await instantiateToolFromLoaderConfig(def.loaderConfig);
        toolRegistry.register(toolObj);
        instantiatedTools.push(toolObj);
        loadedToolNames.push(tName);
      } catch (error) {
        console.warn(`[ToolLoader] Failed to load tool "${tName}": ${error.message}`);
      }
    }

    modelCfg._resolvedTools = instantiatedTools;
    if (loadedToolNames.length > 0) {
      console.log(`Model "${modelName}" loaded tools:`, loadedToolNames);
    }
  }
}
