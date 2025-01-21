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

import mammoth from 'mammoth';

import { setGlobalConfigFile, getConfig, getServerPort, getBaseUrl, getFullCharmonatorApiPrefix, getFullCharmonizerApiPrefix } from './index.mjs';

// For handling externally defined tools:
import { loadToolDefinitionsFromConfig, initModelTools } from './lib/tool-loader.mjs';
import { toolRegistry } from './lib/tools.mjs';

import extendTranscriptRouter from './routes/extend-transcript.mjs';
import listModelsRouter from './routes/list-models.mjs';
import imageToMarkdownRouter from './routes/image-to-markdown.mjs';
import documentConversion from './routes/charmonizer/document-conversion.mjs';
import summarizeRouter from './routes/charmonizer/document-summarize.mjs';

// Load the global config file for this instance:
setGlobalConfigFile('./conf/config.json');

const require = createRequire(import.meta.url);
// ... Any other require-based usage ...

const pdfParse = require('pdf-parse');


// Multer setup for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit
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
    const config = getConfig();

    // 2) Build tool definitions from the top-level "tools"
    const definitions = loadToolDefinitionsFromConfig(config);

    // 3) Initialize all model tools:
    await initModelTools(config, definitions);

    // Optional: see which tools ended up in the registry
    console.log('All Registered Tools:', Array.from(toolRegistry.tools.keys()));

    // 4) Now proceed with normal server setup:

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
    app.use(BASE_URL + '/src', express.static('src'));

    // Allow large JSON bodies for images, docs, etc.
    app.use(express.json({ limit: '50mb' }));

    // Example debug logging middleware
    app.use((req, res, next) => {
      console.log(`[server.mjs] ${req.method} ${req.url}`);
      next();
    });

    // Routes
    app.use(CHARMONATOR_API_PREFIX, listModelsRouter);
    app.use(CHARMONATOR_API_PREFIX + "/chat", extendTranscriptRouter);
    app.use(CHARMONATOR_API_PREFIX + '/convert', imageToMarkdownRouter);

    
    // Endpoint to convert files to Markdown
    app.post(CHARMONATOR_API_PREFIX + '/quick_convert', upload.single('file'), async (req, res) => {
    
      console.log("File conversion request: ", req.file);
    
      const file = req.file;
    
      if (!file) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }
    
      try {
        let markdownContent = '';
        const ext = path.extname(file.originalname).toLowerCase();
    
        if (ext === '.pdf') {
          const dataBuffer = await fs.promises.readFile(file.path);
          const pdfData = await pdfParse(dataBuffer);
          markdownContent = pdfData.text;
        } else if (ext === '.docx') {
          const result = await mammoth.extractRawText({ path: file.path });
          markdownContent = result.value;
        } else {
          // For all other supported text or code files, read as UTF-8 text
          const fileContent = await fs.promises.readFile(file.path, 'utf8');
          markdownContent = fileContent;
        }
    
        // Clean up the uploaded file
        fs.unlink(file.path, (err) => {
          if (err) console.error(`Failed to delete ${file.path}:`, err);
        });
    
        res.json({ markdownContent });
      } catch (error) {
        console.error('Error converting file:', error);
        res.status(500).json({ error: 'Error converting file.' });
      }
    });    

    // Charmonizer routes
    app.use(CHARMONIZER_API_PREFIX + "/convert", documentConversion);
    app.use(CHARMONIZER_API_PREFIX, summarizeRouter);

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
