// tools.mjs

import { ToolKind } from './tool-definition.mjs';

/**
 * Base class for all tools
 */
export class BaseTool {
  /**
   * @param {string} name - Tool name
   * @param {string} description - Tool description
   * @param {Object} inputSchema - JSON Schema for tool inputs
   * @param {string} [kind='server'] - Tool kind (server, client, mcp)
   */
  constructor(name, description, inputSchema, kind = ToolKind.SERVER) {
    this.name = name;
    this.description = description;
    this.input_schema = inputSchema;
    this.kind = kind;
  }

  /**
   * Check if this tool can be executed on the server
   * @returns {boolean}
   */
  isExecutable() {
    return this.kind !== ToolKind.CLIENT;
  }

  /**
   * Check if this is a client-side tool
   * @returns {boolean}
   */
  isClient() {
    return this.kind === ToolKind.CLIENT;
  }

  /**
   * Run the tool with given arguments
   * @param {Object} args - Tool arguments
   * @returns {Promise<any>} Tool result
   */
  async run(args) {
    throw new Error('run() must be implemented by subclasses');
  }
}

/**
 * Stateless tool that performs operations without session context
 */
export class StatelessTool extends BaseTool {
  /**
   * @param {string} name - Tool name
   * @param {string} description - Tool description
   * @param {Object} inputSchema - JSON Schema for tool inputs
   * @param {Function} func - Function to execute
   */
  constructor(name, description, inputSchema, func) {
    super(name, description, inputSchema);
    this.func = func;
  }

  async run(args) {
    return await this.func(args);
  }
}


/**
 * Global registry for tools
 */
class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  /**
   * Register a new tool
   * @param {BaseTool} tool - The tool to register
   */
  register(tool) {
    if (this.tools.has(tool.name)) {
      // throw new Error(`Tool with name ${tool.name} already registered`);
      console.warn(`[ToolRegistry] Tool "${tool.name}" already registered; skipping duplicate.`);
      return;

    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Get a tool by name
   * @param {string} name - Tool name
   * @returns {BaseTool} The requested tool, or null if not found
   */
  getTool(name) {
    const tool = this.tools.get(name);
    return tool;
  }

  /**
   * Get all tools of a specific kind
   * @param {string} kind - Tool kind (server, client, mcp)
   * @returns {Map<string, BaseTool>} Map of tools with the specified kind
   */
  getToolsByKind(kind) {
    const result = new Map();
    for (const [name, tool] of this.tools) {
      if (tool.kind === kind) {
        result.set(name, tool);
      }
    }
    return result;
  }

  /**
   * Check if any of the given tool names are client tools
   * @param {string[]} toolNames - Array of tool names to check
   * @returns {boolean} True if any tool is a client tool
   */
  hasClientTools(toolNames) {
    for (const name of toolNames) {
      const tool = this.tools.get(name);
      if (tool && tool.kind === ToolKind.CLIENT) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all registered tool names
   * @returns {string[]} Array of tool names
   */
  getAllToolNames() {
    return Array.from(this.tools.keys());
  }

}

// Export singleton instance
export const toolRegistry = new ToolRegistry();

