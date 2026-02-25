/**
 * tools/translator/translator_tool.mjs
 *
 * BaseTool subclass that wraps the Translator/ARS processing logic
 * for use as a native charmonator tool (LLM function calling).
 */

import { BaseTool } from '../../lib/tools.mjs';
import {
  URL_DICT,
  processTranslatorData,
  generateCSVContent,
  computeSummaryStats,
  createTranslatorKnowledgeGraph
} from './translator_core.mjs';

export default class TranslatorTool extends BaseTool {
  constructor(options = {}) {
    super(
      'process_translator_query',
      'Process a Translator/ARS biomedical query by PK (primary key). ' +
      'Fetches results from the NCATS Translator Automated Relay System, ' +
      'parses knowledge graphs with nodes, edges, qualifiers, and scores from ' +
      'multiple ARAs (ARAX, Improving Agent, BioThings Explorer, Unsecret Agent, Aragorn), ' +
      'and returns structured biomedical relationship data with human-readable phrases.',
      {
        type: 'object',
        properties: {
          pk: {
            type: 'string',
            description: 'The primary key (PK/UUID) of the Translator query to process (e.g., "992cc304-b1cd-4e9d-b317-f65effe150e1")'
          },
          environment: {
            type: 'string',
            enum: Object.keys(URL_DICT),
            description: 'The Translator environment to query (default: prod)',
            default: 'prod'
          },
          format: {
            type: 'string',
            enum: ['summary', 'full', 'csv'],
            description: 'Output format: "summary" for stats + sample rows, "full" for all data, "csv" for CSV string',
            default: 'summary'
          }
        },
        required: ['pk']
      }
    );

    this.defaultEnvironment = options.defaultEnvironment || 'prod';
  }

  async run(args) {
    console.log('[TranslatorTool] Running with args:', args);

    const pk = String(args.pk || '').trim();
    if (!pk) {
      throw new Error('[TranslatorTool] pk parameter is required');
    }

    const environment = args.environment || this.defaultEnvironment;
    const format = args.format || 'summary';

    const processedData = await processTranslatorData(pk, environment);

    if (processedData.length === 0) {
      return JSON.stringify({
        pk,
        environment,
        error: 'No results found',
        message: `No biomedical relationships were found for PK: ${pk}. ` +
                 'The PK may not exist, the query may have returned no results, ' +
                 'or there may have been an API connectivity issue.'
      });
    }

    if (format === 'csv') {
      return generateCSVContent(processedData);
    }

    const stats = computeSummaryStats(processedData, pk, environment);
    const knowledgeGraph = createTranslatorKnowledgeGraph(processedData, pk);

    if (format === 'full') {
      return JSON.stringify({
        stats,
        knowledgeGraph,
        data: processedData
      });
    }

    // summary format (default)
    const sampleRows = processedData.slice(0, 10).map(row => ({
      phrase: row.phrase,
      predicate: row.predicate,
      subject: row.result_subjectNode_name,
      object: row.result_objectNode_name,
      ara: row.ara,
      edge_type: row.edge_type,
      rank: row.rank
    }));

    return JSON.stringify({
      stats,
      knowledgeGraph: {
        nodeCount: knowledgeGraph.nodes.length,
        linkCount: knowledgeGraph.links.length
      },
      sampleRelationships: sampleRows
    });
  }
}
