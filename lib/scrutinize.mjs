

// begin code from test_confusion_transcription_2.mjs

// ----------------------------------------------------------------------------
// 3) Longest Common Subsequence alignment utility
// ----------------------------------------------------------------------------
/**
 * Computes a standard LCS for two arrays of tokens, seqA and seqB.
 * Returns a list of alignment instructions:
 *   - ["MATCH",  tokenA, idxA, tokenB, idxB]
 *   - ["INSERT", null,   null,  tokenB, idxB]   (the tokenB was inserted)
 *   - ["DELETE", tokenA, idxA,  null,   null]   (the tokenA was deleted)
 *
 * @param {string[]} seqA
 * @param {string[]} seqB
 * @returns {Array}
 */
function computeAlignmentDiff2(seqA, seqB) {
    const lenA = seqA.length;
    const lenB = seqB.length;
  
    // dp[i][j] = LCS length for seqA[:i], seqB[:j]
    const dp = [];
    for (let i = 0; i <= lenA; i++) {
      dp.push(new Array(lenB + 1).fill(0));
    }
  
    for (let i = 1; i <= lenA; i++) {
      for (let j = 1; j <= lenB; j++) {
        if (seqA[i - 1] === seqB[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
  
    // Backtrack to retrieve alignment
    const alignment = [];
    let i = lenA;
    let j = lenB;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && seqA[i - 1] === seqB[j - 1]) {
        alignment.push(["MATCH", seqA[i - 1], i - 1, seqB[j - 1], j - 1]);
        i -= 1;
        j -= 1;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        // insertion in seqB
        alignment.push(["INSERT", null, null, seqB[j - 1], j - 1]);
        j -= 1;
      } else {
        // deletion from seqA
        alignment.push(["DELETE", seqA[i - 1], i - 1, null, null]);
        i -= 1;
      }
    }
    alignment.reverse();
    return alignment;
  }
  
  // ----------------------------------------------------------------------------
  // 4) Text normalization and "UNCLEAR" handling
  // ----------------------------------------------------------------------------
  
  const reNorm1 = /[`‘’]/g;
  
  /**
   * Normalize tokens by converting to lowercase and substituting certain quotes with `'`.
   * @param {string[]} toks
   * @returns {string[]}
   */
  function normalizeTokens(toks) {
    return toks.map(tok => tok.replace(reNorm1, "'").toLowerCase());
  }
  
  function parseText(txt) {
    return normalizeTokens(txt.split(/\s+/));
  }  

  // parseGroundTruthText, parsePredictedTextWithUnclear
  // . . .
  
  // ----------------------------------------------------------------------------
  // 5) Utility to remove whitespace-only diffs
  // ----------------------------------------------------------------------------
  /**
   * Given a list of diff tuples, remove any DELETE + consecutive INSERT blocks
   * where the only real difference is that one token was split by whitespace.
   *
   * @param {Array} diffs  e.g. [ ["DELETE", "c.6304t>g,", 83, null, null], ...]
   * @returns {Array}
   */
  function removeWhitespaceDiff2(diffs) {
    const result = [];
    let i = 0;
    const n = diffs.length;
  
    while (i < n) {
      const current = diffs[i];
  
      // Look for a single DELETE whose text might have been split incorrectly
      if (current[0] === 'DELETE' && current[1] != null) {
        const oldText = current[1];
  
        // Gather consecutive INSERTs
        let j = i + 1;
        const insertedTokens = [];
        while (j < n && diffs[j][0] === 'INSERT') {
          insertedTokens.push(diffs[j][3]);
          j++;
        }
  
        // Compare concatenated INSERT tokens to the DELETE text
        if (insertedTokens.join('') === oldText) {
          // It's a pure whitespace-split difference; skip these lines
          i = j;
          continue;
        } else {
          // Not a whitespace difference, so keep it
          result.push(current);
          i++;
        }
      } else {
        result.push(current);
        i++;
      }
    }
    return result;
  }

// end code from test_confusion_transcription_2.mjs


/* Render markup from Diff2 analysis.
*/
function renderMarkupDiff2(alignment) {
    const markup = [];
    
    for (const [op, tokA, idxA, tokB, idxB] of alignment) {
        if (op === 'MATCH') {
            
        } else if (op === 'INSERT') {
            
        } else if (op === 'DELETE') {
            
        }
    }
    
    return markup;
}
  


export function scrutinizeViaDiff2(texts) {
    assert(texts && texts.length==2)

    // TODO: retain offsets to the pre-normalized text
    const tokens1 = parseText(texts[0]);
    const tokens2 = parseText(texts[1]);

    let alignment = computeAlignmentDiff2(tokens1, tokens2);
    alignment = removeWhitespaceDiff2(alignment);
    // TODO: pass offsets to the pre-normalized text
    const markup = renderMarkupDiff2(alignment);
  
    return markup
}
