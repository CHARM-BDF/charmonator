// lib/app-loader.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import express from 'express';
import { getConfig, getBaseUrl } from './config.mjs';
import { fetchChatModel } from './core.mjs';

const CHARMD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What an app's route module receives when it exports createRouter(ctx).
 * Apps outside the charmd tree cannot import express or lib/ by relative path,
 * so everything they need arrives here.
 */
function makeAppContext(appInfo) {
  return {
    express,
    appId: appInfo.id,
    appDir: appInfo.directory,
    appConfig: appInfo.config,
    getConfig,
    fetchChatModel,
    // Escape hatch for anything else in charmd, e.g. importCharmd('lib/document.mjs').
    // Paths are relative to the charmd root and are not a stable API.
    importCharmd: (relPath) => import(pathToFileURL(path.join(CHARMD_ROOT, relPath)).href),
  };
}

/**
 * App Registry for managing modular applications
 */
export class AppRegistry {
  constructor() {
    this.apps = new Map();
    this.appRouters = new Map();
    this.appStaticPaths = new Map();
  }

  /**
   * Register an app from a directory
   * @param {string} appId - Unique identifier for the app
   * @param {string} appDir - Path to the app directory
   * @param {Object} appConfig - App configuration from main config.json
   */
  async registerApp(appId, appDir, appConfig = {}) {
    try {
      // Check if app directory exists
      if (!fs.existsSync(appDir)) {
        throw new Error(`App directory not found: ${appDir}`);
      }

      // Load app-specific config if it exists
      const appConfigPath = path.join(appDir, 'app-config.json');
      let localAppConfig = {};
      if (fs.existsSync(appConfigPath)) {
        const configContent = fs.readFileSync(appConfigPath, 'utf-8');
        localAppConfig = JSON.parse(configContent);
      }

      // Merge configs (local config takes precedence)
      const finalConfig = { ...appConfig, ...localAppConfig };

      // Set default values
      const config = {
        name: finalConfig.name || appId,
        description: finalConfig.description || `App: ${appId}`,
        version: finalConfig.version || '1.0.0',
        baseRoute: finalConfig.baseRoute || `/apps/${appId}`,
        staticRoute: finalConfig.staticRoute || `/apps/${appId}`,
        publicDir: finalConfig.publicDir || 'public',
        routesDir: finalConfig.routesDir || 'routes',
        enabled: finalConfig.enabled !== false,
        ...finalConfig
      };

      if (!config.enabled) {
        console.log(`App ${appId} is disabled, skipping registration`);
        return;
      }

      // Store app info
      const appInfo = {
        id: appId,
        directory: appDir,
        config: config,
        routes: [],
        staticFiles: []
      };

      // Load routes if routes directory exists
      const routesDir = path.join(appDir, config.routesDir);
      if (fs.existsSync(routesDir)) {
        await this.loadAppRoutes(appInfo, routesDir);
      }

      // Setup static file serving if public directory exists
      const publicDir = path.join(appDir, config.publicDir);
      if (fs.existsSync(publicDir)) {
        this.setupAppStatic(appInfo, publicDir);
      }

      this.apps.set(appId, appInfo);
      console.log(`Registered app: ${appId} at ${config.baseRoute}`);

    } catch (error) {
      console.error(`Failed to register app ${appId}:`, error.message);
      throw error;
    }
  }

  /**
   * Load routes from an app's routes directory
   * @param {Object} appInfo - App information object
   * @param {string} routesDir - Path to routes directory
   */
  async loadAppRoutes(appInfo, routesDir) {
    const routeFiles = fs.readdirSync(routesDir)
      .filter(file => file.endsWith('.mjs') || file.endsWith('.js'));

    const appRouter = express.Router();

    for (const routeFile of routeFiles) {
      const routePath = path.join(routesDir, routeFile);
      const routeName = path.basename(routeFile, path.extname(routeFile));

      try {
        // Dynamic import the route module. A module may export
        // createRouter(ctx) (preferred; works for apps outside the charmd
        // tree) or a ready-made Express router as its default export.
        const routeModule = await import(pathToFileURL(path.resolve(routePath)).href);
        const router = typeof routeModule.createRouter === 'function'
          ? await routeModule.createRouter(makeAppContext(appInfo))
          : routeModule.default;

        if (router && typeof router === 'function') {
          // Mount the route - assume it's an Express router
          appRouter.use('/', router);
          appInfo.routes.push({
            name: routeName,
            file: routeFile,
            path: routePath
          });
          console.log(`  Loaded route: ${routeName} for app ${appInfo.id}`);
        } else {
          console.warn(`  Route file ${routeFile} does not export a valid Express router`);
        }
      } catch (error) {
        console.error(`  Failed to load route ${routeFile} for app ${appInfo.id}:`, error.message);
      }
    }

    // Store the combined router for this app
    if (appInfo.routes.length > 0) {
      this.appRouters.set(appInfo.id, appRouter);
    }
  }

  /**
   * Setup static file serving for an app
   * @param {Object} appInfo - App information object  
   * @param {string} publicDir - Path to public directory
   */
  setupAppStatic(appInfo, publicDir) {
    // Store the static path mapping
    this.appStaticPaths.set(appInfo.id, {
      route: appInfo.config.staticRoute,
      directory: publicDir
    });

    // Find static files for reference
    const findFiles = (dir, files = []) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const itemPath = path.join(dir, item);
        if (fs.statSync(itemPath).isDirectory()) {
          findFiles(itemPath, files);
        } else {
          files.push(path.relative(publicDir, itemPath));
        }
      }
      return files;
    };

    appInfo.staticFiles = findFiles(publicDir);
    console.log(`  Static files: ${appInfo.staticFiles.length} files in ${publicDir}`);
  }

  /**
   * Get router for a specific app
   * @param {string} appId - App identifier
   * @returns {Object|null} Express router or null
   */
  getAppRouter(appId) {
    return this.appRouters.get(appId) || null;
  }

  /**
   * Get static path info for a specific app
   * @param {string} appId - App identifier
   * @returns {Object|null} Static path configuration or null
   */
  getAppStatic(appId) {
    return this.appStaticPaths.get(appId) || null;
  }

  /**
   * Get all registered apps
   * @returns {Map} Map of all registered apps
   */
  getAllApps() {
    return this.apps;
  }

  /**
   * Get specific app info
   * @param {string} appId - App identifier
   * @returns {Object|null} App info or null
   */
  getApp(appId) {
    return this.apps.get(appId) || null;
  }

  /**
   * Get app configuration (useful for apps to access their own config)
   * @param {string} appId - App identifier
   * @returns {Object|null} App configuration or null
   */
  getAppConfig(appId) {
    const app = this.apps.get(appId);
    return app ? app.config : null;
  }
}

// Global app registry instance
export const appRegistry = new AppRegistry();

/**
 * Find apps on CHARMONATOR_APPS_PATH: a list of directories separated like
 * PATH. An entry holding an app-config.json is itself an app; otherwise each
 * of its subdirectories holding an app-config.json is. The app's id is its
 * directory name.
 * @param {string} appsPath - The CHARMONATOR_APPS_PATH value
 * @returns {Array<{appId: string, directory: string}>}
 */
export function discoverApps(appsPath) {
  const found = [];
  const isApp = (dir) => fs.existsSync(path.join(dir, 'app-config.json'));
  for (const entry of (appsPath || '').split(path.delimiter).filter(Boolean)) {
    const dir = path.resolve(entry);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      console.warn(`CHARMONATOR_APPS_PATH entry is not a directory: ${dir}`);
      continue;
    }
    if (isApp(dir)) {
      found.push({ appId: path.basename(dir), directory: dir });
      continue;
    }
    for (const name of fs.readdirSync(dir).sort()) {
      const sub = path.join(dir, name);
      if (fs.statSync(sub).isDirectory() && isApp(sub)) {
        found.push({ appId: name, directory: sub });
      }
    }
  }
  return found;
}

/**
 * Load apps from configuration and from CHARMONATOR_APPS_PATH.
 * An app named in config.apps wins over a discovered app with the same id,
 * so config can still disable or redirect a discovered app.
 * @param {Object} config - Main application configuration
 * @param {Object} [options]
 * @param {AppRegistry} [options.registry] - Defaults to the global registry
 * @param {Object} [options.env] - Defaults to process.env
 */
export async function loadAppsFromConfig(config, { registry = appRegistry, env = process.env } = {}) {
  const apps = { ...(config.apps || {}) };

  for (const { appId, directory } of discoverApps(env.CHARMONATOR_APPS_PATH)) {
    if (apps[appId]) {
      console.log(`App ${appId} found on CHARMONATOR_APPS_PATH but configured in config.apps; using config`);
      continue;
    }
    apps[appId] = { directory };
  }

  for (const [appId, appConfig] of Object.entries(apps)) {
    try {
      if (appConfig.enabled === false) {
        console.log(`App ${appId} is disabled in config, skipping registration`);
        continue;
      }
      const appDir = path.resolve(appConfig.directory);
      await registry.registerApp(appId, appDir, appConfig);
    } catch (error) {
      console.error(`Failed to load app ${appId}:`, error.message);
    }
  }
}

/**
 * Mount app routes and static files to an Express app
 * @param {Object} expressApp - Express application instance
 */
export function mountApps(expressApp) {
  const baseUrl = getBaseUrl();

  // Mount static files for each app
  for (const [appId, staticInfo] of appRegistry.appStaticPaths) {
    const fullStaticRoute = baseUrl + staticInfo.route;
    expressApp.use(fullStaticRoute, express.static(staticInfo.directory));
    console.log(`Mounted static files for ${appId}: ${fullStaticRoute} -> ${staticInfo.directory}`);
  }

  // Mount routes for each app
  for (const [appId, router] of appRegistry.appRouters) {
    const app = appRegistry.getApp(appId);
    const fullBaseRoute = baseUrl + app.config.baseRoute;
    expressApp.use(fullBaseRoute, router);
    console.log(`Mounted routes for ${appId}: ${fullBaseRoute}`);
  }
}

/**
 * Print localhost URLs for web apps after server starts
 * @param {number} port - Server port
 */
export function printAppUrls(port) {
  const baseUrl = getBaseUrl();
  
  console.log('\n--- Web App URLs ---');
  
  // Print URLs for apps with static files (likely web apps)
  for (const [appId, staticInfo] of appRegistry.appStaticPaths) {
    const app = appRegistry.getApp(appId);
    const fullStaticRoute = baseUrl + staticInfo.route;
    const localhostUrl = `http://localhost:${port}${fullStaticRoute}`;
    console.log(`${app.config.name}: ${localhostUrl}`);
  }
  
  // Also print URLs for apps with just routes (API-based web apps)
  for (const [appId, router] of appRegistry.appRouters) {
    const app = appRegistry.getApp(appId);
    
    // Skip if we already printed this app via static files
    if (appRegistry.appStaticPaths.has(appId)) {
      continue;
    }
    
    const fullBaseRoute = baseUrl + app.config.baseRoute;
    const localhostUrl = `http://localhost:${port}${fullBaseRoute}`;
    console.log(`${app.config.name}: ${localhostUrl}`);
  }
  
  console.log('-------------------\n');
}

/**
 * Get app configuration by ID (utility function for use in app routes)
 * @param {string} appId - App identifier
 * @returns {Object|null} App configuration
 */
export function getAppConfig(appId) {
  return appRegistry.getAppConfig(appId);
}