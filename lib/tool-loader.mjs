/**
 * tool-loader.mjs
 *
 * Implements a config-driven tool loader supporting both legacy and new formats.
 *
 * NEW FORMAT (toolbox-based):
 * {
 *   "toolboxes": {
 *     "builtins": { "code": "./tools/builtins.mjs" }
 *   },
 *   "tools": {
 *     "server": {
 *       "calculator": { "from": "builtins", "export": "CalculatorTool", "options": {} }
 *     },
 *     "client": {
 *       "open_file": { "from": "client_tools", "export": "OpenFileTool" }
 *     }
 *   },
 *   "models": {
 *     "gpt-4o": {
 *       "tools": { "server": ["calculator"], "client": [], "mcp": [] }
 *     }
 *   }
 * }
 *
 * LEGACY FORMAT (still supported):
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

// Cache for loaded toolbox modules
const toolboxCache = new Map();

/**
 * Detect if config uses new format (has toolboxes or tools.server/tools.client)
 */
function isNewFormat(config) {
  return config.toolboxes ||
         (config.tools && (config.tools.server || config.tools.client));
}

// ============================================================================
// NEW FORMAT LOADERS
// ============================================================================

/**
 * Load all toolbox modules from config
 * @param {Object} config - Full config object
 */
export async function loadToolboxes(config) {
  const toolboxes = config.toolboxes || {};

  for (const [boxId, boxConfig] of Object.entries(toolboxes)) {
    try {
      let modulePath = boxConfig.code || boxConfig.package;

      // Handle relative paths (resolve from charmonator root, not cwd)
      if (modulePath.startsWith('./') || modulePath.startsWith('../')) {
        modulePath = pathToFileURL(path.resolve(CHARMONATOR_ROOT, modulePath)).href;
      }

      const mod = await import(modulePath);
      toolboxCache.set(boxId, {
        module: mod,
        options: boxConfig.options || {}
      });
      console.log(`[ToolLoader] Loaded toolbox: ${boxId}`);
    } catch (error) {
      console.error(`[ToolLoader] Failed to load toolbox ${boxId}:`, error.message);
    }
  }
}

/**
 * Load server tools from config.tools.server
 * @param {Object} config - Full config object
 */
export async function loadServerTools(config) {
  const serverTools = config.tools?.server || {};

  for (const [toolId, toolConfig] of Object.entries(serverTools)) {
    await loadToolFromConfig(toolId, toolConfig, ToolKind.SERVER);
  }
}

/**
 * Load client tools from config.tools.client
 * (These are schema-only on the server, but we register them for reference)
 * @param {Object} config - Full config object
 */
export async function loadClientTools(config) {
  const clientTools = config.tools?.client || {};

  for (const [toolId, toolConfig] of Object.entries(clientTools)) {
    await loadToolFromConfig(toolId, toolConfig, ToolKind.CLIENT);
  }
}

/**
 * Load a single tool from toolbox-based config
 * @param {string} toolId - Tool identifier in config
 * @param {Object} toolConfig - Tool configuration { from, export, options, toolName }
 * @param {string} kind - Tool kind (server, client, mcp)
 */
async function loadToolFromConfig(toolId, toolConfig, kind) {
  const { from: boxId, export: exportName, options, toolName } = toolConfig;

  const box = toolboxCache.get(boxId);
  if (!box) {
    console.error(`[ToolLoader] Toolbox not found: ${boxId} (for tool ${toolId})`);
    return;
  }

  const ToolExport = box.module[exportName];
  if (!ToolExport) {
    console.error(`[ToolLoader] Export ${exportName} not found in toolbox ${boxId}`);
    return;
  }

  // Merge toolbox options with tool-specific options
  const mergedOptions = { ...box.options, ...options };

  let toolDef;
  try {
    if (typeof ToolExport === 'function') {
      // Could be a class constructor or factory function
      try {
        // Try as class constructor
        const instance = new ToolExport(mergedOptions);
        toolDef = new ToolDefinition({
          kind,
          name: toolName || instance.name || toolId,
          description: instance.description,
          input_schema: instance.input_schema,
          run: kind !== ToolKind.CLIENT ? instance.run?.bind(instance) : undefined,
          meta: { toolId, source: 'config', options: mergedOptions }
        });
      } catch (e) {
        // Try as factory function
        const instance = ToolExport(mergedOptions);
        if (instance && instance.input_schema) {
          toolDef = new ToolDefinition({
            kind,
            name: toolName || instance.name || toolId,
            description: instance.description,
            input_schema: instance.input_schema,
            run: kind !== ToolKind.CLIENT ? instance.run : undefined,
            meta: { toolId, source: 'config', options: mergedOptions }
          });
        }
      }
    } else if (typeof ToolExport === 'object' && ToolExport.input_schema) {
      // Plain descriptor object
      toolDef = new ToolDefinition({
        kind,
        name: toolName || ToolExport.name || toolId,
        description: ToolExport.description,
        input_schema: ToolExport.input_schema,
        run: kind !== ToolKind.CLIENT ? ToolExport.run : undefined,
        meta: { toolId, source: 'config', options: mergedOptions }
      });
    }

    if (toolDef) {
      toolRegistry.register(toolDef);
      console.log(`[ToolLoader] Registered ${kind} tool: ${toolDef.name}`);
    }
  } catch (error) {
    console.error(`[ToolLoader] Error loading tool ${toolId}:`, error.message);
  }
}

/**
 * Initialize all tools using the new format
 * @param {Object} config - Full config object
 */
export async function initAllToolsNewFormat(config) {
  await loadToolboxes(config);
  await loadServerTools(config);
  await loadClientTools(config);
  // MCP tools are loaded by MCPManager separately
}

/**
 * Validate and expand model tool references for new format
 * @param {Object} config - Full config object
 */
export function validateModelToolRefs(config) {
  if (!config.models) return;

  for (const [modelName, modelCfg] of Object.entries(config.models)) {
    if (typeof modelCfg === 'string') continue; // Skip aliases

    const toolRefs = modelCfg.tools || {};
    const serverRefs = toolRefs.server || toolRefs || []; // Fallback to flat array
    const clientRefs = toolRefs.client || [];
    const mcpRefs = toolRefs.mcp || [];

    // Validate each reference exists
    for (const ref of [...serverRefs, ...clientRefs, ...mcpRefs]) {
      if (typeof ref === 'string' && !toolRegistry.getTool(ref)) {
        console.warn(`[ToolLoader] Model "${modelName}" references unknown tool: ${ref}`);
      }
    }
  }
}

// ============================================================================
// LEGACY FORMAT LOADERS (for backward compatibility)
// ============================================================================

/**
 * Parse out the top-level `config.tools` object (legacy format)
 */
export function loadToolDefinitionsFromConfig(config) {
  // Check for new format first
  if (isNewFormat(config)) {
    // Return empty map - new format uses different flow
    return new Map();
  }

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
  // Check for new format first
  if (isNewFormat(config)) {
    await initAllToolsNewFormat(config);
    validateModelToolRefs(config);
    return;
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

// ============================================================================
// UNIFIED ENTRY POINT
// ============================================================================

/**
 * Initialize all tools from config (handles both new and legacy formats)
 * @param {Object} config - Full config object
 */
export async function initAllTools(config) {
  if (isNewFormat(config)) {
    await initAllToolsNewFormat(config);
    validateModelToolRefs(config);
  } else {
    const definitions = loadToolDefinitionsFromConfig(config);
    await initModelTools(config, definitions);
  }
}

/**
 * Clear the toolbox cache (for testing)
 */
export function clearToolboxCache() {
  toolboxCache.clear();
}
