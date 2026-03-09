const koffi = require('koffi');
const path = require('path');
const fs = require('fs');

/**
 * LogosAPI - A JavaScript SDK for interacting with liblogos_core
 *
 * This class abstracts the FFI functionality needed to use liblogos including:
 * - Library loading and initialization
 * - Plugin management (processing, loading, unloading)
 * - Async method calls and event handling
 * - Event processing and lifecycle management
 *
 * Uses koffi for FFI (supports Node.js 16+, including v24).
 */
class LogosAPI {
  constructor(options = {}) {
    this.options = {
      libPath: options.libPath || null,
      pluginsDir: options.pluginsDir || null,
      autoInit: options.autoInit !== false, // Default to true
      ...options
    };

    this._lib = null;         // koffi library handle
    this._fns = {};           // bound C functions
    this.isInitialized = false;
    this.isStarted = false;
    this.eventProcessingInterval = null;
    this.callbacks = new Map();
    this.eventListeners = new Map();
    this._registeredCallbacks = []; // prevent GC of koffi.register() handles

    if (this.options.autoInit) {
      this.init();
    }

    // Cache for reflective plugin proxies
    this._pluginProxies = new Map();

    // Return a proxy to enable reflective access like logos.chat.joinChannel(...)
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        // Preserve access to existing properties/methods
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        // Support Symbol utilities without treating them as plugins
        if (typeof prop !== 'string') {
          return undefined;
        }
        // Dynamically create and return a plugin proxy
        return target._getPluginProxy(prop);
      }
    });
  }

  /**
   * Initialize the LogosCore library
   */
  init() {
    if (this.isInitialized) {
      throw new Error('LogosAPI is already initialized');
    }

    try {
      this._loadLibrary();
      this._initializeCore();
      this.isInitialized = true;
      return true;
    } catch (error) {
      throw new Error(`Failed to initialize LogosAPI: ${error.message}`);
    }
  }

  /**
   * Load the liblogos_core library via koffi
   * @private
   */
  _loadLibrary() {
    // Determine library path
    let libPath = this.options.libPath;
    if (!libPath) {
      const libExtension = this._getLibraryExtension();
      const libName = `liblogos_core${libExtension}`;

      const platformDir = this._getPlatformDir();

      // Search order:
      // 1. SDK's own lib/{platform}/ directory (multi-platform layout)
      // 2. SDK's own lib/ directory (single-platform fallback)
      // 3. LOGOS_LIBLOGOS_ROOT env var (fallback for dev environments)
      // 4. Nix build output in SDK (result/lib/ — works for local file: deps)
      const candidates = [
        path.resolve(__dirname, 'lib', platformDir, libName),
        path.resolve(__dirname, 'lib', libName),
        process.env.LOGOS_LIBLOGOS_ROOT && path.join(process.env.LOGOS_LIBLOGOS_ROOT, 'lib', libName),
        path.resolve(__dirname, 'result', 'lib', libName),
      ].filter(Boolean);

      libPath = candidates.find(p => fs.existsSync(p));

      if (!libPath) {
        throw new Error(
          `liblogos_core not found. Searched:\n` +
          candidates.map(p => `  - ${p}`).join('\n') + '\n' +
          'Set LOGOS_LIBLOGOS_ROOT or pass libPath in constructor options.'
        );
      }
    }

    // Load the shared library
    this._lib = koffi.load(libPath);

    // Define the async callback type: void (*)(int result, const char *message, void *user_data)
    this._AsyncCallbackProto = koffi.proto('void AsyncCallback(int result, const char *message, void *user_data)');

    // Bind all C functions
    const lib = this._lib;
    this._fns = {
      // Core lifecycle
      init:                  lib.func('void logos_core_init(int argc, void *argv)'),
      setMode:               lib.func('void logos_core_set_mode(int mode)'),
      setPluginsDir:         lib.func('void logos_core_set_plugins_dir(const char *dir)'),
      addPluginsDir:         lib.func('void logos_core_add_plugins_dir(const char *dir)'),
      start:                 lib.func('void logos_core_start()'),
      exec:                  lib.func('int logos_core_exec()'),
      cleanup:               lib.func('void logos_core_cleanup()'),

      // Plugin management
      getLoadedPlugins:      lib.func('void *logos_core_get_loaded_plugins()'),
      getKnownPlugins:       lib.func('void *logos_core_get_known_plugins()'),
      loadPlugin:            lib.func('int logos_core_load_plugin(const char *name)'),
      loadPluginWithDeps:    lib.func('int logos_core_load_plugin_with_dependencies(const char *name)'),
      unloadPlugin:          lib.func('int logos_core_unload_plugin(const char *name)'),
      processPlugin:         lib.func('const char *logos_core_process_plugin(const char *path)'),

      // Token management
      getToken:              lib.func('const char *logos_core_get_token(const char *key)'),

      // Module stats
      getModuleStats:        lib.func('const char *logos_core_get_module_stats()'),

      // Async operations
      asyncOperation:        lib.func('void logos_core_async_operation(const char *data, AsyncCallback *cb, void *user_data)'),
      loadPluginAsync:       lib.func('void logos_core_load_plugin_async(const char *name, AsyncCallback *cb, void *user_data)'),
      callPluginMethodAsync: lib.func('void logos_core_call_plugin_method_async(const char *plugin, const char *method, const char *params, AsyncCallback *cb, void *user_data)'),

      // Event listener
      registerEventListener: lib.func('void logos_core_register_event_listener(const char *plugin, const char *event, AsyncCallback *cb, void *user_data)'),

      // Qt event processing
      processEvents:         lib.func('void logos_core_process_events()'),
    };
  }

  /**
   * Get the appropriate library extension for the current platform
   * @private
   */
  _getLibraryExtension() {
    switch (process.platform) {
      case 'darwin':
        return '.dylib';
      case 'win32':
        return '.dll';
      default:
        return '.so';
    }
  }

  /**
   * Get the platform subdirectory name (e.g. "darwin-arm64", "linux-x64")
   * @private
   */
  _getPlatformDir() {
    return `${process.platform}-${process.arch}`;
  }

  /**
   * Initialize the core system
   * @private
   */
  _initializeCore() {
    this._fns.init(0, null);

    // Set plugins directory
    const pluginsDir = this._resolvePluginsDir();

    if (!fs.existsSync(pluginsDir)) {
      throw new Error(`Plugins directory not found at: ${pluginsDir}. Please ensure modules are available.`);
    }

    // Auto-detect logos_host if not already set via env
    this._resolveLogosHost(pluginsDir);

    this._fns.setPluginsDir(pluginsDir);
  }

  /**
   * Try to locate logos_host and set LOGOS_HOST_PATH env var.
   * The C++ plugin_manager.cpp searches:
   *   1. LOGOS_HOST_PATH env var
   *   2. Next to running executable (won't work for Node.js)
   *   3. ../bin/logos_host relative to plugins dir
   * We help by setting the env var if we can find it.
   * @private
   */
  _resolveLogosHost(pluginsDir) {
    if (process.env.LOGOS_HOST_PATH && fs.existsSync(process.env.LOGOS_HOST_PATH)) {
      return; // Already set and valid
    }

    const hostName = process.platform === 'win32' ? 'logos_host.exe' : 'logos_host';
    const platformDir = this._getPlatformDir();
    const candidates = [
      // SDK's own bin/{platform}/ directory (multi-platform layout)
      path.resolve(__dirname, 'bin', platformDir, hostName),
      // SDK's own bin/ directory (single-platform fallback)
      path.resolve(__dirname, 'bin', hostName),
      // LOGOS_LIBLOGOS_ROOT/bin/ (fallback for dev environments)
      process.env.LOGOS_LIBLOGOS_ROOT && path.join(process.env.LOGOS_LIBLOGOS_ROOT, 'bin', hostName),
      // ../bin/logos_host relative to plugins dir (matches C++ fallback #3)
      path.resolve(pluginsDir, '..', 'bin', hostName),
      // Nix build output in SDK (result/bin/ — works for local file: deps)
      path.resolve(__dirname, 'result', 'bin', hostName),
      // Constructor option
      this.options.logosHostPath,
    ].filter(Boolean);

    const found = candidates.find(p => fs.existsSync(p));
    if (found) {
      process.env.LOGOS_HOST_PATH = found;
    }
  }

  /**
   * Start the LogosCore system
   */
  start() {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized before starting');
    }

    if (this.isStarted) {
      throw new Error('LogosAPI is already started');
    }

    this._fns.start();
    this.isStarted = true;
    return true;
  }

  /**
   * Get the list of loaded plugins
   */
  getLoadedPlugins() {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    const ptr = this._fns.getLoadedPlugins();
    return this._readCStringArray(ptr);
  }

  /**
   * Get the list of known plugins
   */
  getKnownPlugins() {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    const ptr = this._fns.getKnownPlugins();
    return this._readCStringArray(ptr);
  }

  /**
   * Get plugin status information
   */
  getPluginStatus() {
    return {
      loaded: this.getLoadedPlugins(),
      known: this.getKnownPlugins()
    };
  }

  /**
   * Resolve the effective plugins directory
   * @private
   */
  _resolvePluginsDir() {
    if (this.options.pluginsDir) {
      return this.options.pluginsDir;
    }

    // Try common locations relative to cwd
    for (const candidate of ['modules', 'plugins']) {
      const dir = path.resolve(process.cwd(), candidate);
      if (fs.existsSync(dir)) return dir;
    }

    // Fall back to SDK lib directory
    const sdkModules = path.resolve(__dirname, 'lib', 'modules');
    if (fs.existsSync(sdkModules)) return sdkModules;

    return path.resolve(process.cwd(), 'modules');
  }

  /**
   * Process a plugin file and add it to known plugins.
   *
   * Supports two directory layouts:
   *   1. Subdirectory with manifest.json (current standard):
   *        modules/calc_module/manifest.json
   *        modules/calc_module/calc_module_plugin.so
   *   2. Flat layout (legacy): modules/calc_module_plugin.so
   *
   * @param {string} pluginName - Name of the plugin (without extension)
   */
  processPlugin(pluginName) {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    const pluginsDir = this._resolvePluginsDir();
    const pluginExtension = this._getLibraryExtension();

    // Strategy 1: subdirectory with manifest.json (current standard)
    const manifestPath = path.join(pluginsDir, pluginName, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const mainObj = manifest.main;
        if (mainObj && typeof mainObj === 'object') {
          const variants = this._platformVariants();
          let mainLib = null;
          for (const variant of variants) {
            if (mainObj[variant]) { mainLib = mainObj[variant]; break; }
          }
          if (mainLib) {
            const pluginPath = path.join(pluginsDir, pluginName, mainLib);
            if (fs.existsSync(pluginPath)) {
              const result = this._fns.processPlugin(pluginPath);
              return !!result;
            }
          }
        }
      } catch (e) {
        // Fall through to legacy layout
      }
    }

    // Strategy 2: flat layout (legacy)
    const flatPath = path.join(pluginsDir, `${pluginName}_plugin${pluginExtension}`);
    if (fs.existsSync(flatPath)) {
      const result = this._fns.processPlugin(flatPath);
      return !!result;
    }

    throw new Error(
      `Plugin "${pluginName}" not found. Checked:\n` +
      `  - ${manifestPath}\n` +
      `  - ${flatPath}`
    );
  }

  /**
   * Return platform variant strings in preference order (matches logoscore convention).
   * @private
   */
  _platformVariants() {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    switch (process.platform) {
      case 'darwin':
        return [`darwin-${arch === 'aarch64' ? 'arm64' : arch}`, `darwin-${arch}`];
      case 'win32':
        return [`windows-${arch}`];
      default: // linux
        return [`linux-${arch}`];
    }
  }

  /**
   * Load a plugin
   * @param {string} pluginName - Name of the plugin
   */
  loadPlugin(pluginName) {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    const result = this._fns.loadPlugin(pluginName);
    return result === 1;
  }

  /**
   * Unload a plugin
   * @param {string} pluginName - Name of the plugin
   */
  unloadPlugin(pluginName) {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    const result = this._fns.unloadPlugin(pluginName);
    return result === 1;
  }

  /**
   * Load a plugin and all its dependencies automatically.
   * @param {string} pluginName - Name of the plugin
   */
  loadPluginWithDependencies(pluginName) {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    const result = this._fns.loadPluginWithDeps(pluginName);
    return result === 1;
  }

  /**
   * Add an additional plugins directory to scan.
   * @param {string} dir - Directory path containing module subdirectories
   */
  addPluginsDir(dir) {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    this._fns.addPluginsDir(dir);
  }

  /**
   * Set the SDK communication mode.
   * @param {number} mode - 0 = Remote (default, uses logos_host processes), 1 = Local (in-process)
   */
  setMode(mode) {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    this._fns.setMode(mode);
  }

  /**
   * Get a token by key from the core token manager.
   * @param {string} key - Token key
   * @returns {string|null} Token value or null if not found
   */
  getToken(key) {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    return this._fns.getToken(key);
  }

  /**
   * Get module statistics (CPU and memory usage) for all loaded modules.
   * @returns {object|null} Parsed JSON stats or null on error
   */
  getModuleStats() {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    const json = this._fns.getModuleStats();
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch (_e) {
      return json;
    }
  }

  /**
   * Process and load a plugin in one step
   * @param {string} pluginName - Name of the plugin
   */
  processAndLoadPlugin(pluginName) {
    const processed = this.processPlugin(pluginName);
    if (!processed) {
      throw new Error(`Failed to process plugin: ${pluginName}`);
    }

    const loaded = this.loadPlugin(pluginName);
    if (!loaded) {
      throw new Error(`Failed to load plugin: ${pluginName}`);
    }

    return true;
  }

  /**
   * Process and load multiple plugins
   * @param {string[]} pluginNames - Array of plugin names
   */
  processAndLoadPlugins(pluginNames) {
    const results = {};

    for (const pluginName of pluginNames) {
      try {
        results[pluginName] = { processed: this.processPlugin(pluginName) };
      } catch (error) {
        results[pluginName] = { processed: false, error: error.message };
      }
    }

    for (const pluginName of pluginNames) {
      if (results[pluginName].processed) {
        try {
          results[pluginName].loaded = this.loadPlugin(pluginName);
        } catch (error) {
          results[pluginName].loaded = false;
          results[pluginName].error = error.message;
        }
      }
    }

    return results;
  }

  /**
   * Call a plugin method asynchronously
   * @param {string} pluginName - Name of the plugin
   * @param {string} methodName - Name of the method
   * @param {string} params - JSON string of parameters
   * @param {Function} callback - Callback function (success, message, meta) => {}
   */
  callPluginMethodAsync(pluginName, methodName, params, callback) {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    const callbackId = this._generateCallbackId();
    const registered = this._createRegisteredCallback(callback, callbackId);

    this.callbacks.set(callbackId, { callback, registered });

    this._fns.callPluginMethodAsync(pluginName, methodName, params, registered, null);

    return callbackId;
  }

  /**
   * Register an event listener
   * @param {string} pluginName - Name of the plugin
   * @param {string} eventName - Name of the event
   * @param {Function} callback - Callback function (success, message, meta) => {}
   */
  registerEventListener(pluginName, eventName, callback) {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    const listenerId = this._generateCallbackId();
    const registered = this._createRegisteredCallback(callback, listenerId);

    this.eventListeners.set(listenerId, {
      pluginName,
      eventName,
      callback,
      registered
    });

    this._fns.registerEventListener(pluginName, eventName, registered, null);

    return listenerId;
  }

  /**
   * Start event processing loop
   * @param {number} interval - Processing interval in milliseconds (default: 100)
   */
  startEventProcessing(interval = 100) {
    if (this.eventProcessingInterval) {
      throw new Error('Event processing is already running');
    }

    this.eventProcessingInterval = setInterval(() => {
      if (this._fns.processEvents) {
        this._fns.processEvents();
      }
    }, interval);

    return true;
  }

  /**
   * Stop event processing loop
   */
  stopEventProcessing() {
    if (this.eventProcessingInterval) {
      clearInterval(this.eventProcessingInterval);
      this.eventProcessingInterval = null;
      return true;
    }
    return false;
  }

  /**
   * Execute the core event loop (blocking)
   */
  exec() {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }

    return this._fns.exec();
  }

  /**
   * Clean up and shutdown
   */
  cleanup() {
    this.stopEventProcessing();

    if (this._fns.cleanup) {
      this._fns.cleanup();
    }

    // Unregister all koffi callbacks
    for (const handle of this._registeredCallbacks) {
      try { koffi.unregister(handle); } catch (_e) { /* ignore */ }
    }
    this._registeredCallbacks = [];

    this.callbacks.clear();
    this.eventListeners.clear();

    this.isInitialized = false;
    this.isStarted = false;
  }

  // ===== Private helpers =====

  /**
   * Read a null-terminated char** array from a C pointer into a JS string array.
   * koffi.decode(ptr, offset, 'char *') does one dereference: reads the char*
   * at ptr+offset, follows it to the string. Returns null for the NULL terminator.
   * @private
   */
  _readCStringArray(ptr) {
    const result = [];
    if (!ptr) return result;

    const ptrSize = koffi.sizeof('void *');
    for (let i = 0; ; i++) {
      const str = koffi.decode(ptr, i * ptrSize, 'char *');
      if (!str) break;
      result.push(str);
    }

    return result;
  }

  /**
   * Generate a unique callback ID
   * @private
   */
  _generateCallbackId() {
    return `callback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Create a registered koffi callback (persists beyond the C function call).
   * @private
   */
  _createRegisteredCallback(userCallback, callbackId) {
    const handle = koffi.register(
      (result, message, _userData) => {
        try {
          const success = result === 1;

          // Try to parse the message. The C++ side sends:
          //   "Method call successful. Result: <value>"
          //   or plain JSON, or a plain error string.
          let parsedMessage;
          try {
            parsedMessage = JSON.parse(message);
          } catch (_e) {
            // Extract result value from the C++ format
            const match = message && message.match(/^Method call successful\. Result: (.+)$/);
            if (match) {
              const val = match[1];
              // Try to parse the extracted value
              if (val === 'true') parsedMessage = true;
              else if (val === 'false') parsedMessage = false;
              else if (!isNaN(Number(val))) parsedMessage = Number(val);
              else parsedMessage = val;
            } else {
              parsedMessage = message;
            }
          }

          userCallback(success, parsedMessage, {
            callbackId,
            timestamp: new Date().toISOString(),
            rawMessage: message
          });
        } catch (error) {
          console.error(`Error in callback ${callbackId}:`, error);
        }
      },
      koffi.pointer(this._AsyncCallbackProto)
    );

    // Prevent GC
    this._registeredCallbacks.push(handle);
    return handle;
  }

  // ===== Reflective API helpers =====

  _getPluginProxy(pluginName) {
    if (this._pluginProxies.has(pluginName)) {
      return this._pluginProxies.get(pluginName);
    }
    const proxy = this._createReflectivePluginProxy(pluginName);
    this._pluginProxies.set(pluginName, proxy);
    return proxy;
  }

  _createReflectivePluginProxy(pluginName) {
    const decapitalize = (s) => s.length ? s.charAt(0).toLowerCase() + s.slice(1) : s;
    const makeParamsJson = (args) => {
      const toParam = (arg, index) => {
        const inferred = this._inferTypeAndValue(arg);
        return { name: `arg${index}`, value: inferred.value, type: inferred.type };
      };
      return JSON.stringify(Array.from(args).map(toParam));
    };

    const api = this;

    return new Proxy({}, {
      get(_t, property) {
        if (property === 'pluginName') return pluginName;
        if (property === 'toString') return () => `[LogosPluginProxy ${pluginName}]`;
        if (property === 'then') return undefined;

        if (typeof property !== 'string') {
          return undefined;
        }

        // Event subscription: on<EventName>(callback)
        if (property.startsWith('on') && property.length > 2) {
          const eventName = decapitalize(property.slice(2));
          return (callback) => {
            if (typeof callback !== 'function') {
              throw new Error(`Callback must be a function for ${pluginName}.${property}`);
            }
            return api.registerEventListener(pluginName, eventName, (success, message, meta) => {
              if (success) {
                callback(message);
              } else {
                callback({ error: true, message });
              }
            });
          };
        }

        // Method invocation: returns a Promise
        return (...args) => new Promise((resolve, reject) => {
          try {
            const params = makeParamsJson(args);
            api.callPluginMethodAsync(pluginName, property, params, (success, message, meta) => {
              if (success) {
                resolve(message);
              } else {
                reject(message);
              }
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    });
  }

  _inferTypeAndValue(value) {
    if (value === null || value === undefined) {
      return { type: 'string', value: '' };
    }
    const t = typeof value;
    if (t === 'boolean') {
      return { type: 'bool', value: value ? 'true' : 'false' };
    }
    if (t === 'number') {
      if (Number.isInteger(value)) {
        return { type: 'int', value: String(value) };
      }
      return { type: 'double', value: String(value) };
    }
    if (t === 'string') {
      return { type: 'string', value };
    }
    try {
      return { type: 'string', value: JSON.stringify(value) };
    } catch (_e) {
      return { type: 'string', value: String(value) };
    }
  }
}

module.exports = LogosAPI;
