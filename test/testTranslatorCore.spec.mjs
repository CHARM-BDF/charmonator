/**
 * test/testTranslatorCore.spec.mjs
 *
 * Unit tests for translator core processing logic.
 * These tests use mock data and require no network access.
 */

import { strict as assert } from 'assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import {
  URL_DICT,
  recombobulation,
  getEdge,
  escapeCSVField,
  generateCSVContent,
  getEntityTypeFromCurie,
  createTranslatorKnowledgeGraph,
  computeSummaryStats
} from '../tools/translator/translator_core.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load mock data
const mockMerged = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'translator_mock_merged.json'), 'utf-8')
);

// Suppress log output during tests
const silentLog = () => {};

describe('Translator Core', function () {

  describe('URL_DICT', function () {
    it('should have four environments', function () {
      assert.deepStrictEqual(Object.keys(URL_DICT).sort(), ['CI', 'dev', 'prod', 'test']);
    });

    it('should have valid URLs for all environments', function () {
      for (const url of Object.values(URL_DICT)) {
        assert(url.startsWith('https://'), `Expected HTTPS URL, got: ${url}`);
      }
    });
  });

  describe('recombobulation()', function () {
    it('should produce a basic phrase with no qualifiers', function () {
      const phrase = recombobulation({
        edge_subjectNode_name: 'metformin',
        edge_objectNode_name: 'diabetes',
        predicate: 'biolink:treats'
      });
      assert.strictEqual(phrase, 'metformin treats diabetes');
    });

    it('should use qualified_predicate when present', function () {
      const phrase = recombobulation({
        edge_subjectNode_name: 'Drug A',
        edge_objectNode_name: 'Disease B',
        predicate: 'biolink:affects',
        qualified_predicate: 'causes',
        object_direction_qualifier: 'decreased',
        object_aspect_qualifier: 'activity'
      });
      assert.strictEqual(phrase, 'Drug A causes decreased activity of Disease B');
    });

    it('should handle caused_by qualified_predicate', function () {
      const phrase = recombobulation({
        edge_subjectNode_name: 'Gene X',
        edge_objectNode_name: 'Condition Y',
        predicate: 'biolink:related_to',
        qualified_predicate: 'caused_by',
        subject_direction_qualifier: 'increased',
        subject_aspect_qualifier: 'expression'
      });
      assert.strictEqual(phrase, 'increased expression of Condition Y is caused by Gene X');
    });

    it('should handle downregulated direction qualifier', function () {
      const phrase = recombobulation({
        edge_subjectNode_name: 'Drug',
        edge_objectNode_name: 'Gene',
        predicate: 'biolink:affects',
        qualified_predicate: 'something',
        object_direction_qualifier: 'downregulated'
      });
      assert(phrase.includes('downregulated'), `Expected downregulated in phrase: ${phrase}`);
    });

    it('should handle abundance aspect qualifier', function () {
      const phrase = recombobulation({
        edge_subjectNode_name: 'X',
        edge_objectNode_name: 'Y',
        predicate: 'biolink:affects',
        qualified_predicate: 'causes',
        object_direction_qualifier: 'increased',
        object_aspect_qualifier: 'abundance'
      });
      assert(phrase.includes('the abundance'), `Expected 'the abundance' in phrase: ${phrase}`);
    });

    it('should remove underscores and collapse spaces', function () {
      const phrase = recombobulation({
        edge_subjectNode_name: 'A',
        edge_objectNode_name: 'B',
        predicate: 'biolink:gene_associated_with_condition'
      });
      assert(!phrase.includes('_'), 'Should not contain underscores');
      assert(!phrase.includes('  '), 'Should not contain double spaces');
    });
  });

  describe('escapeCSVField()', function () {
    it('should return plain strings unquoted', function () {
      assert.strictEqual(escapeCSVField('hello'), 'hello');
    });

    it('should quote strings containing commas', function () {
      assert.strictEqual(escapeCSVField('a,b'), '"a,b"');
    });

    it('should quote strings containing quotes and escape inner quotes', function () {
      assert.strictEqual(escapeCSVField('say "hi"'), '"say ""hi"""');
    });

    it('should quote strings containing newlines', function () {
      assert.strictEqual(escapeCSVField('line1\nline2'), '"line1\nline2"');
    });

    it('should handle null/undefined by converting to empty string', function () {
      assert.strictEqual(escapeCSVField(null), '');
      assert.strictEqual(escapeCSVField(undefined), '');
    });

    it('should convert numbers to strings', function () {
      assert.strictEqual(escapeCSVField(42), '42');
    });

    it('should convert booleans to strings', function () {
      assert.strictEqual(escapeCSVField(true), 'true');
      // false is falsy so (false || '') yields '' -- matches original behavior
      assert.strictEqual(escapeCSVField(false), '');
    });
  });

  describe('getEntityTypeFromCurie()', function () {
    it('should classify CHEBI as Drug/Chemical', function () {
      const result = getEntityTypeFromCurie('CHEBI:6801');
      assert.strictEqual(result.type, 'Drug/Chemical');
      assert.strictEqual(result.group, 1);
    });

    it('should classify NCBIGene as Gene', function () {
      const result = getEntityTypeFromCurie('NCBIGene:6531');
      assert.strictEqual(result.type, 'Gene');
      assert.strictEqual(result.group, 2);
    });

    it('should classify MONDO as Disease/Phenotype', function () {
      const result = getEntityTypeFromCurie('MONDO:0005148');
      assert.strictEqual(result.type, 'Disease/Phenotype');
      assert.strictEqual(result.group, 3);
    });

    it('should classify GO as Biological Process', function () {
      const result = getEntityTypeFromCurie('GO:0006954');
      assert.strictEqual(result.type, 'Biological Process');
      assert.strictEqual(result.group, 4);
    });

    it('should classify UniProtKB as Protein', function () {
      const result = getEntityTypeFromCurie('UniProtKB:P12345');
      assert.strictEqual(result.type, 'Protein');
      assert.strictEqual(result.group, 7);
    });

    it('should classify HGNC as Gene', function () {
      const result = getEntityTypeFromCurie('HGNC:10936');
      assert.strictEqual(result.type, 'Gene');
      assert.strictEqual(result.group, 2);
    });

    it('should classify unknown prefix as Other', function () {
      const result = getEntityTypeFromCurie('UNKNOWN:999');
      assert.strictEqual(result.type, 'Other');
      assert.strictEqual(result.group, 8);
    });

    it('should classify DRUGBANK as Drug/Chemical', function () {
      const result = getEntityTypeFromCurie('DRUGBANK:DB00331');
      assert.strictEqual(result.type, 'Drug/Chemical');
      assert.strictEqual(result.group, 1);
    });
  });

  describe('getEdge() with mock data', function () {
    it('should process a simple edge and push to allRows', function () {
      const message = mockMerged.fields.data.message;
      const context = {
        allRows: [],
        edges: message.knowledge_graph.edges,
        nodes: message.knowledge_graph.nodes,
        auxiliaryGraphs: message.auxiliary_graphs || {},
        processedEdgeIds: new Set(),
        log: silentLog
      };

      const rowData = {
        pk: 'test-pk',
        ara: 'infores:aragorn',
        result_subjectNode_name: 'metformin',
        result_subjectNode_id: 'CHEBI:6801',
        result_subjectNode_cat: 'biolink:SmallMolecule',
        result_objectNode_name: 'type 2 diabetes mellitus',
        result_objectNode_id: 'MONDO:0005148',
        result_objectNode_cat: 'biolink:Disease',
        rank: 1,
        result_counter: 1
      };

      getEdge(context, rowData, 'edge-001');

      assert(context.allRows.length >= 1, 'Should have at least one row');
      const row = context.allRows[0];
      assert.strictEqual(row.edge_id, 'edge-001');
      assert.strictEqual(row.predicate, 'biolink:treats');
      assert.strictEqual(row.primary_source, 'infores:chembl');
      assert.strictEqual(row.qualified_predicate, 'causes');
      assert.strictEqual(row.object_direction_qualifier, 'decreased');
      assert.strictEqual(row.publications_count, 2);
      assert(row.phrase, 'Should have a phrase');
      assert(context.processedEdgeIds.has('edge-001'));
    });

    it('should handle missing edge gracefully', function () {
      const context = {
        allRows: [],
        edges: {},
        nodes: {},
        auxiliaryGraphs: {},
        processedEdgeIds: new Set(),
        log: silentLog
      };

      getEdge(context, {}, 'nonexistent-edge');
      assert.strictEqual(context.allRows.length, 0, 'Should not push any rows for missing edge');
    });

    it('should process support graphs recursively', function () {
      const message = mockMerged.fields.data.message;
      const context = {
        allRows: [],
        edges: message.knowledge_graph.edges,
        nodes: message.knowledge_graph.nodes,
        auxiliaryGraphs: message.auxiliary_graphs || {},
        processedEdgeIds: new Set(),
        log: silentLog
      };

      const rowData = {
        pk: 'test-pk',
        ara: 'infores:improving-agent',
        result_subjectNode_name: 'SLC7A10',
        result_subjectNode_id: 'HGNC:10936',
        result_objectNode_name: 'type 2 diabetes mellitus',
        result_objectNode_id: 'MONDO:0005148',
        result_counter: 3
      };

      getEdge(context, rowData, 'edge-003');

      // edge-003 has support graph with edge-support-001
      assert(context.allRows.length >= 2, `Expected >= 2 rows (main + support), got ${context.allRows.length}`);
      assert(context.processedEdgeIds.has('edge-003'));
      assert(context.processedEdgeIds.has('edge-support-001'));

      // The main edge should be creative type
      const mainEdge = context.allRows.find(r => r.edge_id === 'edge-003');
      assert.strictEqual(mainEdge.edge_type, 'creative');
    });
  });

  describe('generateCSVContent()', function () {
    it('should return empty string for empty data', function () {
      assert.strictEqual(generateCSVContent([]), '');
    });

    it('should produce valid CSV with headers and rows', function () {
      const data = [{
        pk: 'pk1', ara: 'ara1', result_subjectNode_name: 'Sub', result_subjectNode_id: 'S1',
        result_subjectNode_cat: 'cat1', result_objectNode_name: 'Obj', result_objectNode_id: 'O1',
        result_objectNode_cat: 'cat2', rank: 1, sugeno_score: 0.5, comp_confidence_score: 0.9,
        comp_novelty_score: 0.3, comp_clinical_evidence_score: 0.8, weighted_mean_score: 0.7,
        normalized_score: 85, ARAX: true, ARAX_score: 0.6, unsecret: false, unsecret_score: 0,
        improving_agent: false, improving_agent_score: 0, biothings_explorer: false,
        biothings_explorer_score: 0, aragorn: true, aragorn_score: 0.88, ARA_count: 2,
        result_counter: 1, edge_id: 'e1', edge_object: 'O1', edge_objectNode_name: 'Obj',
        edge_objectNode_cat: 'cat2', edge_subject: 'S1', edge_subjectNode_name: 'Sub',
        edge_subjectNode_cat: 'cat1', predicate: 'biolink:treats', edge_type: 'one-hop',
        qualified_predicate: '', phrase: 'Sub treats Obj', publications_count: 0,
        primary_source: 'infores:chembl', agg1: undefined, agg2: undefined
      }];

      const csv = generateCSVContent(data);
      const lines = csv.trim().split('\n');
      assert.strictEqual(lines.length, 2, 'Should have header + 1 data row');
      assert(lines[0].includes('PK'), 'Header should contain PK');
      assert(lines[0].includes('Human Readable Phrase'), 'Header should contain Human Readable Phrase');
      assert(lines[1].includes('pk1'), 'Data row should contain pk value');
    });
  });

  describe('createTranslatorKnowledgeGraph()', function () {
    it('should create nodes and links from processed data', function () {
      const data = [
        {
          result_subjectNode_id: 'CHEBI:6801',
          result_subjectNode_name: 'metformin',
          result_objectNode_id: 'MONDO:0005148',
          result_objectNode_name: 'type 2 diabetes mellitus',
          edge_id: 'e1',
          predicate: 'biolink:treats',
          qualified_predicate: '',
          normalized_score: 85,
          publications: ['PMID:123']
        },
        {
          result_subjectNode_id: 'NCBIGene:6531',
          result_subjectNode_name: 'SLC6A3',
          result_objectNode_id: 'MONDO:0005148',
          result_objectNode_name: 'type 2 diabetes mellitus',
          edge_id: 'e2',
          predicate: 'biolink:gene_associated_with_condition',
          qualified_predicate: '',
          normalized_score: 'N/A',
          publications: []
        }
      ];

      const graph = createTranslatorKnowledgeGraph(data, 'test-pk');

      assert.strictEqual(graph.nodes.length, 3, 'Should have 3 unique nodes');
      assert.strictEqual(graph.links.length, 2, 'Should have 2 links');

      const metforminNode = graph.nodes.find(n => n.id === 'CHEBI:6801');
      assert.strictEqual(metforminNode.entityType, 'Drug/Chemical');
      assert(metforminNode.connections > 0);

      const diabetesNode = graph.nodes.find(n => n.id === 'MONDO:0005148');
      assert.strictEqual(diabetesNode.entityType, 'Disease/Phenotype');
      assert.strictEqual(diabetesNode.connections, 2, 'Diabetes node should be target of both links');
    });

    it('should handle empty data', function () {
      const graph = createTranslatorKnowledgeGraph([], 'test-pk');
      assert.strictEqual(graph.nodes.length, 0);
      assert.strictEqual(graph.links.length, 0);
    });

    it('should deduplicate edges by edge_id', function () {
      const data = [
        {
          result_subjectNode_id: 'A:1', result_subjectNode_name: 'A',
          result_objectNode_id: 'B:1', result_objectNode_name: 'B',
          edge_id: 'same-edge', predicate: 'biolink:related_to',
          qualified_predicate: '', normalized_score: 50, publications: []
        },
        {
          result_subjectNode_id: 'A:1', result_subjectNode_name: 'A',
          result_objectNode_id: 'B:1', result_objectNode_name: 'B',
          edge_id: 'same-edge', predicate: 'biolink:related_to',
          qualified_predicate: '', normalized_score: 50, publications: []
        }
      ];

      const graph = createTranslatorKnowledgeGraph(data, 'pk');
      assert.strictEqual(graph.links.length, 1, 'Should deduplicate by edge_id');
    });
  });

  describe('computeSummaryStats()', function () {
    it('should compute correct stats from mock processed data', function () {
      const message = mockMerged.fields.data.message;
      const context = {
        allRows: [],
        edges: message.knowledge_graph.edges,
        nodes: message.knowledge_graph.nodes,
        auxiliaryGraphs: message.auxiliary_graphs || {},
        processedEdgeIds: new Set(),
        log: silentLog
      };

      // Process edges directly via context to build allRows
      const rowData = {
        pk: 'test-pk',
        ara: 'infores:aragorn',
        result_subjectNode_name: 'metformin',
        result_subjectNode_id: 'CHEBI:6801',
        result_subjectNode_cat: 'biolink:SmallMolecule',
        result_objectNode_name: 'type 2 diabetes mellitus',
        result_objectNode_id: 'MONDO:0005148',
        result_objectNode_cat: 'biolink:Disease',
        rank: 1,
        result_counter: 1
      };

      getEdge(context, rowData, 'edge-001');
      getEdge(context, rowData, 'edge-002');

      const stats = computeSummaryStats(context.allRows, 'test-pk', 'prod');
      assert.strictEqual(stats.pk, 'test-pk');
      assert.strictEqual(stats.environment, 'prod');
      assert(stats.totalRelationships >= 2);
      assert(stats.uniqueNodes >= 2);
    });
  });
});
