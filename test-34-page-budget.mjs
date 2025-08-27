// Comprehensive budget testing with 34-page synthetic case
// Tests larger budgets and dynamic allocation with many more chunks

import fs from 'fs';
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:5002/charm/api/charmonizer/v1';
const testDoc = JSON.parse(fs.readFileSync('./testing-data/synthetic-case-34-pages.pdf.doc.json', 'utf8'));

console.log(`🏥 Testing with: ${testDoc.metadata.originating_filename}`);
console.log(`📄 Document has ${testDoc.chunks.pages.length} pages`);
console.log(`🧬 Case: Neurofibromatosis Type 1 diagnostic odyssey\n`);

/**
 * Run a budget test with detailed analysis
 */
async function runBudgetTest(testName, budget = null, tokensPerWord = 1.33, detailed = false) {
  console.log(`\n🧪 ${testName}`);
  console.log(`   Budget: ${budget || 'unlimited'} tokens`);
  if (budget) {
    console.log(`   Expected per chunk: ~${Math.floor(budget / testDoc.chunks.pages.length / tokensPerWord)} words`);
  }
  
  const startTime = Date.now();
  
  const payload = {
    document: testDoc,
    method: 'delta-fold',
    chunk_group: 'pages',
    model: 'gpt-4o-mini', // Use faster model for efficiency
    guidance: 'Provide a concise clinical summary focusing on key medical information and diagnostic significance.',
    temperature: 0.2,
    annotation_field: 'budget_test_large',
    annotation_field_delta: 'budget_test_delta',
    ...(budget && { budget, tokens_per_word: tokensPerWord })
  };

  try {
    // Start job
    const response = await fetch(`${BASE_URL}/summaries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    const jobId = result.job_id;
    console.log(`   Job ID: ${jobId}`);

    // Monitor progress
    let status = 'pending';
    let lastCompleted = 0;
    const maxTime = 900000; // 15 minutes for large document
    const checkInterval = 5000; // Check every 5 seconds

    while (status !== 'complete' && status !== 'error' && (Date.now() - startTime) < maxTime) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));

      const statusResponse = await fetch(`${BASE_URL}/summaries/${jobId}`);
      const statusData = await statusResponse.json();
      status = statusData.status;
      
      if (statusData.chunks_completed > lastCompleted) {
        console.log(`   Progress: ${statusData.chunks_completed}/${statusData.chunks_total} chunks (${Math.round((statusData.chunks_completed / statusData.chunks_total) * 100)}%)`);
        lastCompleted = statusData.chunks_completed;
      }
    }

    if (status === 'error') {
      const errorResponse = await fetch(`${BASE_URL}/summaries/${jobId}`);
      const errorData = await errorResponse.json();
      throw new Error(`Job failed: ${errorData.error}`);
    }

    if (status !== 'complete') {
      throw new Error(`Job timed out after ${Math.round((Date.now() - startTime) / 1000)}s`);
    }

    // Get results
    const resultResponse = await fetch(`${BASE_URL}/summaries/${jobId}/result`);
    const finalDoc = await resultResponse.json();
    const summary = finalDoc.annotations?.budget_test_large;
    
    if (!summary) {
      throw new Error('No summary found in results');
    }

    const elapsedTime = Date.now() - startTime;
    console.log(`   ✅ Completed in ${Math.round(elapsedTime / 1000)}s`);

    // Analyze results
    const analysis = analyzeLargeSummary(testName, summary, budget, tokensPerWord, detailed);
    
    // Clean up
    await fetch(`${BASE_URL}/summaries/${jobId}`, { method: 'DELETE' });
    
    return analysis;

  } catch (error) {
    console.error(`   ❌ Test failed: ${error.message}`);
    return null;
  }
}

/**
 * Analyze large document summary results
 */
function analyzeLargeSummary(testName, summary, budget, tokensPerWord, detailed = false) {
  console.log(`\n   📊 Analysis:`);
  
  if (!Array.isArray(summary)) {
    console.log(`   Summary type: Single value (${typeof summary})`);
    return { testName, summary: 'single_value' };
  }

  let totalWords = 0;
  let totalTokensEst = 0;
  const chunkBreakdown = [];
  
  summary.forEach((delta, i) => {
    const deltaStr = typeof delta === 'string' ? delta : JSON.stringify(delta);
    const words = deltaStr.trim().split(/\s+/).length;
    const tokensEst = Math.ceil(words * tokensPerWord);
    
    totalWords += words;
    totalTokensEst += tokensEst;
    
    chunkBreakdown.push({
      chunk: i + 1,
      words: words,
      tokens: tokensEst,
      content: deltaStr
    });
  });
  
  console.log(`   Total: ${totalWords} words, ~${totalTokensEst} tokens`);
  console.log(`   Chunks: ${summary.length} deltas`);
  console.log(`   Avg per chunk: ${Math.round(totalWords / summary.length)} words, ~${Math.round(totalTokensEst / summary.length)} tokens`);
  
  if (budget) {
    const budgetCompliance = totalTokensEst <= budget;
    const utilizationPct = Math.round((totalTokensEst / budget) * 100);
    const expectedPerChunk = Math.floor(budget / summary.length / tokensPerWord);
    
    console.log(`   Budget: ${totalTokensEst}/${budget} tokens (${utilizationPct}%)`);
    console.log(`   Compliance: ${budgetCompliance ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   Expected per chunk: ~${expectedPerChunk} words`);
    
    if (!budgetCompliance) {
      console.log(`   ⚠️  Exceeded by ${totalTokensEst - budget} tokens`);
    }
    
    // Show distribution statistics
    const wordCounts = chunkBreakdown.map(c => c.words);
    const minWords = Math.min(...wordCounts);
    const maxWords = Math.max(...wordCounts);
    const avgWords = Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length);
    
    console.log(`   Word distribution: ${minWords}-${maxWords} (avg: ${avgWords})`);
    
    // Show a few sample deltas if detailed
    if (detailed && summary.length > 5) {
      console.log(`\n   📝 Sample deltas:`);
      [0, Math.floor(summary.length/4), Math.floor(summary.length/2), Math.floor(3*summary.length/4), summary.length-1].forEach(i => {
        const delta = chunkBreakdown[i];
        const preview = delta.content.substring(0, 80) + (delta.content.length > 80 ? '...' : '');
        console.log(`     Chunk ${delta.chunk}: ${delta.words} words - "${preview}"`);
      });
    }
  }
  
  return {
    testName,
    budget,
    totalWords,
    totalTokensEst,
    chunkCount: summary.length,
    avgWordsPerChunk: Math.round(totalWords / summary.length),
    budgetCompliance: budget ? totalTokensEst <= budget : null,
    utilization: budget ? Math.round((totalTokensEst / budget) * 100) : null,
    chunkBreakdown: detailed ? chunkBreakdown : null
  };
}

/**
 * Run comprehensive test suite
 */
async function runLargeDocumentTests() {
  console.log('🔬 LARGE DOCUMENT BUDGET TESTING');
  console.log('=================================');
  
  const tests = [
    // Baseline
    { name: 'Baseline (No Budget)', budget: null, detailed: false },
    
    // Small budgets - very tight constraints
    { name: 'Very Tight Budget (200 tokens)', budget: 200, detailed: false },
    { name: 'Tight Budget (500 tokens)', budget: 500, detailed: false },
    
    // Medium budgets - reasonable constraints  
    { name: 'Small Budget (1000 tokens)', budget: 1000, detailed: true },
    { name: 'Medium Budget (2000 tokens)', budget: 2000, detailed: false },
    { name: 'Large Budget (3500 tokens)', budget: 3500, detailed: false },
    
    // Very large budgets - minimal constraints
    { name: 'Very Large Budget (5000 tokens)', budget: 5000, detailed: false },
    
    // Different token/word ratio
    { name: 'Medium Budget + Higher Ratio', budget: 2000, tokensPerWord: 1.5, detailed: false }
  ];

  const results = [];
  
  for (const test of tests) {
    const result = await runBudgetTest(
      test.name,
      test.budget,
      test.tokensPerWord || 1.33,
      test.detailed
    );
    
    if (result) {
      results.push(result);
    }
    
    // Pause between tests
    console.log('   ⏱️  Waiting 5s before next test...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // Comparative analysis
  console.log('\n🎯 COMPARATIVE ANALYSIS');
  console.log('========================');
  
  console.log('\nSummary of all tests:');
  console.log('Test Name'.padEnd(35) + 'Budget'.padEnd(10) + 'Actual'.padEnd(10) + 'Words'.padEnd(8) + 'Avg/Chunk'.padEnd(12) + 'Compliance');
  console.log('-'.repeat(90));
  
  results.forEach(r => {
    const budgetStr = r.budget ? `${r.budget}` : 'unlimited';
    const actualStr = r.totalTokensEst ? `${r.totalTokensEst}` : 'N/A';
    const complianceStr = r.budgetCompliance === null ? 'N/A' : (r.budgetCompliance ? '✅ PASS' : '❌ FAIL');
    
    console.log(
      r.testName.padEnd(35) +
      budgetStr.padEnd(10) +
      actualStr.padEnd(10) +
      `${r.totalWords || 'N/A'}`.padEnd(8) +
      `${r.avgWordsPerChunk || 'N/A'}`.padEnd(12) +
      complianceStr
    );
  });
  
  // Budget effectiveness analysis
  const baseline = results.find(r => !r.budget);
  const budgeted = results.filter(r => r.budget);
  
  if (baseline) {
    console.log(`\n📈 Budget Effectiveness (vs baseline of ${baseline.totalTokensEst} tokens):`);
    
    budgeted.forEach(test => {
      if (test.totalTokensEst) {
        const reduction = baseline.totalTokensEst - test.totalTokensEst;
        const reductionPct = Math.round((reduction / baseline.totalTokensEst) * 100);
        const status = test.budgetCompliance ? '✅' : '❌';
        
        console.log(`   ${test.testName}: ${reductionPct}% reduction, ${test.utilization}% budget used ${status}`);
      }
    });
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runLargeDocumentTests().catch(console.error);
}

export { runBudgetTest, runLargeDocumentTests };