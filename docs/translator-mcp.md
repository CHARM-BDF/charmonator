# Translator / ARS Integration

Charmonator includes a native tool and REST API for processing biomedical query results from the [NCATS Translator Automated Relay System (ARS)](https://ncatstranslator.github.io/TranslatorTechnicalDocumentation/architecture/ars_usage/).

The Translator system federates queries across multiple Autonomous Relay Agents (ARAs) — ARAX, Improving Agent, BioThings Explorer, Unsecret Agent, and Aragorn — then merges the results into a unified knowledge graph. This integration fetches those merged results, parses the knowledge graph (nodes, edges, qualifiers, scores), generates human-readable relationship phrases, and produces visualization-ready graph data.

> **Origin:** This module was ported from a standalone MCP (Model Context Protocol) server at `charm-mcp/custom-mcp-servers/translator-mcp/`. The MCP protocol layer was removed; all core logic was preserved as pure JavaScript functions.

---

## Architecture

```
tools/translator/
  translator_core.mjs   -- Pure processing functions (no dependencies on charmonator)
  translator_tool.mjs   -- BaseTool subclass for LLM function calling

routes/charmonator/
  translator.mjs         -- Express REST router (POST /query, GET /environments)
```

**Data flow:**

1. A query is submitted to the ARS (outside of charmonator) and returns a **PK** (UUID).
2. The PK is passed to either the LLM tool or the REST endpoint.
3. `processTranslatorData(pk, env)` makes two API calls:
   - `GET {base}/ars/api/messages/{pk}?trace=y` — retrieves the trace to find the `merged_version`.
   - `GET {base}/ars/api/messages/{merged_version}` — fetches the full merged knowledge graph.
4. Each result's edge bindings are processed, with recursive expansion of support graphs.
5. Remaining knowledge graph edges not referenced by results are included as background knowledge.
6. Output is formatted as JSON (summary or full) or CSV.

---

## Configuration

### Registering the tool

In `conf/config.json`, the tool is declared in the `tools` section:

```json
"tools": {
  "process_translator_query": {
    "code": "../tools/translator/translator_tool.mjs",
    "options": { "defaultEnvironment": "prod" }
  }
}
```

### Enabling the tool for a model

Add `"process_translator_query"` to the `tools` array of any model that should have access:

```json
"claude": {
  "api": "Anthropic",
  "model": "claude-sonnet-4-20250514",
  "tools": ["process_translator_query"],
  ...
}
```

### REST route

The translator router is mounted automatically in `lib/server.mjs`:

```javascript
app.use(CHARMONATOR_API_PREFIX + "/translator", translatorRouter);
```

No additional configuration is needed for the REST endpoints.

---

## REST API

Base path: `{CHARMONATOR_API_PREFIX}/translator`
(e.g., `/charm/api/charmonator/v1/translator`)

### GET /environments

Returns the available ARS environments and their base URLs.

**Response:**

```json
{
  "environments": ["test", "CI", "dev", "prod"],
  "urls": {
    "test": "https://ars.test.transltr.io",
    "CI": "https://ars.ci.transltr.io",
    "dev": "https://ars-dev.transltr.io",
    "prod": "https://ars-prod.transltr.io"
  }
}
```

### POST /query

Process a Translator/ARS query by its primary key.

**Request body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `pk` | string | yes | — | UUID of the ARS query |
| `environment` | string | no | `"prod"` | One of: `test`, `CI`, `dev`, `prod` |
| `format` | string | no | `"json"` | `"json"` for full structured data, `"csv"` for CSV download |

**Example:**

```bash
curl -X POST http://localhost:5002/charm/api/charmonator/v1/translator/query \
  -H 'Content-Type: application/json' \
  -d '{"pk": "3feb82b7-60be-4463-bb50-f27c97413f15"}'
```

**JSON response** includes `stats`, `knowledgeGraph`, and `data` (full array of processed rows).

**CSV response** sets `Content-Type: text/csv` and `Content-Disposition: attachment` with 41 columns covering all row fields.

**Error responses:**

| Status | Condition |
|--------|-----------|
| 400 | Missing or non-string `pk` |
| 400 | Invalid `environment` value |
| 500 | ARS API failure or processing error |

---

## LLM Tool

**Tool name:** `process_translator_query`

### Input schema

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pk` | string | yes | — | UUID of the ARS query |
| `environment` | enum | no | `"prod"` | `test`, `CI`, `dev`, `prod` |
| `format` | enum | no | `"summary"` | `summary`, `full`, `csv` |

### Output formats

- **`summary`** — JSON string with stats, knowledge graph node/link counts, and the first 10 sample relationships. Best for LLM consumption.
- **`full`** — JSON string with stats, complete knowledge graph, and all processed rows.
- **`csv`** — Raw CSV string with headers and all rows.

---

## Core Functions

All exported from `tools/translator/translator_core.mjs`. Every function is stateless; mutable state is scoped to a `context` object created per call.

| Function | Signature | Purpose |
|----------|-----------|---------|
| `makeTranslatorRequest` | `(url, options?) → Promise<object\|null>` | HTTP fetch with 60s timeout and abort controller |
| `recombobulation` | `(edgeData) → string` | Generates human-readable phrase from edge qualifiers |
| `getEdge` | `(context, rowResultData, edgeId) → void` | Processes one edge; pushes to `context.allRows`; recurses into support graphs |
| `processTranslatorData` | `(pk, env?, options?) → Promise<object[]>` | Main entry point: fetches ARS data and returns all processed rows |
| `escapeCSVField` | `(field) → string` | CSV-escapes a value (commas, quotes, newlines) |
| `generateCSVContent` | `(data) → string` | Produces a complete CSV string with 41-column header |
| `getEntityTypeFromCurie` | `(curie) → {type, group}` | Classifies a CURIE prefix into entity type and visualization group |
| `createTranslatorKnowledgeGraph` | `(data, pk) → {nodes, links, ...}` | Builds a visualization-ready graph from processed rows |
| `computeSummaryStats` | `(data, pk, env) → object` | Computes aggregate statistics (counts, top object, gene nodes, etc.) |

### CURIE entity classification

| Prefix | Type | Group |
|--------|------|-------|
| DRUGBANK, CHEBI, PUBCHEM.COMPOUND | Drug/Chemical | 1 |
| NCBIGene, HGNC, ENSEMBL | Gene | 2 |
| MONDO, HP, DOID, UMLS | Disease/Phenotype | 3 |
| GO | Biological Process | 4 |
| REACT | Pathway | 5 |
| NCIT | Cancer Concept | 6 |
| UniProtKB | Protein | 7 |
| *(other)* | Other | 8 |

---

## Processed Row Fields

Each row in the output `data` array contains:

| Field | Description |
|-------|-------------|
| `pk` | Query primary key |
| `ara` | Source ARA (e.g., `infores:aragorn`) or `knowledge-graph-background` |
| `result_subjectNode_name/id/cat` | Subject node from the result's node bindings |
| `result_objectNode_name/id/cat` | Object node from the result's node bindings |
| `rank` | Result rank (number or `'N/A'`) |
| `sugeno_score` | Sugeno fuzzy integral score |
| `comp_confidence_score` | Confidence component |
| `comp_novelty_score` | Novelty component |
| `comp_clinical_evidence_score` | Clinical evidence component |
| `weighted_mean_score` | Weighted mean of components |
| `normalized_score` | Normalized overall score |
| `ARAX`, `unsecret`, `improving_agent`, `biothings_explorer`, `aragorn` | Boolean flags for which ARAs contributed |
| `*_score` | Per-ARA scores |
| `ARA_list` / `ARA_count` | List and count of contributing ARAs |
| `edge_id` | Knowledge graph edge identifier |
| `edge_subject/object` | Edge endpoint node IDs |
| `predicate` | Biolink predicate (e.g., `biolink:treats`) |
| `edge_type` | `one-hop` or `creative` (has support graphs) |
| `qualified_predicate` | Qualified predicate if present |
| `*_qualifier` | Causal mechanism, direction, aspect, form/variant qualifiers |
| `phrase` | Human-readable relationship phrase |
| `publications` / `publications_count` | Supporting publication IDs |
| `primary_source` | Primary knowledge source |
| `agg1`, `agg2` | First two aggregator knowledge sources |

---

## Submitting Queries to ARS

The translator tool processes *results* of ARS queries. To submit a new query, POST a TRAPI message to the ARS submit endpoint directly:

```bash
curl -X POST "https://ars-prod.transltr.io/ars/api/submit" \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "query_graph": {
        "nodes": {
          "n0": { "categories": ["biolink:ChemicalEntity"] },
          "n1": { "ids": ["NCBIGene:64772"], "categories": ["biolink:Gene"] }
        },
        "edges": {
          "e0": {
            "subject": "n0",
            "object": "n1",
            "predicates": ["biolink:affects"],
            "knowledge_type": "inferred",
            "qualifier_constraints": [{
              "qualifier_set": [
                { "qualifier_type_id": "biolink:object_aspect_qualifier", "qualifier_value": "activity" },
                { "qualifier_type_id": "biolink:object_direction_qualifier", "qualifier_value": "decreased" },
                { "qualifier_type_id": "biolink:qualified_predicate", "qualifier_value": "biolink:causes" }
              ]
            }]
          }
        }
      }
    }
  }'
```

The response contains a `pk` field. After the query completes (typically 1-5 minutes), pass that PK to the translator tool or REST endpoint.

---

## Tests

| File | Tag | Description |
|------|-----|-------------|
| `test/testTranslatorCore.spec.mjs` | *(none)* | 32 unit tests for all core functions using mock data in `test/data/` |
| `test/testTranslatorRest.spec.mjs` | *(none)* | 4 integration tests for REST endpoint validation |
| `test/testTranslatorRest.spec.mjs` | `network`, `llm` | 1 optional test that hits the real ARS API |

Run unit and integration tests (no network):

```bash
npm test
```

Run including the real ARS network test:

```bash
npm run test:all
```
