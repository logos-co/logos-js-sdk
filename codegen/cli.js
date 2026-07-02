#!/usr/bin/env node
'use strict';
// logos-lidl-gen-js — generate a typed JS client (default) or provider scaffold
// (--provider) from a `.lidl` module contract.
//
//   logos-lidl-gen-js calc.lidl -o calc_client.js
//   logos-lidl-gen-js calc.lidl --provider -o calc_provider.js
const fs = require('fs');
const { parseFile } = require('./lidl.js');
const { generateClient, generateProvider } = require('./jsgen.js');

function usage(code) {
  const w = code ? console.error : console.log;
  w('usage: logos-lidl-gen-js <module.lidl> [--provider] [--sdk-import <name>] [-o <out.js>]');
  w('  --provider        emit a provider scaffold instead of a consumer client');
  w('  --sdk-import <n>   module specifier for `require(...)` in the output (default: logos-js-sdk)');
  w('  -o, --out <file>   write to a file (default: stdout)');
  process.exit(code);
}

function main(argv) {
  const args = argv.slice(2);
  let input = null, provider = false, out = null, sdkImport = 'logos-js-sdk';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--provider') provider = true;
    else if (a === '-o' || a === '--out') out = args[++i];
    else if (a === '--sdk-import') sdkImport = args[++i];
    else if (a === '-h' || a === '--help') usage(0);
    else if (!input) input = a;
    else usage(2);
  }
  if (!input) usage(2);

  const mod = parseFile(input);
  const code = provider ? generateProvider(mod, { sdkImport }) : generateClient(mod, { sdkImport });
  if (out) { fs.writeFileSync(out, code); console.error(`wrote ${out} (${provider ? 'provider' : 'client'} for ${mod.name})`); }
  else process.stdout.write(code);
}

main(process.argv);
