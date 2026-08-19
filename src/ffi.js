'use strict';
// -----------------------------------------------------------------------------
// FFI layer — koffi bindings to the logos-protocol lp_* C ABI.
//
// This is a PURE protocol-native binding: it loads a shared liblogos_protocol
// and speaks the language-neutral lp_* C ABI directly. There is NO liblogos_core
// and NO embedded Qt host — a Node process is an out-of-process consumer
// (lp_client_*) and/or provider (lp_provider_*) over a PLAIN transport (tcp,
// tcp_ssl, or a plain-local Unix socket), with no Qt event loop.
//
// Callback threading note: the library dispatches on its own Asio I/O thread and
// koffi marshals callbacks to the Node main thread. Callbacks with void/scalar
// returns and string inputs are safe across that boundary; a callback that must
// return a heap `char*` (the provider dispatch) CANNOT return a pointer/string
// directly — see retString().
// -----------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const koffi = require('koffi');

// ── locate the shared liblogos_protocol ─────────────────────────────────────
function platformDir() {
  const arch = process.arch === 'arm64' ? 'arm64' : (process.arch === 'x64' ? 'x64' : process.arch);
  const plat = process.platform === 'darwin' ? 'darwin' : 'linux';
  return `${plat}-${arch}`;
}
function libFileName() {
  return process.platform === 'darwin' ? 'liblogos_protocol.dylib' : 'liblogos_protocol.so';
}
function resolveProtocolLib(explicit) {
  const name = libFileName();
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.LOGOS_PROTOCOL_LIB) candidates.push(process.env.LOGOS_PROTOCOL_LIB);
  if (process.env.LOGOS_PROTOCOL_ROOT) candidates.push(path.join(process.env.LOGOS_PROTOCOL_ROOT, 'lib', name));
  candidates.push(path.join(__dirname, '..', 'lib', platformDir(), name));
  candidates.push(path.join(__dirname, '..', 'lib', name));
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  throw new Error(
    `liblogos_protocol not found. Set LOGOS_PROTOCOL_LIB to the shared library ` +
    `(build it with: nix build github:logos-co/logos-protocol#logos-protocol-shared). ` +
    `Looked in: ${candidates.join(', ')}`);
}

let _lp = null;      // the bound library API (singleton)

function load(explicitLibPath) {
  if (_lp) return _lp;
  const libPath = resolveProtocolLib(explicitLibPath);
  const lp = koffi.load(libPath);

  // libc/libSystem strdup, bound to VOID* so koffi does NOT auto-decode the
  // returned char* into a JS string (we need the raw pointer's address).
  const libc = koffi.load(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6');
  const strdupPtr = libc.func('void* strdup(const char*)');

  _lp = {
    koffi,
    libPath,

    // A provider callback (dispatch / getMethods) cannot return a heap char*
    // across the I/O-thread → main-thread marshaling koffi performs — returning
    // a pointer/string there crashes. So we malloc a copy of the result and
    // return its ADDRESS as a uint64_t scalar (scalars marshal safely); the C
    // ABI reads that return register as the char*, and the library frees it via
    // free(). Return 0n for "no result / failure".
    retString: (s) => (s == null ? 0n : BigInt(koffi.address(strdupPtr(String(s))))),

    // ── version / memory / mode ──
    lp_protocol_version: lp.func('const char* lp_protocol_version()'),
    lp_protocol_abi_major: lp.func('int lp_protocol_abi_major()'),
    lp_string_free: lp.func('void lp_string_free(void*)'),
    lp_set_mode: lp.func('int lp_set_mode(const char*)'),
    lp_get_mode: lp.func('const char* lp_get_mode()'),
    lp_set_default_transport: lp.func('int lp_set_default_transport(const char*)'),

    // ── consumer ──
    lp_client_create: lp.func('void* lp_client_create(const char*, const char*, const char*, const char*)'),
    lp_client_destroy: lp.func('void lp_client_destroy(void*)'),
    lp_invoke: lp.func('int lp_invoke(void*, const char*, const char*, int, _Out_ void**, _Out_ void**)'),
    lp_invoke_async: lp.func('int lp_invoke_async(void*, const char*, const char*, int, void*, void*)'),
    lp_subscribe: lp.func('void* lp_subscribe(void*, const char*, void*, void*)'),
    lp_unsubscribe: lp.func('void lp_unsubscribe(void*)'),
    lp_get_methods: lp.func('void* lp_get_methods(void*)'),
    lp_token_get: lp.func('void* lp_token_get(const char*)'),
    lp_token_save: lp.func('int lp_token_save(const char*, const char*)'),
    lp_inform_module_token: lp.func('int lp_inform_module_token(void*, const char*, const char*, const char*)'),

    // ── provider ──
    lp_provider_create: lp.func('void* lp_provider_create(const char*, const char*)'),
    lp_provider_destroy: lp.func('void lp_provider_destroy(void*)'),
    lp_provider_register: lp.func('int lp_provider_register(void*, void*, void*, void*, void*)'),
    lp_provider_emit_event: lp.func('int lp_provider_emit_event(void*, const char*, const char*)'),
    lp_provider_save_token: lp.func('int lp_provider_save_token(void*, const char*, const char*)'),

    // ── callback prototypes ──
    // dispatch / getMethods return uint64_t (a malloc'd string's address — see
    // retString). token returns int. result/event callbacks return void. All
    // are cross-thread safe (scalar/void returns; string inputs).
    DispatchCb:   koffi.proto('uint64_t lp_dispatch_cb(const char* method, const char* args_json, void* udata)'),
    GetMethodsCb: koffi.proto('uint64_t lp_getmethods_cb(void* udata)'),
    TokenCb:      koffi.proto('int lp_token_cb(const char* module_name, const char* token, void* udata)'),
    ResultCb:     koffi.proto('void lp_result_cb(int ok, const char* json, void* udata)'),
    EventCb:      koffi.proto('void lp_event_cb(const char* event_name, const char* data_json, void* udata)'),
  };
  return _lp;
}

// Read a `char*` returned by the library (as a void* pointer) into a JS string
// and free it via lp_string_free. Returns null for a NULL pointer.
function takeString(lp, voidPtr) {
  if (!voidPtr || koffi.address(voidPtr) === 0n) return null;
  const s = koffi.decode(voidPtr, 'char', -1); // NUL-terminated C string → JS string
  lp.lp_string_free(voidPtr);
  return s;
}

module.exports = { load, takeString, koffi, LP_OK: 0 };
