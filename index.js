const koffi = require('koffi');
const path = require('path');
const fs = require('fs');

/**
 * LogosAPI - A JavaScript SDK for interacting with liblogos_core and liblogos_protocol
 *
 * This class abstracts the FFI functionality needed to use liblogos including:
 * - Library loading and initialization (liblogos_core)
 * - Plugin management (processing, loading, unloading)
 * - Async method calls and event handling (liblogos_protocol's lp_* C ABI)
 * - Event processing and lifecycle management
 *
 * Uses koffi for FFI (supports Node.js 16+, including v24).
 */
class LogosAPI {
  constructor(options = {}) {
    this.options = {
      libPath: options.libPath || null,
      // `moduleClientLibPath` kept as a back-compat alias for the path that
      // now points at liblogos_protocol (was liblogos_module_client).
      protocolLibPath: options.protocolLibPath || options.moduleClientLibPath || null,
      pluginsDir: options.pluginsDir || null,
      autoInit: options.autoInit !== false, // Default to true
      ...options
    };

    this._coreLib = null;       // koffi handle for liblogos_core
    this._protocolLib = null;   // koffi handle for liblogos_protocol
    this._core = {};            // bound C functions from liblogos_core
    this._lp = {};              // bound lp_* C functions from liblogos_protocol
    this._lpClients = new Map(); // target plugin name -> lp_client* (cached, one per target)
    this.isInitialized = false;
    this.isStarted = false;
    this.eventProcessingInterval = null;
    this.callbacks = new Map();
    this.eventListeners = new Map();
    this._registeredCallbacks = []; // prevent GC of koffi.register() handles
    this._loadedPluginSet = new Set(); // JS-side tracking of loaded/known plugins
    this._knownPluginSet = new Set();

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
      this._loadCoreLibrary();
      this._loadProtocolLibrary();
      this._initializeCore();
      this.isInitialized = true;
      return true;
    } catch (error) {
      throw new Error(`Failed to initialize LogosAPI: ${error.message}`);
    }
  }

  // ===== Library loading =====

  /**
   * Load the liblogos_core library via koffi
   * @private
   */
  _loadCoreLibrary() {
    const libPath = this._findLibrary('liblogos_core', this.options.libPath, 'LOGOS_LIBLOGOS_ROOT');

    this._coreLib = koffi.load(libPath);
    const lib = this._coreLib;

    // Define the async callback type shared with the lp_* result callback:
    //   void(int ok, const char *json, void *user_data)
    if (!this._AsyncCallbackProto) {
      this._AsyncCallbackProto = koffi.proto('void AsyncCallback(int ok, const char *json, void *user_data)');
    }

    this._core = {
      // Core lifecycle
      init:               lib.func('void logos_core_init(int argc, void *argv)'),
      setPluginsDir:      lib.func('void logos_core_set_plugins_dir(const char *dir)'),
      addPluginsDir:      lib.func('void logos_core_add_plugins_dir(const char *dir)'),
      start:              lib.func('void logos_core_start()'),
      exec:               lib.func('int logos_core_exec()'),
      cleanup:            lib.func('void logos_core_cleanup()'),

      // Plugin management
      getLoadedPlugins:   lib.func('void *logos_core_get_loaded_plugins()'),
      getKnownPlugins:    lib.func('void *logos_core_get_known_plugins()'),
      loadPlugin:         lib.func('int logos_core_load_plugin(const char *name)'),
      loadPluginWithDeps: lib.func('int logos_core_load_plugin_with_dependencies(const char *name)'),
      unloadPlugin:       lib.func('int logos_core_unload_plugin(const char *name)'),
      processPlugin:      lib.func('const char *logos_core_process_plugin(const char *path)'),

      // Token management
      getToken:           lib.func('const char *logos_core_get_token(const char *key)'),

      // Module stats
      getModuleStats:     lib.func('const char *logos_core_get_module_stats()'),

      // Qt event processing
      processEvents:      lib.func('void logos_core_process_events()'),
    };

    // Async method calls go through liblogos_protocol's lp_* ABI, not liblogos_core.
    this._core.callMethodAsync = null;
  }

  /**
   * Load the liblogos_protocol library via koffi and bind the lp_* C ABI.
   *
   * lp_* is the language-neutral protocol C ABI (logos_protocol.h). An
   * out-of-plugin host like this SDK creates a client per target module
   * (origin "core") and the call routes over the process-default transport
   * that liblogos_core configured at startup — no proxy/host-callback layer
   * is required.
   * @private
   */
  _loadProtocolLibrary() {
    let libPath;
    try {
      libPath = this._findLibrary('liblogos_protocol', this.options.protocolLibPath, 'LOGOS_PROTOCOL_ROOT');
    } catch (_e) {
      // logos-protocol is optional — without it the proxy/async API (method
      // calls + event listeners) is unavailable, but core plugin management
      // via liblogos_core still works.
      console.warn('logos-protocol not found; proxy/async API will not be available.');
      return;
    }

    this._protocolLib = koffi.load(libPath);
    const lib = this._protocolLib;

    // Result callback for lp_invoke_async (same shape as AsyncCallback above).
    if (!this._AsyncCallbackProto) {
      this._AsyncCallbackProto = koffi.proto('void AsyncCallback(int ok, const char *json, void *user_data)');
    }
    // Event callback for lp_subscribe.
    if (!this._LpEventCbProto) {
      this._LpEventCbProto = koffi.proto('void LpEventCb(const char *event_name, const char *data_json, void *user_data)');
    }

    // lp_client* / lp_subscription* are opaque handles, bound as `void *`.
    this._lp = {
      clientCreate:  lib.func('void *lp_client_create(const char *target_module, const char *origin_module, const char *target_transport_json, const char *capability_transport_json)'),
      clientDestroy: lib.func('void lp_client_destroy(void *client)'),
      invokeAsync:   lib.func('int lp_invoke_async(void *client, const char *method, const char *args_json, int timeout_ms, AsyncCallback *cb, void *user_data)'),
      subscribe:     lib.func('void *lp_subscribe(void *client, const char *event_name, LpEventCb *cb, void *user_data)'),
      unsubscribe:   lib.func('void lp_unsubscribe(void *sub)'),
      stringFree:    lib.func('void lp_string_free(char *s)'),
    };
  }

  /**
   * Find a native library by name, searching standard locations.
   * @private
   * @param {string} libBaseName - e.g. "liblogos_core"
   * @param {string|null} explicitPath - User-provided path (highest priority)
   * @param {string} envVar - Environment variable pointing to the install root
   * @returns {string} Resolved path
   */
  _findLibrary(libBaseName, explicitPath, envVar) {
    if (explicitPath) {
      if (!fs.existsSync(explicitPath)) {
        throw new Error(`Library not found at explicit path: ${explicitPath}`);
      }
      return explicitPath;
    }

    const ext = this._getLibraryExtension();
    const libName = `${libBaseName}${ext}`;
    const platformDir = this._getPlatformDir();
    const envRoot = process.env[envVar];

    const candidates = [
      path.resolve(__dirname, 'lib', platformDir, libName),
      path.resolve(__dirname, 'lib', libName),
      envRoot && path.join(envRoot, 'lib', libName),
      path.resolve(__dirname, 'result', 'lib', libName),
    ].filter(Boolean);

    const found = candidates.find(p => fs.existsSync(p));
    if (!found) {
      throw new Error(
        `${libBaseName} not found. Searched:\n` +
        candidates.map(p => `  - ${p}`).join('\n') + '\n' +
        `Set ${envVar} or pass the path in constructor options.`
      );
    }
    return found;
  }

  /**
   * Get the appropriate library extension for the current platform
   * @private
   */
  _getLibraryExtension() {
    switch (process.platform) {
      case 'darwin': return '.dylib';
      case 'win32':  return '.dll';
      default:       return '.so';
    }
  }

  /**
   * Get the platform subdirectory name (e.g. "darwin-arm64", "linux-x64")
   * @private
   */
  _getPlatformDir() {
    return `${process.platform}-${process.arch}`;
  }

  // ===== Initialization =====

  /**
   * Initialize the core system
   * @private
   */
  _initializeCore() {
    this._core.init(0, null);

    // Set plugins directory
    const pluginsDir = this._resolvePluginsDir();

    if (!fs.existsSync(pluginsDir)) {
      throw new Error(`Plugins directory not found at: ${pluginsDir}. Please ensure modules are available.`);
    }

    // Auto-detect logos_host if not already set via env
    this._resolveLogosHost(pluginsDir);

    this._core.setPluginsDir(pluginsDir);
  }

  /**
   * Try to locate logos_host and set LOGOS_HOST_PATH env var.
   * @private
   */
  _resolveLogosHost(pluginsDir) {
    if (process.env.LOGOS_HOST_PATH && fs.existsSync(process.env.LOGOS_HOST_PATH)) {
      return;
    }

    const hostName = process.platform === 'win32' ? 'logos_host.exe' : 'logos_host';
    const platformDir = this._getPlatformDir();
    const candidates = [
      path.resolve(__dirname, 'bin', platformDir, hostName),
      path.resolve(__dirname, 'bin', hostName),
      process.env.LOGOS_LIBLOGOS_ROOT && path.join(process.env.LOGOS_LIBLOGOS_ROOT, 'bin', hostName),
      path.resolve(pluginsDir, '..', 'bin', hostName),
      path.resolve(__dirname, 'result', 'bin', hostName),
      this.options.logosHostPath,
    ].filter(Boolean);

    const found = candidates.find(p => fs.existsSync(p));
    if (found) {
      process.env.LOGOS_HOST_PATH = found;
    }
  }

  // ===== Core lifecycle =====

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

    this._core.start();
    this.isStarted = true;
    return true;
  }

  /**
   * Execute the core event loop (blocking)
   */
  exec() {
    if (!this.isInitialized) {
      throw new Error('LogosAPI must be initialized first');
    }
    return this._core.exec();
  }

  /**
   * Clean up and shutdown
   */
  cleanup() {
    this.stopEventProcessing();

    // Tear down protocol subscriptions and clients before unwinding the core.
    if (this._lp.unsubscribe) {
      for (const { sub } of this.eventListeners.values()) {
        if (sub) { try { this._lp.unsubscribe(sub); } catch (_e) { /* ignore */ } }
      }
    }
    if (this._lp.clientDestroy) {
      for (const client of this._lpClients.values()) {
        try { this._lp.clientDestroy(client); } catch (_e) { /* ignore */ }
      }
    }
    this._lpClients.clear();

    if (this._core.cleanup) {
      this._core.cleanup();
    }

    // Unregister all koffi callbacks
    for (const handle of this._registeredCallbacks) {
      try { koffi.unregister(handle); } catch (_e) { /* ignore */ }
    }
    this._registeredCallbacks = [];

    this.callbacks.clear();
    this.eventListeners.clear();
    this._loadedPluginSet.clear();
    this._knownPluginSet.clear();

    this.isInitialized = false;
    this.isStarted = false;
  }

  // ===== Plugin management (core) =====

  getLoadedPlugins() {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');
    return this._readCStringArray(this._core.getLoadedPlugins());
  }

  getKnownPlugins() {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');
    return this._readCStringArray(this._core.getKnownPlugins());
  }

  getPluginStatus() {
    return { loaded: this.getLoadedPlugins(), known: this.getKnownPlugins() };
  }

  /**
   * Process a plugin file and add it to known plugins.
   *
   * Supports two directory layouts:
   *   1. Subdirectory with manifest.json (current standard)
   *   2. Flat layout (legacy): modules/calc_module_plugin.so
   */
  processPlugin(pluginName) {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');

    const pluginsDir = this._resolvePluginsDir();
    const pluginExtension = this._getLibraryExtension();

    // Strategy 1: subdirectory with manifest.json
    const manifestPath = path.join(pluginsDir, pluginName, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const mainObj = manifest.main;
        if (mainObj && typeof mainObj === 'object') {
          const variants = this._platformVariants();
          for (const variant of variants) {
            if (mainObj[variant]) {
              const pluginPath = path.join(pluginsDir, pluginName, mainObj[variant]);
              if (fs.existsSync(pluginPath)) {
                const result = !!this._core.processPlugin(pluginPath);
                if (result) this._knownPluginSet.add(pluginName);
                return result;
              }
            }
          }
        }
      } catch (_e) { /* fall through */ }
    }

    // Strategy 2: flat layout
    const flatPath = path.join(pluginsDir, `${pluginName}_plugin${pluginExtension}`);
    if (fs.existsSync(flatPath)) {
      const result = !!this._core.processPlugin(flatPath);
      if (result) this._knownPluginSet.add(pluginName);
      return result;
    }

    throw new Error(
      `Plugin "${pluginName}" not found. Checked:\n  - ${manifestPath}\n  - ${flatPath}`
    );
  }

  loadPlugin(pluginName) {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');
    const result = this._core.loadPlugin(pluginName) === 1;
    if (result) this._loadedPluginSet.add(pluginName);
    return result;
  }

  unloadPlugin(pluginName) {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');
    const result = this._core.unloadPlugin(pluginName) === 1;
    if (result) this._loadedPluginSet.delete(pluginName);
    return result;
  }

  loadPluginWithDependencies(pluginName) {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');
    const result = this._core.loadPluginWithDeps(pluginName) === 1;
    if (result) {
      this._loadedPluginSet.add(pluginName);
      // Sync with core since deps may have been loaded too
      try {
        for (const name of this.getLoadedPlugins()) this._loadedPluginSet.add(name);
      } catch (_e) { /* best effort */ }
    }
    return result;
  }

  addPluginsDir(dir) {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');
    this._core.addPluginsDir(dir);
  }

  processAndLoadPlugin(pluginName) {
    const processed = this.processPlugin(pluginName);
    if (!processed) throw new Error(`Failed to process plugin: ${pluginName}`);
    const loaded = this.loadPlugin(pluginName);
    if (!loaded) throw new Error(`Failed to load plugin: ${pluginName}`);
    return true;
  }

  processAndLoadPlugins(pluginNames) {
    const results = {};
    for (const name of pluginNames) {
      try { results[name] = { processed: this.processPlugin(name) }; }
      catch (error) { results[name] = { processed: false, error: error.message }; }
    }
    for (const name of pluginNames) {
      if (results[name].processed) {
        try { results[name].loaded = this.loadPlugin(name); }
        catch (error) { results[name].loaded = false; results[name].error = error.message; }
      }
    }
    return results;
  }

  getToken(key) {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');
    return this._core.getToken(key);
  }

  getModuleStats() {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');
    const json = this._core.getModuleStats();
    if (!json) return null;
    try { return JSON.parse(json); } catch (_e) { return json; }
  }

  // ===== Async / proxy API (lp_* over liblogos_protocol) =====

  /**
   * Get (or lazily create + cache) an lp_client for a target plugin.
   *
   * Origin is "core": this process is the host, and the target is reached over
   * the process-default transport that liblogos_core configured at startup.
   * @private
   */
  _clientFor(pluginName) {
    let client = this._lpClients.get(pluginName);
    if (client) return client;
    client = this._lp.clientCreate(pluginName, 'core', null, null);
    if (client) this._lpClients.set(pluginName, client);
    return client;
  }

  /**
   * Call a plugin method asynchronously via lp_invoke_async.
   */
  callPluginMethodAsync(pluginName, methodName, params, callback) {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');
    if (!this._protocolLib) {
      throw new Error('logos-protocol not loaded; cannot call plugin methods');
    }

    const client = this._clientFor(pluginName);
    if (!client) throw new Error(`Failed to create protocol client for plugin: ${pluginName}`);

    const callbackId = this._generateCallbackId();
    const registered = this._createRegisteredCallback(callback, callbackId);
    this.callbacks.set(callbackId, { callback, registered });

    const rc = this._lp.invokeAsync(client, methodName, params || '[]', 0, registered, null);
    if (rc !== 0) {
      callback(false, `Failed to dispatch method call to ${pluginName}.${methodName}`, { callbackId });
    }
    return callbackId;
  }

  /**
   * Register an event listener via lp_subscribe.
   */
  registerEventListener(pluginName, eventName, callback) {
    if (!this.isInitialized) throw new Error('LogosAPI must be initialized first');
    if (!this._protocolLib) throw new Error('logos-protocol not loaded; cannot register events');

    const client = this._clientFor(pluginName);
    if (!client) throw new Error(`Failed to create protocol client for plugin: ${pluginName}`);

    const listenerId = this._generateCallbackId();
    const registered = this._createEventCallback(callback, listenerId);
    const sub = this._lp.subscribe(client, eventName, registered, null);
    this.eventListeners.set(listenerId, { pluginName, eventName, callback, registered, sub });
    return listenerId;
  }

  // ===== Event processing =====

  startEventProcessing(interval = 100) {
    if (this.eventProcessingInterval) throw new Error('Event processing is already running');

    this.eventProcessingInterval = setInterval(() => {
      if (this._core.processEvents) this._core.processEvents();
    }, interval);
    return true;
  }

  stopEventProcessing() {
    if (this.eventProcessingInterval) {
      clearInterval(this.eventProcessingInterval);
      this.eventProcessingInterval = null;
      return true;
    }
    return false;
  }

  // ===== Private helpers =====

  _resolvePluginsDir() {
    if (this.options.pluginsDir) return this.options.pluginsDir;

    for (const candidate of ['modules', 'plugins']) {
      const dir = path.resolve(process.cwd(), candidate);
      if (fs.existsSync(dir)) return dir;
    }

    const sdkModules = path.resolve(__dirname, 'lib', 'modules');
    if (fs.existsSync(sdkModules)) return sdkModules;

    return path.resolve(process.cwd(), 'modules');
  }

  _platformVariants() {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    switch (process.platform) {
      case 'darwin':
        return [`darwin-${arch === 'aarch64' ? 'arm64' : arch}`, `darwin-${arch}`];
      case 'win32':
        return [`windows-${arch}`];
      default:
        return [`linux-${arch}`];
    }
  }

  /**
   * Read a null-terminated char** array from a C pointer into a JS string array.
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

  _generateCallbackId() {
    return `callback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Parse an lp_* JSON payload into a JS value, falling back to the raw string.
   * @private
   */
  _parsePayload(json) {
    if (json === null || json === undefined || json === '') return json;
    try { return JSON.parse(json); } catch (_e) { return json; }
  }

  /**
   * Create a registered koffi result callback for lp_invoke_async
   * (persists beyond the C function call).
   * @private
   */
  _createRegisteredCallback(userCallback, callbackId) {
    const handle = koffi.register(
      (ok, json, _userData) => {
        try {
          userCallback(ok === 1, this._parsePayload(json), {
            callbackId,
            timestamp: new Date().toISOString(),
            rawMessage: json
          });
        } catch (error) {
          console.error(`Error in callback ${callbackId}:`, error);
        }
      },
      koffi.pointer(this._AsyncCallbackProto)
    );
    this._registeredCallbacks.push(handle);
    return handle;
  }

  /**
   * Create a registered koffi event callback for lp_subscribe.
   * @private
   */
  _createEventCallback(userCallback, listenerId) {
    const handle = koffi.register(
      (eventName, dataJson, _userData) => {
        try {
          userCallback(true, this._parsePayload(dataJson), {
            listenerId,
            eventName,
            timestamp: new Date().toISOString(),
            rawMessage: dataJson
          });
        } catch (error) {
          console.error(`Error in event listener ${listenerId}:`, error);
        }
      },
      koffi.pointer(this._LpEventCbProto)
    );
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
    // lp_invoke takes a plain JSON array of positional argument values
    // (native JSON types). The module's dispatch coerces per its signature.
    const makeParamsJson = (args) => JSON.stringify(Array.from(args));

    const api = this;

    return new Proxy({}, {
      get(_t, property) {
        if (property === 'pluginName') return pluginName;
        if (property === 'toString') return () => `[LogosPluginProxy ${pluginName}]`;
        if (property === 'then') return undefined;
        if (typeof property !== 'string') return undefined;

        // Event subscription: on<EventName>(callback)
        if (property.startsWith('on') && property.length > 2) {
          const eventName = decapitalize(property.slice(2));
          return (callback) => {
            if (typeof callback !== 'function') {
              throw new Error(`Callback must be a function for ${pluginName}.${property}`);
            }
            return api.registerEventListener(pluginName, eventName, (success, message) => {
              if (success) callback(message);
              else callback({ error: true, message });
            });
          };
        }

        // Method invocation: returns a Promise
        return (...args) => new Promise((resolve, reject) => {
          try {
            const params = makeParamsJson(args);
            api.callPluginMethodAsync(pluginName, property, params, (success, message) => {
              if (success) resolve(message);
              else reject(message);
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    });
  }
}

module.exports = LogosAPI;
