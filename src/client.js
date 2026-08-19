'use strict';
// -----------------------------------------------------------------------------
// Consumer — call other Logos modules FROM Node over a plain transport
// (lp_client_*). No Qt host, no event loop of ours.
//
//   const logos = new LogosClient('my_app', { transport: tcp('127.0.0.1', 6001) });
//   const calc  = logos.module('calc_module');
//   const sum   = await calc.call('add', 5, 3);         // async (Promise)
//   const off   = calc.on('computed', (v) => { ... });  // event subscription
//
// call() uses lp_invoke_async so the Node event loop stays free (the result
// callback is marshaled back to the main loop). callSync() blocks — handy for
// scripts, not for servers.
// -----------------------------------------------------------------------------
const ffi = require('./ffi.js');

const DEFAULT_TIMEOUT_MS = 30000;

class ModuleProxy {
  constructor(lp, target, origin, transportJson, capabilityJson) {
    this._lp = lp;
    this.target = target;
    this._client = lp.lp_client_create(target, origin, transportJson, capabilityJson);
    if (!this._client) throw new Error(`lp_client_create failed for target '${target}'`);
    this._subs = [];

    // ONE persistent result callback per proxy, correlated by the call id we
    // pass as user_data. Registering/unregistering a koffi callback per call
    // churns koffi's cross-thread callback table and corrupts the marshaling of
    // OTHER in-flight callbacks (e.g. event delivery) — so we register once.
    this._pending = new Map();      // id -> { resolve, reject }
    this._nextId = 1;
    this._resultCb = lp.koffi.register((ok, json, udata) => {
      const id = Number(lp.koffi.address(udata)); // the id we passed as user_data
      const p = this._pending.get(id);
      if (!p) return;
      this._pending.delete(id);
      if (ok) {
        let val = null;
        if (json != null) { try { val = JSON.parse(json); } catch { val = json; } }
        p.resolve(val);
      } else {
        let msg = `call ${this.target} failed`;
        if (json != null) { try { const e = JSON.parse(json); if (e && e.message) msg = e.message; } catch { /* ignore */ } }
        p.reject(new Error(msg));
      }
    }, lp.koffi.pointer(lp.ResultCb));
  }

  /** Async call → Promise. Extra args are the positional method arguments. */
  call(method, ...args) {
    return this.callWithTimeout(DEFAULT_TIMEOUT_MS, method, ...args);
  }

  callWithTimeout(timeoutMs, method, ...args) {
    const lp = this._lp;
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      // The call id travels as user_data (a void*); we read it back via
      // koffi.address() in the shared result callback — no per-call register.
      const rc = lp.lp_invoke_async(this._client, method, JSON.stringify(args), timeoutMs, this._resultCb, BigInt(id));
      if (rc !== ffi.LP_OK) { this._pending.delete(id); reject(new Error(`lp_invoke_async rc=${rc}`)); }
    });
  }

  /** Synchronous call (blocks the event loop). Returns the result value. */
  callSync(method, ...args) {
    const lp = this._lp;
    const outRes = [null], outErr = [null];
    const rc = lp.lp_invoke(this._client, method, JSON.stringify(args), DEFAULT_TIMEOUT_MS, outRes, outErr);
    const errStr = ffi.takeString(lp, outErr[0]);
    const resStr = ffi.takeString(lp, outRes[0]);
    if (rc !== ffi.LP_OK) {
      let msg = `call ${this.target}.${method} failed`;
      if (errStr) { try { const e = JSON.parse(errStr); if (e && e.message) msg = e.message; } catch { /* ignore */ } }
      throw new Error(msg);
    }
    return resStr == null ? null : JSON.parse(resStr);
  }

  /** Subscribe to an event. handler receives the event payload as spread args.
   *  Returns an unsubscribe function. */
  on(eventName, handler) {
    const lp = this._lp;
    const cb = lp.koffi.register((name, dataJson) => {
      let data = [];
      if (dataJson != null) { try { data = JSON.parse(dataJson); } catch { data = [dataJson]; } }
      try { handler(...(Array.isArray(data) ? data : [data])); } catch { /* user handler */ }
    }, lp.koffi.pointer(lp.EventCb));
    const sub = lp.lp_subscribe(this._client, eventName, cb, null);
    const entry = { cb, sub };
    this._subs.push(entry);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this._subs = this._subs.filter((e) => e !== entry);
      // Defer the FFI teardown: off() is commonly called from INSIDE the event
      // handler (one-shot subscriptions), which koffi runs on the main thread
      // while the library's I/O thread is blocked awaiting the callback's
      // return. Unsubscribing/unregistering synchronously there deadlocks — run
      // it after the callback has unwound.
      setImmediate(() => {
        if (sub) { try { lp.lp_unsubscribe(sub); } catch { /* ignore */ } }
        try { lp.koffi.unregister(cb); } catch { /* ignore */ }
      });
    };
  }

  /** The target module's method interface (array of {name, signature, ...}). */
  getMethods() {
    const s = ffi.takeString(this._lp, this._lp.lp_get_methods(this._client));
    if (!s) return [];
    try { return JSON.parse(s); } catch { return []; }
  }

  /** Register an auth token for `moduleName` with capability_module. */
  informToken(authToken, moduleName, token) {
    return this._lp.lp_inform_module_token(this._client, authToken, moduleName, token) === ffi.LP_OK;
  }

  destroy() {
    for (const { cb, sub } of this._subs) {
      if (sub) { try { this._lp.lp_unsubscribe(sub); } catch { /* ignore */ } }
      try { this._lp.koffi.unregister(cb); } catch { /* ignore */ }
    }
    this._subs = [];
    if (this._client) { this._lp.lp_client_destroy(this._client); this._client = null; }
    this._pending.clear();
    setImmediate(() => { try { this._lp.koffi.unregister(this._resultCb); } catch { /* ignore */ } });
  }
}

class LogosClient {
  /**
   * @param {string} originModule  who we call as (our own module/app name)
   * @param {Object} opts
   * @param {Object|Array} opts.transport            transport config to the target
   * @param {Object} [opts.capabilityTransport]      transport to capability_module
   *        (defaults to opts.transport)
   * @param {string} [opts.libPath]
   */
  constructor(originModule, opts = {}) {
    if (!originModule) throw new Error('LogosClient: originModule is required');
    this._lp = ffi.load(opts.libPath);
    this._origin = originModule;
    const t = opts.transport;
    if (!t) throw new Error('LogosClient: opts.transport is required');
    this._transportJson = JSON.stringify(Array.isArray(t) ? t[0] : t);
    const c = opts.capabilityTransport || t;
    this._capJson = JSON.stringify(Array.isArray(c) ? c[0] : c);
    this._proxies = new Map();
  }

  /** Get (and cache) a proxy to a target module. */
  module(targetName) {
    let p = this._proxies.get(targetName);
    if (!p) {
      p = new ModuleProxy(this._lp, targetName, this._origin, this._transportJson, this._capJson);
      this._proxies.set(targetName, p);
    }
    return p;
  }

  /** Pre-seed an auth token so a target skips the capability handshake. */
  saveToken(moduleName, token) {
    return this._lp.lp_token_save(moduleName, token) === ffi.LP_OK;
  }

  destroy() {
    for (const p of this._proxies.values()) p.destroy();
    this._proxies.clear();
  }
}

module.exports = { LogosClient, ModuleProxy };
