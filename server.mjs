/* file: server.mjs */

/*
 * Launches an instance of the RESTful charmonator/charmonizer server.
 */

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import { setGlobalConfigFile, getConfig, getServerPort, getBaseUrl, getFullCharmonatorApiPrefix, getFullCharmonizerApiPrefix } from './index.mjs';

// For handling externally defined tools:
import { loadToolDefinitionsFromConfig, initModelTools } from './lib/tool-loader.mjs';
import { toolRegistry } from './lib/tools.mjs';

import embeddingRouter from './routes/embedding.mjs';
import extendTranscriptRouter from './routes/extend-transcript.mjs';
import listModelsRouter from './routes/list-models.mjs';
import charmonatorConversionRouter from './routes/conversion-router.mjs';

// Charmonizer routes for doc conversions, etc.
import documentConversionsRouter from './routes/charmonizer/document-conversion.mjs';

import summarizeRouter from './routes/charmonizer/document-summarize.mjs';

import embeddingsRouter from './routes/charmonizer/document-embeddings.mjs';

const require = createRequire(import.meta.url);

// Multer setup for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = [
      '.txt', '.md', '.docx', '.pdf', '.py', '.js', '.java', '.c', '.cpp', '.cs',
      '.rb', '.go', '.rs', '.php', '.html', '.css', '.json', '.xml', '.sh', '.bat',
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File extension not allowed: ${file.originalname}`));
    }
  },
});

async function main() {
  try {
    // 1) Read config
    setGlobalConfigFile('./conf/config.json');
    const config = getConfig();

    // 2) Build tool definitions from the top-level "tools"
    const definitions = loadToolDefinitionsFromConfig(config);

    // 3) Initialize all model tools
    await initModelTools(config, definitions);
    console.log('All Registered Tools:', Array.from(toolRegistry.tools.keys()));

    // 4) Now proceed with server setup:
    const BASE_URL = getBaseUrl();
    const CHARMONATOR_API_PREFIX = getFullCharmonatorApiPrefix();
    const CHARMONIZER_API_PREFIX = getFullCharmonizerApiPrefix();
    const PORT = getServerPort();

    console.log("Charmonator API path prefix: ", CHARMONATOR_API_PREFIX);
    console.log("Charmonizer API path prefix: ", CHARMONIZER_API_PREFIX);
    console.log("Charmonator server port: ", PORT);

    const app = express();
    app.use(cors());
    app.use(BASE_URL + '/', express.static('public'));
    app.use(BASE_URL + '/src', express.static('static/src'));

    // Allow large JSON bodies
    app.use(express.json({ limit: '50mb' }));

    // Example debug logging middleware
    app.use((req, res, next) => {
      console.log(`[server.mjs] ${req.method} ${req.url}`);
      next();
    });

    // Charmonator endpoints:
    app.use(CHARMONATOR_API_PREFIX, listModelsRouter);

    app.use(CHARMONATOR_API_PREFIX + '/embedding', embeddingRouter);

    app.use(CHARMONATOR_API_PREFIX + "/chat", extendTranscriptRouter);
    app.use(CHARMONATOR_API_PREFIX + "/conversion", charmonatorConversionRouter);

    // Charmonizer document conversion routes:
    app.use(CHARMONIZER_API_PREFIX + "/conversions", documentConversionsRouter);

    // Charmonizer document summarization routes:
    app.use(CHARMONIZER_API_PREFIX + '/summaries', summarizeRouter);
    app.use(CHARMONIZER_API_PREFIX + '/embeddings', embeddingsRouter);


    // Start listening
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error('Startup error:', error);
    process.exit(1);
  }
}

// Kick off
main();
