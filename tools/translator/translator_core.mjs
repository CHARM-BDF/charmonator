/**
 * tools/translator/translator_core.mjs
 *
 * Core processing logic for NCATS Translator/ARS biomedical query results.
 * Ported from the translator-mcp TypeScript server to pure JavaScript.
 *
 * All functions are stateless -- mutable state is passed via a `context` object
 * created at the start of each processTranslatorData() call.
 */

// Environment URLs mapping
export const URL_DICT = {
  'test': 'https://ars.test.transltr.io',
  'CI': 'https://ars.ci.transltr.io',
  'dev': 'https://ars-dev.transltr.io',
  'prod': 'https://ars-prod.transltr.io'
};

/**
 * Default logger that writes to stderr.
 */
function defaultLog(message, data) {
  const timestamp = new Date().toISOString();
  const fullMessage = data ? `${message} | Data: ${JSON.stringify(data)}` : message;
  console.error(`[${timestamp}] TRANSLATOR: ${fullMessage}`);
}

/**
 * Make an API request to Translator/ARS.
 * @param {string} url - The URL to fetch
 * @param {object} [options] - Options including optional `log` callback
 * @returns {Promise<object|null>} Parsed JSON or null on failure
 */
export async function makeTranslatorRequest(url, options = {}) {
  const log = options.log || defaultLog;
  log(`Making API request to Translator`, { url });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 60000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Charmonator-Translator/1.0.0'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      log(`API request failed with status ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    log(`API request successful`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      log(`API request timed out after ${options.timeout || 60000}ms`);
    } else {
      log(`API request error: ${error}`);
    }
    return null;
  }
}

/**
 * Generate a human-readable phrase from edge qualifier data.
 * @param {object} edgeData - Partial row with qualifier fields
 * @returns {string} The inferred phrase
 */
export function recombobulation(edgeData) {
  const objectNodeName = edgeData.edge_objectNode_name || '';
  const subjectNodeName = edgeData.edge_subjectNode_name || '';
  let direction = '';
  let objectAspect = '';
  let subjectAspect = '';
  let objectOf = '';

  let predicateUsed = (edgeData.predicate || '').replace('biolink:', '');

  if (edgeData.qualified_predicate) {
    predicateUsed = edgeData.qualified_predicate.replace('biolink:', '');
  }

  if (edgeData.object_aspect_qualifier) {
    objectAspect = edgeData.object_aspect_qualifier;
    if (objectAspect === 'abundance') {
      objectAspect = 'the abundance';
    }
  }

  if (edgeData.subject_aspect_qualifier) {
    subjectAspect = edgeData.subject_aspect_qualifier;
    if (subjectAspect === 'abundance') {
      subjectAspect = 'the abundance';
    }
  }

  if (edgeData.object_direction_qualifier) {
    direction = edgeData.object_direction_qualifier;
    predicateUsed = 'causes';
    if (edgeData.object_direction_qualifier === 'downregulated') {
      predicateUsed = 'downregulated';
    }
  }

  if (edgeData.object_aspect_qualifier) {
    objectOf = 'of';
  }

  let inferredPhrase = 'DEFAULT PHRASE';

  if (edgeData.qualified_predicate === 'causes') {
    inferredPhrase = `${subjectNodeName} ${predicateUsed} ${direction} ${objectAspect} ${objectOf} ${objectNodeName}`;
  } else if (edgeData.qualified_predicate === 'caused_by') {
    inferredPhrase = `${edgeData.subject_direction_qualifier || ''} ${edgeData.subject_aspect_qualifier || ''} of ${objectNodeName} is ${edgeData.qualified_predicate} ${subjectNodeName}`;
  } else {
    inferredPhrase = `${subjectNodeName} ${predicateUsed} ${objectNodeName}`;
  }

  inferredPhrase = inferredPhrase.replace(/ +/g, ' ').replace(/_/g, ' ').trim();
  return inferredPhrase;
}

/**
 * Process a single edge from the knowledge graph.
 * Pushes processed row(s) into context.allRows.
 *
 * @param {object} context - Mutable context with allRows, edges, nodes, auxiliaryGraphs, processedEdgeIds
 * @param {object} rowResultData - Base row data from the result
 * @param {string} edgeId - The edge ID to process
 */
export function getEdge(context, rowResultData, edgeId) {
  const log = context.log || defaultLog;

  try {
    const edge = context.edges[edgeId];
    if (!edge) {
      log(`KeyError: The key ${edgeId} was not found in the 'edges' dictionary`);
      return;
    }

    context.processedEdgeIds.add(edgeId);

    const edgeObjectNodeId = edge.object;
    const edgeSubjectNodeId = edge.subject;

    const edgeSubjectNode = context.nodes[edgeSubjectNodeId];
    const edgeObjectNode = context.nodes[edgeObjectNodeId];

    const edgeSubjectNodeName = edgeSubjectNode?.name || 'not provided';
    const edgeSubjectNodeCats = edgeSubjectNode?.categories || ['not provided'];
    const edgeObjectNodeName = edgeObjectNode?.name || 'not provided';
    const edgeObjectNodeCats = edgeObjectNode?.categories || ['not provided'];

    let qualifiedPredicate = '';
    let causalMechanismQualifier = '';
    let objectDirectionQualifier = '';
    let subjectDirectionQualifier = '';
    let subjectFormOrVariantQualifier = '';
    let objectFormOrVariantQualifier = '';
    let objectAspectQualifier = '';
    let subjectAspectQualifier = '';

    const qualifiers = edge.qualifiers || [];
    for (const qualifier of qualifiers) {
      const qualifierType = qualifier.qualifier_type_id.split(':').pop();
      const qualifierValue = qualifier.qualifier_value.split(':').pop();

      switch (qualifierType) {
        case 'qualified_predicate':
          qualifiedPredicate = qualifierValue || '';
          break;
        case 'causal_mechanism_qualifier':
          causalMechanismQualifier = qualifierValue || '';
          break;
        case 'object_direction_qualifier':
          objectDirectionQualifier = qualifierValue || '';
          break;
        case 'subject_direction_qualifier':
          subjectDirectionQualifier = qualifierValue || '';
          break;
        case 'subject_form_or_variant_qualifier':
          subjectFormOrVariantQualifier = qualifierValue || '';
          break;
        case 'object_form_or_variant_qualifier':
          objectFormOrVariantQualifier = qualifierValue || '';
          break;
        case 'object_aspect_qualifier':
          objectAspectQualifier = qualifierValue || '';
          break;
        case 'subject_aspect_qualifier':
          subjectAspectQualifier = qualifierValue || '';
          break;
      }
    }

    const edgeData = {
      edge_id: edgeId,
      edge_object: edge.object,
      edge_objectNode_name: edgeObjectNodeName,
      edge_objectNode_cats: edgeObjectNodeCats,
      edge_objectNode_cat: edgeObjectNodeCats[0],
      edge_subject: edge.subject,
      edge_subjectNode_name: edgeSubjectNodeName,
      edge_subjectNode_cats: edgeSubjectNodeCats,
      edge_subjectNode_cat: edgeSubjectNodeCats[0],
      predicate: edge.predicate,
      edge_type: 'one-hop',
      qualified_predicate: qualifiedPredicate,
      causal_mechanism_qualifier: causalMechanismQualifier,
      subject_direction_qualifier: subjectDirectionQualifier,
      subject_aspect_qualifier: subjectAspectQualifier,
      subject_form_or_variant_qualifier: subjectFormOrVariantQualifier,
      object_direction_qualifier: objectDirectionQualifier,
      object_aspect_qualifier: objectAspectQualifier,
      object_form_or_variant_qualifier: objectFormOrVariantQualifier,
      publications: []
    };

    edgeData.phrase = recombobulation(edgeData);

    let aggCounter = 1;
    const sources = edge.sources || [];

    for (const source of sources) {
      const role = source.resource_role;
      const resourceId = source.resource_id;

      if (role === 'primary_knowledge_source') {
        edgeData.primary_source = resourceId;
      } else if (role === 'aggregator_knowledge_source' && aggCounter <= 2) {
        if (aggCounter === 1) edgeData.agg1 = resourceId;
        if (aggCounter === 2) edgeData.agg2 = resourceId;
        aggCounter++;
      }
    }

    const attributes = edge.attributes || [];
    let hasSupportGraphs = false;
    let supportGraphsIds = [];

    for (const attribute of attributes) {
      if (attribute.attribute_type_id === 'biolink:support_graphs') {
        edgeData.edge_type = 'creative';
        hasSupportGraphs = true;
        supportGraphsIds = attribute.value;
      }
      if (attribute.attribute_type_id === 'biolink:publications') {
        edgeData.publications = attribute.value;
      }
    }

    edgeData.publications_count = (edgeData.publications || []).length;

    const resultEdgeData = { ...rowResultData, ...edgeData };
    context.allRows.push(resultEdgeData);

    if (hasSupportGraphs) {
      for (const supportGraphId of supportGraphsIds) {
        try {
          const auxGraph = context.auxiliaryGraphs[supportGraphId];
          if (auxGraph && auxGraph.edges) {
            for (const supportEdge of auxGraph.edges) {
              getEdge(context, rowResultData, supportEdge);
            }
          }
        } catch (error) {
          log(`Error processing support graph ${supportGraphId}: ${error}`);
        }
      }
    }
  } catch (error) {
    log(`Error processing edge ${edgeId}: ${error}`);
  }
}

/**
 * Main processing function: fetches and processes Translator/ARS data.
 *
 * @param {string} pk - The primary key of the Translator query
 * @param {string} [env='prod'] - The environment to query
 * @param {object} [options] - Options including optional `log` callback
 * @returns {Promise<object[]>} Array of processed row objects
 */
export async function processTranslatorData(pk, env = 'prod', options = {}) {
  const log = options.log || defaultLog;
  log(`Starting Translator data processing for pk: ${pk} in environment: ${env}`);

  const context = {
    allRows: [],
    edges: {},
    nodes: {},
    auxiliaryGraphs: {},
    processedEdgeIds: new Set(),
    log
  };

  const baseUrl = URL_DICT[env] || URL_DICT.prod;

  try {
    log(`Fetching data with trace from: ${baseUrl}/ars/api/messages/${pk}?trace=y`);
    const response = await makeTranslatorRequest(
      `${baseUrl}/ars/api/messages/${pk}?trace=y`,
      { log }
    );

    if (!response) {
      throw new Error('Failed to fetch initial data from ARS API');
    }

    const mergedVersion = response.merged_version;
    if (!mergedVersion) {
      throw new Error('No merged version found in response');
    }

    log(`Getting merged data from: ${baseUrl}/ars/api/messages/${mergedVersion}`);
    const mergedResponse = await makeTranslatorRequest(
      `${baseUrl}/ars/api/messages/${mergedVersion}`,
      { log }
    );

    if (!mergedResponse) {
      throw new Error('Failed to fetch merged data from ARS API');
    }

    const message = mergedResponse.fields?.data?.message;
    if (!message) {
      throw new Error('No message data found in merged response');
    }

    const results = message.results || [];
    context.nodes = message.knowledge_graph?.nodes || {};
    context.edges = message.knowledge_graph?.edges || {};
    context.auxiliaryGraphs = message.auxiliary_graphs || {};

    log(`Processing ${results.length} results with ${Object.keys(context.nodes).length} nodes and ${Object.keys(context.edges).length} edges`);

    let resultCounter = 0;
    for (const result of results) {
      resultCounter++;

      const rank = result.rank ?? 'N/A';
      const sugeno = result.sugeno ?? 'N/A';
      const weightedMean = result.weighted_mean ?? 'N/A';
      const normalizedScore = result.normalized_score ?? 'N/A';

      let compNovelty = 'N/A';
      let compConfidence = 'N/A';
      let compClinicalEvidence = 'N/A';

      if (result.ordering_components) {
        compNovelty = result.ordering_components.novelty ?? 'N/A';
        compConfidence = result.ordering_components.confidence ?? 'N/A';
        compClinicalEvidence = result.ordering_components.clinical_evidence ?? 'N/A';
      }

      const nodeBindings = result.node_bindings;
      const nodeBindingKeys = Object.keys(nodeBindings);

      let nodeGroupOne = '';
      let nodeGroupTwo = '';
      let nodeGroupOneNames = '';
      let nodeGroupTwoNames = '';
      let nodeGroupOneCat = ['N/A'];
      let nodeGroupTwoCat = ['N/A'];

      let nodeGroupCounter = 1;
      for (const key of nodeBindingKeys) {
        const nodeGroupArray = nodeBindings[key];
        for (const nodeGroup of nodeGroupArray) {
          const nodeId = nodeGroup.id;
          const node = context.nodes[nodeId];

          if (nodeGroupCounter === 1) {
            nodeGroupOne = nodeId;
            nodeGroupOneNames = node?.name || 'N/A';
            nodeGroupOneCat = node?.categories || ['N/A'];
          } else if (nodeGroupCounter === 2) {
            nodeGroupTwo = nodeId;
            nodeGroupTwoNames = node?.name || 'N/A';
            nodeGroupTwoCat = node?.categories || ['N/A'];
          }
        }
        nodeGroupCounter++;
      }

      let improvingAgent = false;
      let improvingAgentScore = -0.0001;
      let ARAX = false;
      let ARAxScore = -0.0001;
      let unsecret = false;
      let unsecretScore = -0.0001;
      let biothingsExplorer = false;
      let biothingsExplorerScore = -0.0001;
      let aragorn = false;
      let aragornScore = -0.0001;

      const aras = [];

      const analyses = result.analyses || [];
      let ara = '';

      for (const analysis of analyses) {
        ara = analysis.resource_id;
        const score = analysis.score || -0.0001;

        switch (analysis.resource_id) {
          case 'infores:improving-agent':
            aras.push('infores:improving-agent');
            improvingAgent = true;
            improvingAgentScore = score;
            break;
          case 'infores:rtx-kg2':
            aras.push('infores:ARAX_rtx-kg2');
            ARAX = true;
            ARAxScore = score;
            break;
          case 'infores:biothings-explorer':
            aras.push('infores:biothings-explorer');
            biothingsExplorer = true;
            biothingsExplorerScore = score;
            break;
          case 'infores:unsecret-agent':
            aras.push('infores:unsecret-agent');
            unsecret = true;
            unsecretScore = score;
            break;
          case 'infores:aragorn':
            aras.push('infores:aragorn');
            aragorn = true;
            aragornScore = score;
            break;
          default:
            aras.push(analysis.resource_id);
        }
      }

      const rowResultData = {
        pk,
        ara,
        result_subjectNode_name: nodeGroupTwoNames,
        result_subjectNode_id: nodeGroupTwo,
        result_subjectNode_cat: nodeGroupTwoCat[0],
        result_objectNode_name: nodeGroupOneNames,
        result_objectNode_id: nodeGroupOne,
        result_objectNode_cat: nodeGroupOneCat[0],
        rank: typeof rank === 'number' ? Math.round(rank * 1000) / 1000 : rank,
        sugeno_score: typeof sugeno === 'number' ? Math.round(sugeno * 1000) / 1000 : sugeno,
        comp_confidence_score: typeof compConfidence === 'number' ? Math.round(compConfidence * 1000) / 1000 : compConfidence,
        comp_novelty_score: typeof compNovelty === 'number' ? Math.round(compNovelty * 1000) / 1000 : compNovelty,
        comp_clinical_evidence_score: typeof compClinicalEvidence === 'number' ? Math.round(compClinicalEvidence * 1000) / 1000 : compClinicalEvidence,
        weighted_mean_score: typeof weightedMean === 'number' ? Math.round(weightedMean * 1000) / 1000 : weightedMean,
        normalized_score: typeof normalizedScore === 'number' ? Math.round(normalizedScore * 1000) / 1000 : normalizedScore,
        ARAX,
        ARAX_score: Math.round(ARAxScore * 1000) / 1000,
        unsecret,
        unsecret_score: Math.round(unsecretScore * 1000) / 1000,
        improving_agent: improvingAgent,
        improving_agent_score: Math.round(improvingAgentScore * 1000) / 1000,
        biothings_explorer: biothingsExplorer,
        biothings_explorer_score: Math.round(biothingsExplorerScore * 1000) / 1000,
        aragorn,
        aragorn_score: Math.round(aragornScore * 1000) / 1000,
        ARA_list: aras,
        ARA_count: aras.length,
        result_counter: resultCounter
      };

      for (const analysis of analyses) {
        const edgeBindings = analysis.edge_bindings;
        const edgeBindingKeys = Object.keys(edgeBindings);

        for (const edgeBindingKey of edgeBindingKeys) {
          const edgeObjects = edgeBindings[edgeBindingKey];
          for (const edgeObject of edgeObjects) {
            const edgeId = edgeObject.id;
            getEdge(context, rowResultData, edgeId);
          }
        }
      }
    }

    log(`Processed ${context.allRows.length} result-specific edges from ${results.length} results`);

    // Process remaining edges for complete coverage
    const totalEdges = Object.keys(context.edges).length;
    const remainingEdges = totalEdges - context.processedEdgeIds.size;
    log(`Processing remaining ${remainingEdges} edges from knowledge graph for complete coverage...`);

    let additionalEdgeCounter = 0;
    for (const [edgeId, edge] of Object.entries(context.edges)) {
      if (!context.processedEdgeIds.has(edgeId)) {
        additionalEdgeCounter++;

        const backgroundRowData = {
          pk,
          ara: 'knowledge-graph-background',
          result_subjectNode_name: context.nodes[edge.subject]?.name || edge.subject,
          result_subjectNode_id: edge.subject,
          result_subjectNode_cat: (context.nodes[edge.subject]?.categories || ['N/A'])[0],
          result_objectNode_name: context.nodes[edge.object]?.name || edge.object,
          result_objectNode_id: edge.object,
          result_objectNode_cat: (context.nodes[edge.object]?.categories || ['N/A'])[0],
          rank: 'N/A',
          sugeno_score: 'N/A',
          comp_confidence_score: 'N/A',
          comp_novelty_score: 'N/A',
          comp_clinical_evidence_score: 'N/A',
          weighted_mean_score: 'N/A',
          normalized_score: 'N/A',
          ARAX: false,
          ARAX_score: 0,
          unsecret: false,
          unsecret_score: 0,
          improving_agent: false,
          improving_agent_score: 0,
          biothings_explorer: false,
          biothings_explorer_score: 0,
          aragorn: false,
          aragorn_score: 0,
          ARA_list: ['knowledge-graph-background'],
          ARA_count: 1,
          result_counter: results.length + additionalEdgeCounter
        };

        getEdge(context, backgroundRowData, edgeId);
      }
    }

    log(`Processing complete. Generated ${context.allRows.length} total rows`);
    return context.allRows;

  } catch (error) {
    log(`Error processing Translator data: ${error}`);
    throw error;
  }
}

/**
 * Escape a field value for CSV output.
 * @param {*} field - The value to escape
 * @returns {string} CSV-safe string
 */
export function escapeCSVField(field) {
  const str = String(field || '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generate CSV content string from processed data.
 * @param {object[]} data - Array of processed row objects
 * @returns {string} CSV content
 */
export function generateCSVContent(data) {
  if (data.length === 0) {
    return '';
  }

  const headers = [
    'PK', 'ARA', 'Subject Node Name', 'Subject Node ID', 'Subject Node Category',
    'Object Node Name', 'Object Node ID', 'Object Node Category', 'Rank',
    'Sugeno Score', 'Confidence Score', 'Novelty Score', 'Clinical Evidence Score',
    'Weighted Mean Score', 'Normalized Score', 'ARAX', 'ARAX Score',
    'Unsecret', 'Unsecret Score', 'Improving Agent', 'Improving Agent Score',
    'BioThings Explorer', 'BioThings Explorer Score', 'Aragorn', 'Aragorn Score',
    'ARA Count', 'Result Counter', 'Edge ID', 'Edge Object', 'Edge Object Node Name',
    'Edge Object Node Category', 'Edge Subject', 'Edge Subject Node Name',
    'Edge Subject Node Category', 'Predicate', 'Edge Type', 'Qualified Predicate',
    'Human Readable Phrase', 'Publications Count', 'Primary Source', 'Aggregator 1', 'Aggregator 2'
  ];

  let csvContent = headers.map(escapeCSVField).join(',') + '\n';

  for (const row of data) {
    const values = [
      row.pk, row.ara, row.result_subjectNode_name, row.result_subjectNode_id,
      row.result_subjectNode_cat, row.result_objectNode_name, row.result_objectNode_id,
      row.result_objectNode_cat, row.rank, row.sugeno_score, row.comp_confidence_score,
      row.comp_novelty_score, row.comp_clinical_evidence_score, row.weighted_mean_score,
      row.normalized_score, row.ARAX, row.ARAX_score, row.unsecret, row.unsecret_score,
      row.improving_agent, row.improving_agent_score, row.biothings_explorer,
      row.biothings_explorer_score, row.aragorn, row.aragorn_score, row.ARA_count,
      row.result_counter, row.edge_id, row.edge_object, row.edge_objectNode_name,
      row.edge_objectNode_cat, row.edge_subject, row.edge_subjectNode_name,
      row.edge_subjectNode_cat, row.predicate, row.edge_type, row.qualified_predicate,
      row.phrase, row.publications_count, row.primary_source, row.agg1, row.agg2
    ];

    csvContent += values.map(escapeCSVField).join(',') + '\n';
  }

  return csvContent;
}

/**
 * Classify an entity by its CURIE prefix.
 * @param {string} curie - A CURIE identifier
 * @returns {{ type: string, group: number }}
 */
export function getEntityTypeFromCurie(curie) {
  const prefix = curie.split(':')[0];

  switch (prefix) {
    case 'DRUGBANK':
    case 'CHEBI':
    case 'PUBCHEM.COMPOUND':
      return { type: 'Drug/Chemical', group: 1 };
    case 'NCBIGene':
    case 'HGNC':
    case 'ENSEMBL':
      return { type: 'Gene', group: 2 };
    case 'MONDO':
    case 'HP':
    case 'DOID':
    case 'UMLS':
      return { type: 'Disease/Phenotype', group: 3 };
    case 'GO':
      return { type: 'Biological Process', group: 4 };
    case 'REACT':
      return { type: 'Pathway', group: 5 };
    case 'NCIT':
      return { type: 'Cancer Concept', group: 6 };
    case 'UniProtKB':
      return { type: 'Protein', group: 7 };
    default:
      return { type: 'Other', group: 8 };
  }
}

/**
 * Convert processed translator data into a knowledge graph structure.
 * @param {object[]} processedData - Array of processed rows
 * @param {string} queryPk - The query PK for context
 * @returns {{ nodes: object[], links: object[], filteredCount: number, filteredNodeCount: number }}
 */
export function createTranslatorKnowledgeGraph(processedData, queryPk) {
  const nodeMap = new Map();
  const linkMap = new Map();

  for (const row of processedData) {
    if (!nodeMap.has(row.result_subjectNode_id)) {
      const entityInfo = getEntityTypeFromCurie(row.result_subjectNode_id);
      nodeMap.set(row.result_subjectNode_id, {
        id: row.result_subjectNode_id,
        name: row.result_subjectNode_name || row.result_subjectNode_id,
        entityType: entityInfo.type,
        group: entityInfo.group,
        isStartingNode: false,
        val: 10,
        connections: 0
      });
    }

    if (!nodeMap.has(row.result_objectNode_id)) {
      const entityInfo = getEntityTypeFromCurie(row.result_objectNode_id);
      nodeMap.set(row.result_objectNode_id, {
        id: row.result_objectNode_id,
        name: row.result_objectNode_name || row.result_objectNode_id,
        entityType: entityInfo.type,
        group: entityInfo.group,
        isStartingNode: false,
        val: 10,
        connections: 0
      });
    }

    const linkKey = row.edge_id || `${row.result_subjectNode_id}-${row.result_objectNode_id}`;
    if (!linkMap.has(linkKey)) {
      const label = row.qualified_predicate ||
                   (row.predicate || '').replace('biolink:', '').replace(/_/g, ' ') ||
                   'related to';

      let linkValue = 1;
      if (typeof row.normalized_score === 'number') {
        linkValue = Math.max(1, Math.min(10, row.normalized_score / 10));
      }

      linkMap.set(linkKey, {
        source: row.result_subjectNode_id,
        target: row.result_objectNode_id,
        label: label,
        value: linkValue,
        evidence: row.publications || []
      });

      const sourceNode = nodeMap.get(row.result_subjectNode_id);
      const targetNode = nodeMap.get(row.result_objectNode_id);
      if (sourceNode) sourceNode.connections++;
      if (targetNode) targetNode.connections++;
    }
  }

  const nodes = Array.from(nodeMap.values());
  nodes.forEach(node => {
    node.val = Math.min(25, Math.max(5, 5 + node.connections * 2));
  });

  const links = Array.from(linkMap.values());

  return {
    nodes,
    links,
    filteredCount: 0,
    filteredNodeCount: 0
  };
}

/**
 * Compute summary statistics from processed data.
 * @param {object[]} processedData - Array of processed rows
 * @param {string} pk - The query PK
 * @param {string} env - The environment used
 * @returns {object} Summary stats
 */
export function computeSummaryStats(processedData, pk, env) {
  const uniqueResults = new Set(processedData.map(row => row.result_counter)).size;
  const uniqueNodes = new Set([
    ...processedData.map(row => row.result_subjectNode_id),
    ...processedData.map(row => row.result_objectNode_id)
  ]).size;
  const uniquePredicates = new Set(processedData.map(row => row.predicate)).size;
  const creativeEdges = processedData.filter(row => row.edge_type === 'creative').length;
  const oneHopEdges = processedData.filter(row => row.edge_type === 'one-hop').length;
  const backgroundEdges = processedData.filter(row => row.ara === 'knowledge-graph-background').length;
  const resultReferencedEdges = processedData.filter(row => row.ara !== 'knowledge-graph-background').length;

  const allNodeNames = new Set([
    ...processedData.map(row => row.result_subjectNode_name),
    ...processedData.map(row => row.result_objectNode_name)
  ]);
  const allNodeNamesArray = Array.from(allNodeNames).filter(name => name !== 'N/A').sort();

  const geneNodes = allNodeNamesArray.filter(name =>
    processedData.some(row =>
      (row.result_subjectNode_name === name || row.result_objectNode_name === name) &&
      (row.result_subjectNode_cat === 'biolink:Gene' || row.result_objectNode_cat === 'biolink:Gene')
    )
  );

  const objectNames = processedData.map(row => row.result_objectNode_name);
  const mostCommonObject = objectNames.reduce((acc, name) => {
    acc[name] = (acc[name] || 0) + 1;
    return acc;
  }, {});
  const topObject = Object.entries(mostCommonObject).sort(([, a], [, b]) => b - a)[0];

  return {
    pk,
    environment: env,
    totalRelationships: processedData.length,
    resultReferencedEdges,
    backgroundEdges,
    uniqueResults,
    uniqueNodes,
    uniquePredicates,
    creativeEdges,
    oneHopEdges,
    allNodeNamesArray,
    geneNodes,
    topObject: topObject ? { name: topObject[0], count: topObject[1] } : null
  };
}
