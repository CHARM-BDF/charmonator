// Focused test: 1000-token budget with detailed analysis
import fs from 'fs';
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:5002/charm/api/charmonizer/v1';
const testDoc = JSON.parse(fs.readFileSync('../testing-data/synthetic-case-34-pages.pdf.doc.json', 'utf8'));

console.log('🎯 FOCUSED TEST: 1000-Token Budget');
console.log('=================================');
console.log(`📄 Document: ${testDoc.metadata.originating_filename} (${testDoc.chunks.pages.length} pages)`);
console.log(`🎯 Target: Exactly 1000 tokens`);
console.log(`📊 Expected: ~${Math.floor(1000 / testDoc.chunks.pages.length / 1.33)} words per chunk\n`);

async function run1000TokenTest() {
  const startTime = Date.now();
  
  const payload = {
    document: testDoc,
    method: 'delta-fold',
    chunk_group: 'pages',
    model: 'gpt-4o-mini',
    guidance: 'Provide a concise clinical summary focusing on key diagnostic findings and medical significance.',
    temperature: 0.2,
    annotation_field: 'test_1000_tokens',
    annotation_field_delta: 'test_1000_delta',
    budget: 1000,
    tokens_per_word: 1.33
  };

  try {
    console.log('🚀 Starting summarization job...');
    const response = await fetch(`${BASE_URL}/summaries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    const jobId = result.job_id;
    console.log(`📋 Job ID: ${jobId}`);

    // Monitor with more detailed progress
    let status = 'pending';
    let lastCompleted = 0;
    const progressDots = [];

    while (status !== 'complete' && status !== 'error') {
      await new Promise(resolve => setTimeout(resolve, 3000));

      const statusResponse = await fetch(`${BASE_URL}/summaries/${jobId}`);
      const statusData = await statusResponse.json();
      status = statusData.status;
      
      if (statusData.chunks_completed > lastCompleted) {
        const progress = Math.round((statusData.chunks_completed / statusData.chunks_total) * 100);
        console.log(`⏳ Progress: ${statusData.chunks_completed}/${statusData.chunks_total} chunks (${progress}%) - ${Math.round((Date.now() - startTime) / 1000)}s elapsed`);
        lastCompleted = statusData.chunks_completed;
      }
    }

    if (status === 'error') {
      throw new Error('Job failed');
    }

    const elapsedTime = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ Completed in ${elapsedTime}s\n`);

    // Get detailed results
    const resultResponse = await fetch(`${BASE_URL}/summaries/${jobId}/result`);
    const finalDoc = await resultResponse.json();
    const summary = finalDoc.annotations?.test_1000_tokens;
    
    // Detailed analysis
    console.log('📊 DETAILED ANALYSIS');
    console.log('====================');
    
    if (!Array.isArray(summary)) {
      console.log('❌ Expected array of deltas, got:', typeof summary);
      return;
    }

    let totalWords = 0;
    let totalTokensEst = 0;
    const chunkAnalysis = [];
    
    console.log('\n📝 Per-Chunk Breakdown:');
    console.log('Chunk'.padEnd(6) + 'Words'.padEnd(7) + 'Tokens'.padEnd(8) + 'Content Preview');
    console.log('-'.repeat(80));
    
    summary.forEach((delta, i) => {
      const deltaStr = typeof delta === 'string' ? delta : JSON.stringify(delta);
      const words = deltaStr.trim().split(/\s+/).length;
      const tokensEst = Math.ceil(words * 1.33);
      
      totalWords += words;
      totalTokensEst += tokensEst;
      
      // Extract key content for preview
      const preview = deltaStr.substring(0, 50).replace(/\n/g, ' ') + (deltaStr.length > 50 ? '...' : '');
      
      console.log(
        `${(i + 1)}`.padEnd(6) +
        `${words}`.padEnd(7) +
        `${tokensEst}`.padEnd(8) +
        `"${preview}"`
      );
      
      chunkAnalysis.push({
        chunk: i + 1,
        words,
        tokensEst,
        content: deltaStr
      });
    });
    
    console.log('-'.repeat(80));
    console.log(`${'TOTAL'}`.padEnd(6) + `${totalWords}`.padEnd(7) + `${totalTokensEst}`.padEnd(8) + '');
    
    // Budget analysis
    console.log('\n🎯 BUDGET ANALYSIS');
    console.log('==================');
    console.log(`Target Budget: 1000 tokens`);
    console.log(`Actual Usage: ${totalTokensEst} tokens`);
    console.log(`Utilization: ${Math.round((totalTokensEst / 1000) * 100)}%`);
    console.log(`Compliance: ${totalTokensEst <= 1000 ? '✅ PASS' : '❌ FAIL'}`);
    
    if (totalTokensEst <= 1000) {
      console.log(`Remaining Budget: ${1000 - totalTokensEst} tokens`);
    } else {
      console.log(`⚠️  Exceeded by: ${totalTokensEst - 1000} tokens`);
    }
    
    // Statistical analysis
    const wordCounts = chunkAnalysis.map(c => c.words);
    const tokenCounts = chunkAnalysis.map(c => c.tokensEst);
    
    console.log('\n📈 STATISTICAL BREAKDOWN');
    console.log('========================');
    console.log(`Total Chunks: ${summary.length}`);
    console.log(`Avg Words/Chunk: ${Math.round(totalWords / summary.length)}`);
    console.log(`Avg Tokens/Chunk: ${Math.round(totalTokensEst / summary.length)}`);
    console.log(`Word Range: ${Math.min(...wordCounts)} - ${Math.max(...wordCounts)}`);
    console.log(`Token Range: ${Math.min(...tokenCounts)} - ${Math.max(...tokenCounts)}`);
    
    // Show some key clinical content
    console.log('\n🏥 SAMPLE CLINICAL CONTENT');
    console.log('==========================');
    
    // Show first, middle, and last chunks
    const samplesToShow = [0, Math.floor(summary.length / 2), summary.length - 1];
    samplesToShow.forEach(i => {
      const chunk = chunkAnalysis[i];
      console.log(`\n📄 Chunk ${chunk.chunk} (${chunk.words} words, ${chunk.tokensEst} tokens):`);
      console.log(`"${chunk.content.substring(0, 200)}${chunk.content.length > 200 ? '...' : ''}"`);
    });
    
    // Efficiency analysis
    const baselineTokens = 7471; // From previous unlimited test
    const reduction = baselineTokens - totalTokensEst;
    const reductionPct = Math.round((reduction / baselineTokens) * 100);
    
    console.log('\n⚡ EFFICIENCY METRICS');
    console.log('====================');
    console.log(`Baseline (unlimited): ~${baselineTokens} tokens`);
    console.log(`Budgeted (1000): ${totalTokensEst} tokens`);
    console.log(`Reduction: ${reduction} tokens (${reductionPct}%)`);
    console.log(`Compression Ratio: ${Math.round(baselineTokens / totalTokensEst)}:1`);
    
    // Clean up
    await fetch(`${BASE_URL}/summaries/${jobId}`, { method: 'DELETE' });
    
    console.log('\n🎉 Test completed successfully!');

  } catch (error) {
    console.error(`❌ Test failed: ${error.message}`);
  }
}

run1000TokenTest().catch(console.error);