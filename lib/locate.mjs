// File: lib/locate.mjs
//
// Locate quotes on a page image with a vision model: given a page image and
// some quoted text from it, return a box for each quote, as fractions of the
// page's width and height. The provenance viewer draws these over the page
// (docs/provenance-viewer.md). On charm-x's synthetic fax binder, Claude Haiku
// 5.5 and Sonnet 5.5 put 97-99% of boxes on the right line with a median error
// of about 1 px at 1200 px wide; older models do much worse, so choose the model
// deliberately.

import crypto from 'crypto';
import { Jimp } from 'jimp';
import { fetchChatModel } from './core.mjs';
import { ImageAttachment } from './transcript.mjs';
import { callLLM } from '../routes/charmonizer/document-summarize.mjs';
import { getCacheStore, resolveCachePolicy } from './result-cache.mjs';
import { withRetries } from './retry.mjs';

const CACHE_FORMAT = 'charmd-locate-v1';
// Under Claude's 1568 px limit, so the model sees the image at the size it reports on.
const DEFAULT_WIDTH = 1200;
const MAX_QUOTES = 40;

const SYSTEM_PROMPT = `
You locate text on images of document pages. Coordinates are pixels of the image you are given:
x to the right and y down, with the origin at the top left. Reply with JSON only.
`.trim();

function schemaFor(n) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['boxes'],
    properties: {
      boxes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['i', 'found', 'x0', 'y0', 'x1', 'y1'],
          properties: {
            i: { type: 'integer', minimum: 1, maximum: n },
            found: { type: 'boolean' },
            x0: { type: ['number', 'null'] },
            y0: { type: ['number', 'null'] },
            x1: { type: ['number', 'null'] },
            y1: { type: ['number', 'null'] }
          }
        }
      }
    }
  };
}

function prompt(quotes, width, height, schema) {
  const list = quotes.map((q, k) => `<quote i="${k + 1}">${q}</quote>`).join('\n');
  return `This page image is ${width} x ${height} pixels.
For each quote below, find where its text appears on the page and give the smallest box that covers all of it (if it runs over several lines, cover every line it is on).
If a quote does not appear on the page, set "found" to false and its coordinates to null.

${list}

Reply as JSON matching this schema:
${JSON.stringify(schema)}`;
}

const clamp01 = v => Math.min(1, Math.max(0, v));

/**
 * @param {Object} args
 * @param {Buffer} args.image - the page image (PNG or JPEG)
 * @param {string[]} args.quotes - text to find on it (at most 40)
 * @param {string} [args.model] - a vision model's name; or `chatModelFactory`
 * @param {Function} [args.chatModelFactory] - () => chat model (tests)
 * @param {number} [args.width=1200] - the image is resized to this width first
 * @param {string} [args.cache] - 'use' | 'refresh' | 'off' (default: CHARMD_CACHE)
 * @returns {Promise<Object>} { boxes: [{ quote, found, box: [x0, y0, x1, y1] | null }], cached },
 *   box in fractions of the page width and height
 */
export async function locateQuotes({ image, quotes, model, chatModelFactory, width = DEFAULT_WIDTH, cache }) {
  if (!Buffer.isBuffer(image) || !image.length) throw new Error('image must be a non-empty Buffer');
  const list = [...new Set((quotes || []).map(q => String(q).trim()).filter(Boolean))];
  if (!list.length) return { boxes: [], cached: false };
  if (list.length > MAX_QUOTES) throw new Error(`at most ${MAX_QUOTES} quotes per page`);
  if (!model && !chatModelFactory) throw new Error('model is required');

  const img = await Jimp.read(image);
  if (img.bitmap.width !== width) img.resize({ w: width });
  const png = await img.getBuffer('image/png');
  const height = img.bitmap.height;
  const schema = schemaFor(list.length);
  const text = prompt(list, width, height, schema);

  const resolved = resolveCachePolicy(cache);
  if (resolved.error) throw new Error(resolved.error);
  const policy = model && getCacheStore() ? resolved.policy : 'off';
  const key = policy === 'off' ? null : crypto.createHash('sha256')
    .update(JSON.stringify([CACHE_FORMAT, String(model), width,
      crypto.createHash('sha256').update(png).digest('hex'), list]))
    .digest('hex');

  let reply = null;
  let cached = false;
  if (policy === 'use') {
    const entry = await getCacheStore().get(key).catch(() => null);
    if (entry?.format === CACHE_FORMAT && entry.reply) { reply = entry.reply; cached = true; }
  }
  if (!reply) {
    const chatModel = chatModelFactory ? chatModelFactory() : fetchChatModel(model);
    chatModel.system = SYSTEM_PROMPT;
    const raw = await withRetries(() => callLLM(chatModel, [{
      role: 'user',
      content: [text, new ImageAttachment(`data:image/png;base64,${png.toString('base64')}`)]
    }], {
      response_format: { type: 'json_schema', json_schema: { name: 'boxes', schema } },
      num_schema_repair_max_attempts: 2,
      num_defective_reply_max_attempts: 2
    }));
    reply = JSON.parse(String(raw).trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim());
    if (key) {
      await getCacheStore().put(key, { format: CACHE_FORMAT, created_at: new Date().toISOString(), model, reply })
        .catch(err => console.warn(JSON.stringify({ event: 'locate cache store failed', err: err?.name })));
    }
  }

  const byIndex = new Map((reply.boxes || []).map(b => [b.i, b]));
  const boxes = list.map((quote, k) => {
    const b = byIndex.get(k + 1);
    const coords = b && [b.x0, b.y0, b.x1, b.y1];
    if (!b?.found || coords.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
      return { quote, found: false, box: null };
    }
    const [x0, x1] = [Math.min(coords[0], coords[2]), Math.max(coords[0], coords[2])];
    const [y0, y1] = [Math.min(coords[1], coords[3]), Math.max(coords[1], coords[3])];
    return { quote, found: true, box: [clamp01(x0 / width), clamp01(y0 / height), clamp01(x1 / width), clamp01(y1 / height)] };
  });
  return { boxes, cached };
}
