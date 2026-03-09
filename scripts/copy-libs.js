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

function findSourceDir(sdkDir) {
  const candidates = [
    path.resolve(sdkDir, 'result'),
    process.env.LOGOS_LIBLOGOS_ROOT,
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
  const coreDir = findSourceDir(sdkDir);
  const platformDir = getPlatformDir();

  if (!coreDir) {
    console.error('No build output found. Searched:');
    console.error('  - result/           (run: nix build)');
    console.error('  - LOGOS_LIBLOGOS_ROOT env var');
    process.exit(1);
  }

  console.log(`Copying liblogos binaries for ${platformDir}...`);
  console.log(`  Source: ${coreDir}`);

  const libExtension = getLibraryExtension();
  let libCopied = false;
  let hostCopied = false;

  // Copy liblogos_core into lib/{platform}/
  const libSrc = path.join(coreDir, 'lib', `liblogos_core${libExtension}`);
  const libDest = path.join(sdkDir, 'lib', platformDir, `liblogos_core${libExtension}`);

  if (fs.existsSync(libSrc)) {
    if (copyFileSync(libSrc, libDest)) {
      console.log(`  lib/${platformDir}/liblogos_core${libExtension}`);
      libCopied = true;
    }
  } else {
    console.warn(`  Library not found at ${libSrc}`);
  }

  // Copy logos_host into bin/{platform}/
  const hostName = process.platform === 'win32' ? 'logos_host.exe' : 'logos_host';
  const hostSrc = path.join(coreDir, 'bin', hostName);
  const hostDest = path.join(sdkDir, 'bin', platformDir, hostName);

  if (fs.existsSync(hostSrc)) {
    if (copyFileSync(hostSrc, hostDest)) {
      try { fs.chmodSync(hostDest, 0o755); } catch (_) {}
      console.log(`  bin/${platformDir}/${hostName}`);
      hostCopied = true;
    }
  } else {
    console.warn(`  logos_host not found at ${hostSrc}`);
  }

  if (libCopied && hostCopied) {
    console.log(`Done. Run on each platform to build a multi-platform SDK.`);
  } else {
    console.log('Partial copy. Run nix build first.');
  }
}

if (require.main === module) {
  main();
}

module.exports = { copyFileSync, getLibraryExtension, getPlatformDir };
