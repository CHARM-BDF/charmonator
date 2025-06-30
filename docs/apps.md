# Charmonator App System

The Charmonator app system enables modular applications that extend the server's functionality through custom routes, static files, and configuration. Apps are self-contained directories that can provide specialized functionality while leveraging the core Charmonator infrastructure.

## Overview

The app loading system allows you to:
- Create modular applications with custom routes and endpoints
- Serve static files (HTML, CSS, JS, images) for web interfaces
- Configure apps independently with local settings
- Leverage Charmonator's AI models and tools
- Deploy multiple apps simultaneously with isolated functionality

## How It Works

### App Registration Process

1. **Discovery**: Apps are discovered through the main `config.json` file's `apps` section
2. **Loading**: The `AppRegistry` class loads each enabled app from its directory
3. **Configuration**: Apps can have local `app-config.json` files that override global settings
4. **Route Loading**: Express router files in the `routes/` directory are dynamically imported
5. **Static Serving**: Files in the `public/` directory are served at the app's static route
6. **Mounting**: All app routes and static files are mounted to the main Express server

### Core Components

- **AppRegistry** (`lib/app-loader.mjs`): Manages app discovery, loading, and configuration
- **loadAppsFromConfig()**: Reads apps from main config and registers them
- **mountApps()**: Mounts all registered apps to the Express server

## Configuration

### Global Configuration (config.json)

Add apps to your main `conf/config.json`:

```json
{
  "apps": {
    "my-app": {
      "directory": "./apps/my-app",
      "enabled": true,
      "description": "My custom application"
    }
  }
}
```

### App-Specific Configuration (app-config.json)

Each app can have its own `app-config.json` file:

```json
{
  "name": "My App",
  "description": "A custom Charmonator application",
  "version": "1.0.0",
  "baseRoute": "/apps/my-app",
  "staticRoute": "/apps/my-app",
  "publicDir": "public",
  "routesDir": "routes",
  "enabled": true,
  "models": {
    "default": "gpt-4o",
    "fallback": "gpt-4o-mini"
  }
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `name` | `appId` | Display name for the app |
| `description` | `"App: {appId}"` | App description |
| `version` | `"1.0.0"` | App version |
| `baseRoute` | `/apps/{appId}` | Base URL route for API endpoints |
| `staticRoute` | `/apps/{appId}` | Base URL route for static files |
| `publicDir` | `"public"` | Directory containing static files |
| `routesDir` | `"routes"` | Directory containing route modules |
| `enabled` | `true` | Whether the app is enabled |

## Directory Structure

A typical app directory structure:

```
my-app/
├── app-config.json     # App-specific configuration (optional)
├── routes/             # Express route modules
│   ├── main.mjs       # Main API routes
│   └── utils.mjs      # Utility routes
├── public/            # Static files served by web server
│   ├── index.html     # Main app interface
│   ├── styles.css     # Stylesheets
│   └── app.js         # Client-side JavaScript
└── README.md          # App documentation (optional)
```

## Creating Routes

### Route Module Format

Route files must export an Express router as the default export:

```javascript
// routes/main.mjs
import express from 'express';
import { getAppConfig } from '../../../lib/app-loader.mjs';
import { fetchChatModel } from '../../../lib/core.mjs';

const router = express.Router();

/**
 * GET /hello
 * Simple hello world endpoint
 */
router.get('/hello', (req, res) => {
  const appConfig = getAppConfig('my-app');
  res.json({
    message: 'Hello from my app!',
    app: appConfig?.name || 'Unknown App',
    version: appConfig?.version || '1.0.0'
  });
});

/**
 * POST /chat
 * AI chat endpoint using configured model
 */
router.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({
        error: 'Message is required'
      });
    }

    // Get app configuration
    const appConfig = getAppConfig('my-app');
    const modelName = appConfig?.models?.default || 'gpt-4o';
    
    // Get the AI model
    const chatModel = fetchChatModel(modelName);
    
    // Generate response
    const response = await chatModel.replyTo(message);
    
    res.json({
      response: response,
      model: modelName,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

export default router;
```

### Accessing App Configuration

Use `getAppConfig(appId)` to access your app's configuration:

```javascript
import { getAppConfig } from '../../../lib/app-loader.mjs';

const appConfig = getAppConfig('my-app');
const modelName = appConfig?.models?.default || 'gpt-4o';
```

## Static Files

### Serving Static Files

Files in your app's `public/` directory are automatically served at the `staticRoute` URL:

- `public/index.html` → `http://localhost:5002/charm/apps/my-app/index.html`
- `public/styles.css` → `http://localhost:5002/charm/apps/my-app/styles.css`
- `public/app.js` → `http://localhost:5002/charm/apps/my-app/app.js`

### HTML Interface Example

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My App</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="app">
        <h1>My Charmonator App</h1>
        <div id="chat-container">
            <div id="messages"></div>
            <input type="text" id="message-input" placeholder="Type a message...">
            <button onclick="sendMessage()">Send</button>
        </div>
    </div>
    
    <script>
        async function sendMessage() {
            const input = document.getElementById('message-input');
            const message = input.value.trim();
            if (!message) return;
            
            try {
                const response = await fetch('/charm/apps/my-app/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ message })
                });
                
                const data = await response.json();
                
                // Display the response
                const messagesDiv = document.getElementById('messages');
                messagesDiv.innerHTML += `
                    <div class="message user">You: ${message}</div>
                    <div class="message ai">AI: ${data.response}</div>
                `;
                
                input.value = '';
            } catch (error) {
                console.error('Error:', error);
                alert('Error sending message');
            }
        }
        
        // Send message on Enter key
        document.getElementById('message-input').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });
    </script>
</body>
</html>
```

## Minimum Viable App Example

Here's a complete "Hello World" app:

### 1. Directory Structure
```
apps/hello-world/
├── app-config.json
├── routes/
│   └── main.mjs
└── public/
    └── index.html
```

### 2. Configuration (app-config.json)
```json
{
  "name": "Hello World App",
  "description": "A simple hello world application",
  "version": "1.0.0",
  "baseRoute": "/apps/hello-world",
  "staticRoute": "/apps/hello-world"
}
```

### 3. Routes (routes/main.mjs)
```javascript
import express from 'express';

const router = express.Router();

router.get('/hello', (req, res) => {
  res.json({
    message: 'Hello, World!',
    timestamp: new Date().toISOString()
  });
});

export default router;
```

### 4. Static Interface (public/index.html)
```html
<!DOCTYPE html>
<html>
<head>
    <title>Hello World App</title>
</head>
<body>
    <h1>Hello World App</h1>
    <button onclick="sayHello()">Say Hello</button>
    <div id="result"></div>
    
    <script>
        async function sayHello() {
            const response = await fetch('/charm/apps/hello-world/hello');
            const data = await response.json();
            document.getElementById('result').innerHTML = 
                `<p>${data.message}</p><small>${data.timestamp}</small>`;
        }
    </script>
</body>
</html>
```

### 5. Global Configuration (conf/config.json)
```json
{
  "apps": {
    "hello-world": {
      "directory": "./apps/hello-world",
      "enabled": true,
      "description": "Hello World demonstration app"
    }
  }
}
```

## Running Your App

1. **Create the app directory** and files as shown above
2. **Add the app to your main config.json** in the `apps` section
3. **Start the server**: `node server.mjs`
4. **Access your app**:
   - API: `http://localhost:5002/charm/apps/hello-world/hello`
   - Interface: `http://localhost:5002/charm/apps/hello-world/index.html`

## Advanced Features

### Using AI Models

Apps can access any configured AI model:

```javascript
import { fetchChatModel } from '../../../lib/core.mjs';

const chatModel = fetchChatModel('gpt-4o');
const response = await chatModel.replyTo('Your prompt here');
```

### Using Tools

Apps can access configured tools:

```javascript
import { toolRegistry } from '../../../lib/tools.mjs';

const webSearchTool = toolRegistry.getTool('web_search');
if (webSearchTool) {
  const results = await webSearchTool.execute({ query: 'search term' });
}
```

### Error Handling

Implement proper error handling in your routes:

```javascript
router.post('/api-endpoint', async (req, res) => {
  try {
    // Your logic here
    res.json({ success: true });
  } catch (error) {
    console.error('Error in api-endpoint:', error);
    res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});
```

### Multiple Route Files

You can have multiple route files in the `routes/` directory:

```
routes/
├── main.mjs      # Main API routes
├── admin.mjs     # Admin-specific routes  
└── webhooks.mjs  # Webhook handlers
```

Each file should export an Express router, and all will be automatically loaded and mounted.

## Best Practices

1. **Use descriptive app IDs** that won't conflict with other apps
2. **Follow the existing code style** (ES modules, JSDoc, error handling)
3. **Validate input parameters** in your API endpoints
4. **Use the configured AI models** rather than hardcoding model names
5. **Handle errors gracefully** and return appropriate HTTP status codes
6. **Keep apps self-contained** - don't depend on other apps
7. **Document your app's API** in comments or separate documentation
8. **Test your app thoroughly** before deployment

## Troubleshooting

### App Not Loading
- Check that the app is enabled in `config.json`
- Verify the directory path is correct
- Check server logs for error messages
- Ensure route files export Express routers correctly

### Routes Not Working
- Verify route files are in the correct `routes/` directory
- Check that routes export `default router`
- Ensure proper error handling in route handlers
- Check server logs for route mounting messages

### Static Files Not Serving
- Verify files are in the `public/` directory
- Check the `staticRoute` configuration
- Ensure file permissions are correct
- Check server logs for static mounting messages

The app system provides a powerful way to extend Charmonator's functionality while maintaining clean separation of concerns and modular architecture.