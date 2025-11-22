/*
 * Launches an instance of the RESTful charmonator/charmonizer server.
 */

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import util from 'util';
import { createRequire } from 'module';

import { setGlobalConfigFile, getConfig, getServerPort, getBaseUrl, getFullCharmonatorApiPrefix, getFullCharmonizerApiPrefix } from './index.mjs';

// For handling externally defined tools:
import { loadToolDefinitionsFromConfig, initModelTools } from './tool-loader.mjs';
import { toolRegistry } from './tools.mjs';

// For handling modular apps:
import { loadAppsFromConfig, mountApps } from './app-loader.mjs';

import embeddingRouter from '../routes/embedding.mjs';
import transcriptExtensionRouter from '../routes/transcript-extension.mjs';
import listModelsRouter from '../routes/list-models.mjs';
import charmonatorConversionRouter from '../routes/conversion-router.mjs';

// Charmonizer routes for doc conversions, etc.
import documentConversionsRouter from '../routes/charmonizer/document-conversion.mjs';

import summarizeRouter from '../routes/charmonizer/document-summarize.mjs';

import embeddingsRouter from '../routes/charmonizer/document-embeddings.mjs';

import chunkingsRouter from '../routes/charmonizer/document-chunkings.mjs';

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

export async function createAndStart() {
  try {
    // send console.error to stdout
    console.error = (...args) => {
      if (args.length == 1 && args[0] instanceof Object) {
        process.stdout.write(JSON.stringify(args[0]) + '\n');
      } else {
        // do what the original code did
        process.stdout.write(util.format(...args) + '\n');
      }
    };

    // 1) Read config
    const config = getConfig();

    // 2) Build tool definitions from the top-level "tools"
    const definitions = loadToolDefinitionsFromConfig(config);

    // 3) Initialize all model tools
    await initModelTools(config, definitions);
    console.log('All Registered Tools:', Array.from(toolRegistry.tools.keys()));

    // 4) Load modular apps
    await loadAppsFromConfig(config);
    console.log('Apps loaded successfully');

    // 5) Now proceed with server setup:
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

    // Verbose logging middleware: print a snapshot of all requests with parameters if --verbose is passed
    if (process.argv.includes('--verbose')) {
      // Helper function to truncate strings or recursively process objects
      function truncateValue(value, maxLen = 200) {
        if (typeof value === 'string') {
          return value.length > maxLen ? value.slice(0, maxLen) + '... [truncated]' : value;
        } else if (Array.isArray(value)) {
          return value.map(item => truncateValue(item, maxLen));
        } else if (value && typeof value === 'object') {
          const truncatedObj = {};
          for (const key in value) {
            truncatedObj[key] = truncateValue(value[key], maxLen);
          }
          return truncatedObj;
        }
        return value;
      }

      app.use((req, res, next) => {
        const requestSnapshot = {
          method: req.method,
          url: req.url,
          query: truncateValue(req.query),
          params: truncateValue(req.params),
          body: truncateValue(req.body),
          // For file uploads handled by multer, log only metadata
          file: req.file
            ? { originalname: req.file.originalname, size: req.file.size }
            : undefined,
          files: req.files
            ? req.files.map(file => ({ originalname: file.originalname, size: file.size }))
            : undefined,
        };

        console.log('Request Snapshot:', requestSnapshot);
        next();
      });
    }

    // Charmonator endpoints:
    app.use(CHARMONATOR_API_PREFIX, listModelsRouter);

    app.use(CHARMONATOR_API_PREFIX + '/embedding', embeddingRouter);

    app.use(CHARMONATOR_API_PREFIX + "/transcript", transcriptExtensionRouter);
    app.use(CHARMONATOR_API_PREFIX + "/conversion", charmonatorConversionRouter);

    // Mount modular apps (routes and static files)
    mountApps(app);

    // Charmonizer document conversion routes:
    app.use(CHARMONIZER_API_PREFIX + "/conversions", documentConversionsRouter);

    // Charmonizer document summarization routes:
    app.use(CHARMONIZER_API_PREFIX + '/summaries', summarizeRouter);
    app.use(CHARMONIZER_API_PREFIX + '/embeddings', embeddingsRouter);
    app.use(CHARMONIZER_API_PREFIX + '/chunkings', chunkingsRouter);

    // Start listening
    return new Promise((resolve, reject) => {
      // Start listening
      const server = app.listen(PORT, err => {
        if (err) {
          return reject(err);
        }
        console.log(`Server running on port ${PORT}`);
        resolve(server);
      });
    });
  } catch (error) {
    console.error('Startup error:', error);
    process.exit(1);
  }
}
