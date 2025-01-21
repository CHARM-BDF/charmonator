// function.mjs

export class FunctionTool {
  constructor(func) {
    this.func = func;
    this.name = func.name;
    this.description = parseDescription(func);
    this.input_schema = functionParamsToJSONSchema(func);
  }

  async run(args) {
    return await this.func(args);
  }
}

// Helper functions to parse function metadata and generate JSON Schemas

// TODO: Fix this function to correctly parse multiline comments, and to pull out only the description for the description:

function parseDescription(func) {
  // Use the function's documentation string (comment) as the description
  const regex = /\/\*\*(.*?)\*\//s;
  const match = func.toString().match(regex);
  if (match) {
    return match[1].trim();
  }
  return 'No description available.';
}

// TODO: Fix this to handle multiline comments and parameters, and to parse parameters out of the docstrings:

function functionParamsToJSONSchema(func) {
  // Use the function's parameter definitions to generate a JSON Schema
  const params = func.toString().match(/\(([^)]*)\)/)[1];
  const paramNames = params.split(',').map(p => p.trim().split('=')[0]);

  const schema = {
    type: 'object',
    properties: {},
    required: [],
  };

  for (const paramName of paramNames) {
    // For simplicity, assume all parameters are of type 'any'
    schema.properties[paramName] = { type: 'any', description: '' };
    schema.required.push(paramName);
  }

  return schema;
}
