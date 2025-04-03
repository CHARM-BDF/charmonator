

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
  // 4) Text normalization
  //
  // All text normalization preserves character count so that scruninization
  // can be on the basis of significant characters, and formatting characters
  // can pass through.
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

/**
* Split and normalize incoming text into token words, preserving original offsets.
* @param {string} txt, incoming text
* @returns {Tuple[Array[String],Array[number]]} with matching lengths
*/
function parseText(txt) {
    let words = [];
    const offsets = [];

    // Use a regex exec loop to find each word and its index
    const re = /\S+/g;
    let match;
    let ichEnd = 0;
    while ((match = re.exec(txt)) !== null) {
        if(words.length==0 && match.index>0) {
        }
        words.push(match[0]);
        offsets.push(match.index);
        ichEnd = match.index + match.length
    }
    // Always end with a whitespace token, even if empty
    words.push(txt.slice(ichEnd, txt.length))
    offsets.push(ichEnd)

    // Normalize the tokens but retain the offsets
    words = normalizeTokens(words);

    return [words, offsets];
}

  // parseGroundTruthText, parsePredictedTextWithUnclear
  // . . .
  

  /**
   * Remove diffs due to nondeterministic detection of whitespace.
   *
   * Given a list of diff tuples, remove any DELETE + consecutive INSERT blocks
   * where the only real difference is that one token was split by whitespace.
   *
   *   Example: remove this:
   *     ['DELETE', 'c.6304T>G,', 83, None, None]
   *     ['INSERT', None, None, 'c.6304T', 83]
   *     ['INSERT', None, None, '>', 84]
   *     ['INSERT', None, None, 'G,', 85]
   * @param {Array} diffs
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


/** Render markup from Diff2 analysis.
 */
function renderMarkupDiff2(alignment, txtA, offsetsA, txtB, offsetsB) {
    const markup = [];
    
    /*console.log({"event": "starting renderMarkup",
        "tokenA0":txtA.slice(0,offsetsA[0]),
        "tokenA1":txtA.slice(offsetsA[0],offsetsA[1]),
        "tokenB0":txtB.slice(0,offsetsB[0]),
        "tokenB1":txtB.slice(offsetsB[0],offsetsB[1])
    })*/
    let ichAPrev=0;
    let ichBPrev=0;
    for (let [op, tokA, idxA, tokB, idxB] of alignment) {
        idxA += 1
        idxB += 1
        //console.log({"event":"processing", op, tokA, idxA, tokB, idxB})
        if (op === 'MATCH') {
            const ichA = offsetsA[idxA]
            const stA = txtA.slice(ichAPrev,ichA)
            markup.push(stA)
            //console.log({"event":"match",ichAPrev, ichA, stA})
            ichAPrev = offsetsA[idxA]
            ichBPrev = offsetsB[idxB]
        } else if (op === 'INSERT') {
            const ichB = offsetsB[idxB]
            const stB = txtB.slice(ichBPrev,ichB)
            markup.push(`<ocr var="1">${stB}</ocr>`)
            //console.log({"event":"insert",ichBPrev, ichB, stB})
            ichBPrev = offsetsB[idxB]
        } else if (op === 'DELETE') {
            const ichA = offsetsA[idxA]
            const stA = txtA.slice(ichAPrev,ichA)
            markup.push(`<ocr var="0">${stA}</ocr>`)
            //console.log({"event":"delete",ichAPrev, ichA, stA})
            ichAPrev = offsetsA[idxA]
        }
    }
    
    return markup.join("");
}
  


export function scrutinizeViaDiff2(texts) {
    console.assert(texts && texts.length==2)

    // retain offsets to the pre-normalized text
    const [tokensA,offsetsA] = parseText(texts[0]);
    const [tokensB,offsetsB] = parseText(texts[1]);

    let alignment = computeAlignmentDiff2(tokensA, tokensB);
    alignment = removeWhitespaceDiff2(alignment);
    // TODO: pass offsets to the pre-normalized text
    const markup = renderMarkupDiff2(alignment, texts[0], offsetsA, texts[1], offsetsB);
  
    return markup
}
