'use strict';
// -----------------------------------------------------------------------------
// Provider — serve a Logos module FROM Node, out-of-process, over a plain
// transport (lp_provider_*). No Qt host, no event loop of ours: the library
// runs its own Asio I/O thread and koffi marshals dispatch/token callbacks to
// this Node process's main loop.
//
// Method handlers are SYNCHRONOUS: they receive the decoded argument list and
// return a JSON-serialisable value (the library blocks its I/O thread on our
// main thread for the duration of dispatch, so a handler must not return a
// Promise). Async request/response is a future addition (a deferred-reply ABI).
// -----------------------------------------------------------------------------
const ffi = require('./ffi.js');

const LP_ERR_UNSUPPORTED = -2;

const NO_PROVIDER_SERVING =
  'this liblogos_protocol has GROUNDWORK-ONLY lp_provider_* — it accepts the ' +
  'registration and then serves nothing (lp_provider_emit_event / ' +
  'lp_provider_save_token return LP_ERR_UNSUPPORTED, and no socket is ever ' +
  'opened, so consumers get "Connection refused" until their timeout). ' +
  'Serving a provider through the C ABI needs logos-protocol#12 ' +
  '(feat/qtfree-plain-provider); its stack tips at #16 ' +
  '(feat/protocol-shared-lib), which is what this SDK\'s flake pins. The ' +
  'CONSUMER half (LogosClient) works against protocol master unchanged.';

class Provider {
  /**
   * @param {string} moduleName        the module name this provider serves as
   * @param {Array|Object} transports  transport set: an array of transport
   *   configs, or a single config object (wrapped into a one-element array),
   *   e.g. { protocol:'tcp', host:'127.0.0.1', port:6001, codec:'json' } or
   *        { protocol:'plain_local', socket_path:'/tmp/m.sock', codec:'json' }
   * @param {{libPath?:string}} [opts]
   */
  constructor(moduleName, transports, opts = {}) {
    if (!moduleName) throw new Error('Provider: moduleName is required');
    this._lp = ffi.load(opts.libPath);
    this.name = moduleName;
    const set = Array.isArray(transports) ? transports : [transports];
    this._handle = this._lp.lp_provider_create(moduleName, JSON.stringify(set));
    if (!this._handle) throw new Error(`lp_provider_create failed for '${moduleName}'`);
    this._cbs = [];        // keep koffi callback handles referenced
    this._registered = false;
  }

  /**
   * Register the module's implementation and publish it on the transports.
   * @param {Object} spec
   * @param {Object<string,Function>} spec.handlers  method name → sync handler
   *        (args...) => JSON-serialisable result. Throwing or returning
   *        undefined signals a method failure to the caller.
   * @param {string[]} [spec.events]   event names this module can emit
   * @param {Array}    [spec.methods]  explicit interface array (overrides the
   *        auto-derived one); entries are { name, type: 'method'|'event' }
   * @param {Function} [spec.onToken]  (fromModule, token) => void
   */
  register(spec = {}) {
    if (this._registered) throw new Error('Provider already registered');
    const lp = this._lp;
    const handlers = spec.handlers || {};
    const events = spec.events || [];
    const iface = spec.methods || [
      ...Object.keys(handlers).map((name) => ({ name, type: 'method' })),
      ...events.map((name) => ({ name, type: 'event' })),
    ];

    const dispatchCb = lp.koffi.register((method, argsJson) => {
      const fn = handlers[method];
      if (typeof fn !== 'function') return 0n; // unknown method → failure
      let args = [];
      try { args = JSON.parse(argsJson || '[]'); } catch { args = []; }
      try {
        const r = fn(...(Array.isArray(args) ? args : [args]));
        if (r && typeof r.then === 'function') {
          console.error(`[logos] method '${method}' returned a Promise; async ` +
            `handlers are not yet supported — return a value synchronously.`);
          return 0n;
        }
        return lp.retString(JSON.stringify(r === undefined ? null : r));
      } catch (e) {
        console.error(`[logos] handler '${method}' threw:`, e && e.message);
        return 0n;
      }
    }, lp.koffi.pointer(lp.DispatchCb));

    const getMethodsCb = lp.koffi.register(
      () => lp.retString(JSON.stringify(iface)),
      lp.koffi.pointer(lp.GetMethodsCb));

    const tokenCb = lp.koffi.register((mod, tok) => {
      if (spec.onToken) { try { spec.onToken(mod, tok); } catch { /* ignore */ } }
      return ffi.LP_OK;
    }, lp.koffi.pointer(lp.TokenCb));

    this._cbs.push(dispatchCb, getMethodsCb, tokenCb);
    const rc = lp.lp_provider_register(this._handle, dispatchCb, getMethodsCb, tokenCb, null);
    if (rc !== 0) throw new Error(`lp_provider_register failed (rc=${rc})`);

    // A groundwork-only lp_provider_register returns LP_OK and serves NOTHING,
    // so without this probe the first symptom is a consumer on the other side
    // of the wire burning its full 30s timeout on "Connection refused".
    //
    // The discriminator is a save_token with an EMPTY module name:
    //   - a serving build validates its arguments first  → LP_ERR_INVALID_ARG,
    //     and touches no state (so this probe has no side effect);
    //   - a groundwork build ignores its arguments entirely and returns
    //     LP_ERR_UNSUPPORTED unconditionally.
    // Only the exact LP_ERR_UNSUPPORTED is treated as "cannot serve", so a
    // build that grows a different error here degrades to today's behaviour
    // rather than to a false alarm.
    if (lp.lp_provider_save_token(this._handle, '', '') === LP_ERR_UNSUPPORTED) {
      this._registered = true;   // so destroy() still tears the callbacks down
      throw new Error(`Provider '${this.name}': ${NO_PROVIDER_SERVING}`);
    }

    this._registered = true;
    return this;
  }

  /** Emit an event to subscribers. Extra args become the event payload array. */
  emit(eventName, ...data) {
    const rc = this._lp.lp_provider_emit_event(this._handle, eventName, JSON.stringify(data));
    if (rc === LP_ERR_UNSUPPORTED) throw new Error(`Provider '${this.name}'.emit: ${NO_PROVIDER_SERVING}`);
    return rc === ffi.LP_OK;
  }

  /** Authorise a caller: accept `token` as a valid auth token from `fromModule`. */
  saveToken(fromModule, token) {
    const rc = this._lp.lp_provider_save_token(this._handle, fromModule, token);
    if (rc === LP_ERR_UNSUPPORTED) throw new Error(`Provider '${this.name}'.saveToken: ${NO_PROVIDER_SERVING}`);
    return rc === ffi.LP_OK;
  }

  /** Stop serving and release the provider (quiesces the I/O thread first). */
  destroy() {
    if (this._handle) { this._lp.lp_provider_destroy(this._handle); this._handle = null; }
    for (const cb of this._cbs) { try { this._lp.koffi.unregister(cb); } catch { /* ignore */ } }
    this._cbs = [];
  }
}

module.exports = { Provider };
