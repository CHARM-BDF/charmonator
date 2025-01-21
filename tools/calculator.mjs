// calculator.js
//
// A simple calculator tool that parses an arithmetic expression from the args
// and returns a numeric result.  By default, it rounds the result to a
// specified number of decimal places (precision).

import { create, all } from 'mathjs';

// If you have a local "BaseTool" or "StatelessTool" in your code, import it here:
// e.g.:
import { BaseTool } from '../lib/tools.mjs';  // Adjust path as necessary

// Create a mathjs instance with default configuration:
const math = create(all, {});

export default class CalculatorTool extends BaseTool {
  constructor(options = {}) {
    // Provide a name, short description, and a JSON schema describing the input
    super(
      'calculator',
      'A basic arithmetic expression evaluator. Provide an expression string and returns the result.',
      {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'An arithmetic expression, e.g. "3 + 4 * 2"'
          }
        },
        required: ['expression']
      }
    );

    // Extract the "precision" field from the config options (default 8)
    this.precision = options.precision ?? 8;
  }

  /**
   * Execute the tool with the given arguments.
   * @param {Object} args
   * @param {string} args.expression  The arithmetic expression to evaluate
   * @returns {Promise<string>}       The stringified result
   */
  async run(args) {
    console.log('[CalculatorTool] Running with args:', args);

    // Ensure the expression is a string
    const expr = String(args.expression || '').trim();

    // Validate non-empty
    if (!expr) {
      throw new Error('[CalculatorTool] No expression provided');
    }

    try {
      // Evaluate using mathjs
      const result = math.evaluate(expr);  

      // Convert the result to a number (some mathjs ops can yield arrays/objects)
      if (typeof result === 'number') {
        // Round to the configured precision
        return result.toFixed(this.precision);
      } else if (Array.isArray(result)) {
        // e.g. user typed something that yields a vector/matrix
        return result.map((n) => Number(n).toFixed(this.precision)).join(', ');
      } else {
        // If it's something else we can't handle easily, just JSON-stringify
        return JSON.stringify(result);
      }
    } catch (err) {
      throw new Error(`[CalculatorTool] Error evaluating "${expr}": ${err.message}`);
    }
  }
}
