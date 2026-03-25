# Package definition for logos-js-sdk
{ pkgs, common, src, logosLiblogos, logosModuleClient, logosCapabilityModule }:

pkgs.stdenv.mkDerivation rec {
  inherit (common) pname version nativeBuildInputs meta;

  inherit src;

  # Skip npm install for now - we'll handle dependencies differently
  dontBuild = true;

  installPhase = ''
    # Create the output directory
    mkdir -p $out

    # Copy the JavaScript SDK files
    cp -r index.js README.md package.json package-lock.json $out/
    cp -r scripts $out/
    if [ -d "example" ]; then
      cp -r example $out/
    fi

    # Copy node_modules if they exist (from local development)
    if [ -d "node_modules" ]; then
      cp -r node_modules $out/
      echo "Copied existing node_modules"
    else
      echo "No node_modules found - dependencies will need to be installed separately"
    fi

    # Create lib directory and copy shared libraries
    mkdir -p $out/lib

    # Copy liblogos_core from logos-liblogos
    if [ -d "${logosLiblogos}/lib" ]; then
      cp -r "${logosLiblogos}/lib"/* $out/lib/
      echo "Copied libraries from ${logosLiblogos}/lib"
    fi

    # Copy liblogos_module_client from logos-module-client
    if [ -d "${logosModuleClient}/lib" ]; then
      cp -r "${logosModuleClient}/lib"/* $out/lib/
      echo "Copied libraries from ${logosModuleClient}/lib"
    fi

    # Copy headers if available
    if [ -d "${logosLiblogos}/include" ]; then
      mkdir -p $out/include
      cp -r "${logosLiblogos}/include"/* $out/include/
      echo "Copied headers from ${logosLiblogos}/include"
    fi

    # Create modules directory and copy module plugins
    mkdir -p $out/modules

    # Determine platform-specific plugin extension
    OS_EXT="so"
    case "$(uname -s)" in
      Darwin) OS_EXT="dylib";;
      Linux) OS_EXT="so";;
      MINGW*|MSYS*|CYGWIN*) OS_EXT="dll";;
    esac

    # Copy capability module plugin
    if [ -f "${logosCapabilityModule}/lib/capability_module_plugin.$OS_EXT" ]; then
      cp -L "${logosCapabilityModule}/lib/capability_module_plugin.$OS_EXT" "$out/modules/"
      echo "Copied capability_module_plugin.$OS_EXT to $out/modules/"
    fi

    # Create a wrapper script for easy usage
    mkdir -p $out/bin
    cat > $out/bin/logos-js-sdk << 'EOF'
#!/usr/bin/env bash
# Wrapper script for Logos JS SDK
export NODE_PATH="$NODE_PATH:$(dirname "$0")/../node_modules"
exec node "$(dirname "$0")/../index.js" "$@"
EOF
    chmod +x $out/bin/logos-js-sdk
  '';
}
