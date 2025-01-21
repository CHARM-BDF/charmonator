// web_search_tool.mjs

import { StatelessTool } from '../lib/tools.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const search = require('duckduckgo-search');

/**
 * Class version: extends StatelessTool
 */
export class WebSearchTool extends StatelessTool {
  constructor(options = {}) {
    // Call `super` with the name, description, schema, and the run function
    super(
      'web_search',
      'Search the web using DuckDuckGo. Returns up to 5 results (title, link, snippet).',
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query string to find relevant web pages'
          }
        },
        required: ['query']
      },
      async ({ query }) => {
        try {
          const searchIterator = search.text(query);
          const results = [];
          for await (const result of searchIterator) {
            results.push({
              title: result.title || 'No Title',
              link: result.link || result.href || '',
              snippet: result.body || result.description || 'No description available'
            });
            if (results.length >= 5) break; // limit to 5
          }
          return JSON.stringify(results);
        } catch (error) {
          console.error('Search error:', error);
          return JSON.stringify([{
            title: 'Search Error',
            link: null,
            snippet: `Unable to perform search: ${error.message}`
          }]);
        }
      }
    );

    // If you want, you can read any `options` here, e.g.:
    // this.defaultEngine = options.defaultEngine || 'duckduckgo';
  }
}
