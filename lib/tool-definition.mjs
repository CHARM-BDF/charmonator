// tool-definition.mjs
// Defines tool kinds and a unified ToolDefinition structure

/**
 * Tool execution domains
 */
export const ToolKind = {
  SERVER: 'server',   // Executed on the server
  CLIENT: 'client',   // Executed by the client (schema only on server)
  MCP: 'mcp'          // Executed via MCP server proxy
};

/**
 * Unified tool definition that supports all tool kinds
 */
export class ToolDefinition {
  /**
   * @param {Object} config - Tool configuration
   * @param {string} config.kind - Tool kind (server, client, mcp)
   * @param {string} config.name - Tool name (model-visible)
   * @param {string} config.description - Tool description
   * @param {Object} config.input_schema - JSON Schema for tool inputs
   * @param {Function} [config.run] - Execution function (server/mcp only)
   * @param {Object} [config.meta] - Additional metadata
   */
  constructor({ kind, name, description, input_schema, run, meta }) {
    this.kind = kind || ToolKind.SERVER;
    this.name = name;
    this.description = description;
    this.input_schema = input_schema;
    this.run = run;  // undefined for client tools
    this.meta = meta || {};
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
   * Check if this is an MCP tool
   * @returns {boolean}
   */
  isMCP() {
    return this.kind === ToolKind.MCP;
  }

  /**
   * Convert to provider-friendly format (for API calls)
   * @returns {Object}
   */
  toProviderFormat() {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema
    };
  }

  /**
   * Convert to JSON-serializable format
   * @returns {Object}
   */
  toJSON() {
    return {
      kind: this.kind,
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
      meta: this.meta
    };
  }
}
