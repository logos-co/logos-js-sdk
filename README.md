NOTE: This is very WIP

# Logos API - JavaScript SDK

A JavaScript SDK for interacting with liblogos_core and liblogos_module_client, providing a clean abstraction over FFI functionality for plugin management, async operations, and event handling.

Uses [koffi](https://koffi.dev/) for FFI (supports Node.js 16+, including v24).

## Architecture

The SDK loads two native libraries:
- **liblogos_core** — core lifecycle, plugin management, event processing
- **liblogos_module_client** — async method calls, event listeners (proxy API)

The module client is initialized with host callbacks that bridge back to the core, so it can query plugin state (is loaded, is known, load plugin).

## Basic Usage

```javascript
const LogosAPI = require('logos-api');

// Initialize with custom options
const logos = new LogosAPI({
  libPath: '/path/to/liblogos_core.so',
  moduleClientLibPath: '/path/to/liblogos_module_client.so',  // optional
  pluginsDir: '/path/to/modules',
  autoInit: false
});

logos.init();
logos.start();
logos.startEventProcessing(50);

// Load a plugin
logos.processAndLoadPlugin('calc_module');

// Call methods via reflective proxy (returns Promise)
const result = await logos.calc_module.add(5, 3);
console.log('5 + 3 =', result);

// Or use the low-level API
logos.callPluginMethodAsync('calc_module', 'add', JSON.stringify([
  { name: 'a', value: '5', type: 'int' },
  { name: 'b', value: '3', type: 'int' }
]), (success, message, meta) => {
  console.log('Result:', message);
});

// Register event listener
logos.registerEventListener('chat', 'chatMessage', (success, message) => {
  console.log('Event:', message);
});

// Or via proxy
logos.chat.onChatMessage((message) => console.log('Chat:', message));

// Cleanup
logos.cleanup();
```

## API Reference

### Constructor Options

```javascript
{
  libPath: string,              // Path to liblogos_core library
  moduleClientLibPath: string,  // Path to liblogos_module_client (optional)
  pluginsDir: string,           // Plugins directory
  logosHostPath: string,        // Path to logos_host binary
  autoInit: boolean             // Auto-initialize on construction (default: true)
}
```

### Core Methods

- `init()` - Initialize the library
- `start()` - Start the LogosCore system
- `cleanup()` - Clean up and shutdown
- `exec()` - Execute blocking event loop

### Plugin Management

- `getLoadedPlugins()` - Get array of loaded plugin names
- `getKnownPlugins()` - Get array of known plugin names
- `getPluginStatus()` - Get object with loaded and known plugins
- `processPlugin(pluginName)` - Process a plugin file
- `loadPlugin(pluginName)` - Load a plugin
- `unloadPlugin(pluginName)` - Unload a plugin
- `loadPluginWithDependencies(pluginName)` - Load with dependency resolution
- `addPluginsDir(dir)` - Add additional plugins directory
- `processAndLoadPlugin(pluginName)` - Process and load in one step
- `processAndLoadPlugins(pluginNames[])` - Process and load multiple plugins
- `getToken(key)` - Get a token by key
- `getModuleStats()` - Get module CPU/memory stats

### Async Operations (via logos-module-client)

- `callPluginMethodAsync(pluginName, methodName, params, callback)` - Call plugin method
- `registerEventListener(pluginName, eventName, callback)` - Register event listener

### Event Processing

- `startEventProcessing(interval)` - Start event processing loop (default: 100ms)
- `stopEventProcessing()` - Stop event processing loop

### Reflective Proxy

Access any loaded plugin as a property: `logos.pluginName.method(args)` returns a Promise.

Event subscription: `logos.pluginName.onEventName(callback)`.

## Requirements

- Node.js 18+
- liblogos_core and logos_host binaries
- liblogos_module_client (optional, needed for async method calls)

## Setting Up Binaries

Run `nix run .#copy-libs` on each target platform:

```bash
cd logos-js-sdk
nix build
nix run .#copy-libs
```

This copies `liblogos_core`, `liblogos_module_client`, and `logos_host` into platform subdirectories:

```
lib/
  darwin-arm64/liblogos_core.dylib
  darwin-arm64/liblogos_module_client.dylib
  linux-x64/liblogos_core.so
  linux-x64/liblogos_module_client.so
bin/
  darwin-arm64/logos_host
  linux-x64/logos_host
```

### Library Resolution Order

1. `sdk/lib/{platform}/` — multi-platform layout
2. `sdk/lib/` — single-platform fallback
3. `LOGOS_LIBLOGOS_ROOT` / `LOGOS_MODULE_CLIENT_ROOT` env vars
4. `sdk/result/` — nix build symlink
