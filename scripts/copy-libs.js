#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function copyFileSync(src, dest) {
  try {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
    return true;
  } catch (error) {
    console.warn(`Failed to copy ${src} to ${dest}:`, error.message);
    return false;
  }
}

function getLibraryExtension() {
  switch (process.platform) {
    case 'darwin':
      return '.dylib';
    case 'win32':
      return '.dll';
    default:
      return '.so';
  }
}

function getPlatformDir() {
  return `${process.platform}-${process.arch}`;
}

function findSourceDir(envVar, sdkDir) {
  const candidates = [
    path.resolve(sdkDir, 'result'),
    process.env[envVar],
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'lib')) || fs.existsSync(path.join(dir, 'bin'))) {
      return dir;
    }
  }
  return null;
}

function main() {
  const sdkDir = path.resolve(__dirname, '..');
  const coreDir = findSourceDir('LOGOS_LIBLOGOS_ROOT', sdkDir);
  const protocolDir = findSourceDir('LOGOS_PROTOCOL_ROOT', sdkDir);
  const platformDir = getPlatformDir();

  if (!coreDir) {
    console.error('No build output found for liblogos_core. Searched:');
    console.error('  - result/           (run: nix build)');
    console.error('  - LOGOS_LIBLOGOS_ROOT env var');
    process.exit(1);
  }

  console.log(`Copying binaries for ${platformDir}...`);

  const libExtension = getLibraryExtension();
  let copied = 0;

  // Copy liblogos_core into lib/{platform}/
  const libSrc = path.join(coreDir, 'lib', `liblogos_core${libExtension}`);
  const libDest = path.join(sdkDir, 'lib', platformDir, `liblogos_core${libExtension}`);
  if (fs.existsSync(libSrc)) {
    if (copyFileSync(libSrc, libDest)) {
      console.log(`  lib/${platformDir}/liblogos_core${libExtension}`);
      copied++;
    }
  } else {
    console.warn(`  Library not found at ${libSrc}`);
  }

  // Copy liblogos_protocol into lib/{platform}/ (exports the lp_* C ABI)
  const protocolSrcDir = protocolDir || coreDir;
  const protocolSrc = path.join(protocolSrcDir, 'lib', `liblogos_protocol${libExtension}`);
  const protocolDest = path.join(sdkDir, 'lib', platformDir, `liblogos_protocol${libExtension}`);
  if (fs.existsSync(protocolSrc)) {
    if (copyFileSync(protocolSrc, protocolDest)) {
      console.log(`  lib/${platformDir}/liblogos_protocol${libExtension}`);
      copied++;
    }
  } else {
    console.warn(`  liblogos_protocol not found at ${protocolSrc} (optional)`);
  }

  // Copy logos_host into bin/{platform}/
  const hostName = process.platform === 'win32' ? 'logos_host.exe' : 'logos_host';
  const hostSrc = path.join(coreDir, 'bin', hostName);
  const hostDest = path.join(sdkDir, 'bin', platformDir, hostName);
  if (fs.existsSync(hostSrc)) {
    if (copyFileSync(hostSrc, hostDest)) {
      try { fs.chmodSync(hostDest, 0o755); } catch (_) {}
      console.log(`  bin/${platformDir}/${hostName}`);
      copied++;
    }
  } else {
    console.warn(`  logos_host not found at ${hostSrc}`);
  }

  console.log(`Copied ${copied} files. Run on each platform for multi-platform SDK.`);
}

if (require.main === module) {
  main();
}

module.exports = { copyFileSync, getLibraryExtension, getPlatformDir };
