// lib/app-loader.mjs

import fs from 'fs';
import path from 'path';
import express from 'express';
import { getConfig, getBaseUrl } from './config.mjs';

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
        // Dynamic import the route module
        const routeModule = await import(path.resolve(routePath));
        const router = routeModule.default;

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
 * Load apps from configuration
 * @param {Object} config - Main application configuration
 */
export async function loadAppsFromConfig(config) {
  const apps = config.apps || {};
  
  for (const [appId, appConfig] of Object.entries(apps)) {
    try {
      const appDir = path.resolve(appConfig.directory);
      await appRegistry.registerApp(appId, appDir, appConfig);
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
 * Get app configuration by ID (utility function for use in app routes)
 * @param {string} appId - App identifier
 * @returns {Object|null} App configuration
 */
export function getAppConfig(appId) {
  return appRegistry.getAppConfig(appId);
}