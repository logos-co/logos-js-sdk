'use strict';
// koffi binding to the logos-lidl C ABI — parses `.lidl` text into the JSON AST
// (the canonical cross-language form) via the shared liblogos_lidl_c, so codegen
// reuses the one true grammar instead of reimplementing it in JS.
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');

function resolveLidlLib(explicit) {
  const name = process.platform === 'darwin' ? 'liblogos_lidl_c.dylib' : 'liblogos_lidl_c.so';
  const candidates = [
    explicit,
    process.env.LOGOS_LIDL_LIB,
    process.env.LOGOS_LIDL_ROOT && path.join(process.env.LOGOS_LIDL_ROOT, 'lib', name),
    path.join(__dirname, '..', 'lib', name),
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  throw new Error(
    `liblogos_lidl_c not found. Set LOGOS_LIDL_LIB (build: nix build ` +
    `github:logos-co/logos-lidl#logos-lidl → lib/${name}). Looked in: ${candidates.join(', ')}`);
}

let _lib = null;
function lib(explicit) {
  if (_lib) return _lib;
  const l = koffi.load(resolveLidlLib(explicit));
  _lib = {
    parse: l.func('void* lidl_parse_to_json(const char*, _Out_ void**)'),
    serialize: l.func('void* lidl_serialize_from_json(const char*, _Out_ void**)'),
    freeStr: l.func('void lidl_free_string(void*)'),
  };
  return _lib;
}

function take(l, ptr) {
  if (!ptr || koffi.address(ptr) === 0n) return null;
  const s = koffi.decode(ptr, 'char', -1);
  l.freeStr(ptr);
  return s;
}

/** Parse `.lidl` source text → the module AST (a plain JS object). Throws on error. */
function parse(lidlText, libPath) {
  const l = lib(libPath);
  const err = [null];
  const out = l.parse(lidlText, err);
  const errStr = take(l, err[0]);
  const jsonStr = take(l, out);
  if (!jsonStr) throw new Error('lidl parse failed: ' + (errStr || 'unknown error'));
  return JSON.parse(jsonStr);
}

/** Parse a `.lidl` file → AST. */
function parseFile(file, libPath) {
  return parse(fs.readFileSync(file, 'utf8'), libPath);
}

module.exports = { parse, parseFile };
