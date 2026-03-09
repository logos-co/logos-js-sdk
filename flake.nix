{
  description = "Logos JavaScript SDK with compiled logos-liblogos";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    logos-liblogos.url = "github:logos-co/logos-liblogos";
    logos-capability-module.url = "github:logos-co/logos-capability-module";
  };

  outputs = { self, nixpkgs, logos-liblogos, logos-capability-module }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        pkgs = import nixpkgs { inherit system; };
        logosLiblogos = logos-liblogos.packages.${system}.default;
        logosCapabilityModule = logos-capability-module.packages.${system}.default;
      });
    in
    {
      packages = forAllSystems ({ pkgs, logosLiblogos, logosCapabilityModule }: 
        let
          # Common configuration
          common = import ./nix/default.nix { 
            inherit pkgs logosLiblogos logosCapabilityModule; 
          };
          src = ./.;
          
          # Package definition
          package = import ./nix/package.nix { 
            inherit pkgs common src logosLiblogos logosCapabilityModule; 
          };
        in
        {
          # Default package
          default = package;
        }
      );

      # nix run .#copy-libs — copies liblogos_core + logos_host into sdk lib/{platform}/ and bin/{platform}/
      apps = forAllSystems ({ pkgs, logosLiblogos, logosCapabilityModule }:
        let
          # Map nix system to Node.js platform-arch convention
          platformDir = {
            "aarch64-darwin" = "darwin-arm64";
            "x86_64-darwin"  = "darwin-x64";
            "aarch64-linux"  = "linux-arm64";
            "x86_64-linux"   = "linux-x64";
          }.${pkgs.system};
        in {
        copy-libs = {
          type = "app";
          program = "${pkgs.writeShellScript "copy-libs" ''
            set -e
            SDK_DIR="$(pwd)"
            PLATFORM="${platformDir}"

            # Determine platform library extension
            EXT="so"
            case "$(uname -s)" in
              Darwin) EXT="dylib";;
            esac

            echo "Copying liblogos binaries for $PLATFORM..."
            echo "  Source: ${logosLiblogos}"

            # Copy liblogos_core into lib/{platform}/
            mkdir -p "$SDK_DIR/lib/$PLATFORM"
            cp -L "${logosLiblogos}/lib/liblogos_core.$EXT" "$SDK_DIR/lib/$PLATFORM/"
            echo "  lib/$PLATFORM/liblogos_core.$EXT"

            # Copy logos_host into bin/{platform}/
            mkdir -p "$SDK_DIR/bin/$PLATFORM"
            cp -L "${logosLiblogos}/bin/logos_host" "$SDK_DIR/bin/$PLATFORM/"
            chmod +x "$SDK_DIR/bin/$PLATFORM/logos_host"
            echo "  bin/$PLATFORM/logos_host"

            echo "Done. Run on each platform to build a multi-platform SDK."
          ''}";
        };
      });

      devShells = forAllSystems ({ pkgs, logosLiblogos, logosCapabilityModule }: {
        default = pkgs.mkShell {
          nativeBuildInputs = [
            pkgs.nodejs
          ];
          
          shellHook = ''
            export LOGOS_LIBLOGOS_ROOT="${logosLiblogos}"
            export LOGOS_CAPABILITY_MODULE_ROOT="${logosCapabilityModule}"
            
            echo "🔧 Logos JS SDK Development Environment"
            echo "📦 Node.js version: $(node --version)"
            echo "📦 npm version: $(npm --version)"
            echo ""
            echo "LOGOS_LIBLOGOS_ROOT: $LOGOS_LIBLOGOS_ROOT"
            echo "LOGOS_CAPABILITY_MODULE_ROOT: $LOGOS_CAPABILITY_MODULE_ROOT"
            echo ""
            echo "Available commands:"
            echo "  npm run copy-libs  - Copy built libraries to SDK"
            echo "  npm test          - Run tests"
          '';
        };
      });
    };
}
