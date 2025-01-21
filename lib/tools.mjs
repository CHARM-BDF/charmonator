// tools.mjs



/**
 * Base class for all tools
 */
export class BaseTool {
  constructor(name, description, inputSchema) {
    this.name = name;
    this.description = description;
    this.input_schema = inputSchema;
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
 * Session-bound tool that maintains state within a chat session
 */
export class SessionTool extends BaseTool {
  /**
   * @param {string} name - Tool name
   * @param {string} description - Tool description
   * @param {Object} inputSchema - JSON Schema for tool inputs
   * @param {Function} func - Function to execute (will be bound to session)
   */
  constructor(name, description, inputSchema, func) {
    super(name, description, inputSchema);
    this.func = func;
    this._boundSessions = new WeakMap(); // Store session-bound functions
  }

  /**
   * Bind this tool to a specific chat session
   * @param {ChatSession} session - The chat session to bind to
   * @returns {SessionTool} This tool instance
   */
  bindSession(session) {
    // Create a context object that will be 'this' in the function
    const context = {
      session,
      getSessionData: () => {
        if (!session.toolData) {
          session.toolData = new Map();
        }
        if (!session.toolData.has(this.name)) {
          session.toolData.set(this.name, {});
        }
        return session.toolData.get(this.name);
      }
    };

    // Store the bound function in our WeakMap
    this._boundSessions.set(session, this.func.bind(context));
    return this;
  }

  /**
   * Run the tool in the context of its bound session
   * @param {Object} args - Tool arguments
   * @param {ChatSession} session - The chat session making the call
   * @returns {Promise<any>} Tool result
   */
  async run(args, session) {
    if (!session) {
      throw new Error('SessionTool requires a session to run');
    }

    const boundFunc = this._boundSessions.get(session);
    if (!boundFunc) {
      throw new Error('Tool not bound to this session');
    }

    return await boundFunc(args);
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
   * @returns {BaseTool} The requested too, or null if not found
   */
  getTool(name) {
    const tool = this.tools.get(name);
    /*
    if (!tool) {
      throw new Error(`Tool ${name} not found`);
    }
    */
    return tool;
  }

  /**
   * Create a session-specific copy of tools
   * @param {ChatSession} session - The chat session to bind tools to
   * @returns {Map<string, BaseTool>} Map of tool names to bound tools
   */
  getSessionTools(session) {
    const sessionTools = new Map();
    
    for (const [name, tool] of this.tools) {
      if (tool instanceof SessionTool) {
        sessionTools.set(name, tool.bindSession(session));
      } else {
        sessionTools.set(name, tool);
      }
    }
    
    return sessionTools;
  }
}

// Export singleton instance
export const toolRegistry = new ToolRegistry();

