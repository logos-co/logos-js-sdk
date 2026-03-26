#!/usr/bin/env node

/**
 * Logos JS SDK - Calculator Module Example
 *
 * Demonstrates loading the calc_module and calling its methods
 * using the reflective plugin proxy API.
 *
 * Prerequisites:
 *   1. Build logos-liblogos and logos-module-client:
 *        ws build logos-liblogos logos-module-client --auto-local
 *
 *   2. Build the calc module:
 *        cd repos/logos-tutorial/logos-calc-module && nix build
 *
 *   3. Install JS dependencies:
 *        cd repos/logos-js-sdk && npm install
 *
 * Usage:
 *   node example/calc-example.js --lib <path-to-liblogos_core.so> --modules <path-to-modules-dir>
 *
 *   Or with environment variables:
 *   LOGOS_LIB_PATH=<path> LOGOS_MODULES_DIR=<path> node example/calc-example.js
 */

const path = require('path');
const assert = require('assert');
const LogosAPI = require('../index');

// Parse command-line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lib' && args[i + 1]) {
      opts.libPath = args[++i];
    } else if (args[i] === '--modules' && args[i + 1]) {
      opts.modulesDir = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node calc-example.js [--lib <path>] [--modules <dir>]');
      console.log('');
      console.log('Options:');
      console.log('  --lib <path>      Path to liblogos_core shared library');
      console.log('  --modules <dir>   Directory containing module plugins');
      console.log('');
      console.log('Environment variables:');
      console.log('  LOGOS_LIB_PATH      Same as --lib');
      console.log('  LOGOS_MODULES_DIR   Same as --modules');
      process.exit(0);
    }
  }

  return opts;
}

async function main() {
  const args = parseArgs();

  const libPath = args.libPath || process.env.LOGOS_LIB_PATH || null;
  const moduleClientLibPath = process.env.LOGOS_MODULE_CLIENT_LIB_PATH || null;
  const modulesDir = args.modulesDir || process.env.LOGOS_MODULES_DIR || null;

  console.log('=== Logos JS SDK - Calculator Module Example ===\n');

  // Initialize the SDK (autoInit: false so we can control the flow)
  const logos = new LogosAPI({
    libPath,
    moduleClientLibPath,
    pluginsDir: modulesDir,
    autoInit: false
  });

  try {
    // Step 1: Initialize
    console.log('Initializing LogosAPI...');
    logos.init();
    console.log('LogosAPI initialized.\n');

    // Step 2: Start the system
    console.log('Starting LogosCore...');
    logos.start();
    console.log('LogosCore started.\n');

    // Step 3: Start event processing (needed for async callbacks)
    logos.startEventProcessing(50);

    // Step 4: Process and load the calc module
    console.log('Loading calc_module...');
    logos.processAndLoadPlugin('calc_module');
    console.log('calc_module loaded.\n');

    // Step 5: Show plugin status
    const status = logos.getPluginStatus();
    console.log('Plugin status:');
    console.log('  Loaded:', status.loaded);
    console.log('  Known:', status.known);
    console.log('');

    // Step 6: Wait for the Qt Remote Objects connection to establish
    // The module runs in a logos_host process; the SDK needs time to connect.
    console.log('Waiting for module connection...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 7: Call methods using the reflective proxy API
    // logos.calc_module.methodName(args) returns a Promise
    console.log('--- Calling calc_module methods ---\n');

    const addResult = await logos.calc_module.add(5, 3);
    console.log(`calc_module.add(5, 3) = ${addResult}`);
    assert.strictEqual(Number(addResult), 8, 'add(5,3) should be 8');

    const mulResult = await logos.calc_module.multiply(7, 6);
    console.log(`calc_module.multiply(7, 6) = ${mulResult}`);
    assert.strictEqual(Number(mulResult), 42, 'multiply(7,6) should be 42');

    const factResult = await logos.calc_module.factorial(10);
    console.log(`calc_module.factorial(10) = ${factResult}`);
    assert.strictEqual(Number(factResult), 3628800, 'factorial(10) should be 3628800');

    const fibResult = await logos.calc_module.fibonacci(12);
    console.log(`calc_module.fibonacci(12) = ${fibResult}`);
    assert.strictEqual(Number(fibResult), 144, 'fibonacci(12) should be 144');

    const versionResult = await logos.calc_module.libVersion();
    console.log(`calc_module.libVersion() = ${versionResult}`);
    assert.ok(typeof versionResult === 'string' && versionResult.length > 0, 'libVersion() should return non-empty string');

    console.log('\n=== All assertions passed! ===');

  } catch (error) {
    console.error('Error:', error);
    process.exitCode = 1;
  } finally {
    // Cleanup
    console.log('\nCleaning up...');
    logos.cleanup();
    console.log('Done.');
    // Force exit — Qt event loop threads keep the process alive after cleanup
    process.exit(process.exitCode || 0);
  }
}

main();
