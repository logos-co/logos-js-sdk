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
