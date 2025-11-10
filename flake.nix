{
  description = "Logos JavaScript SDK with compiled logos-liblogos";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    logos-liblogos.url = "github:logos-co/logos-liblogos";
  };

  outputs = { self, nixpkgs, logos-liblogos }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        pkgs = import nixpkgs { inherit system; };
        logosLiblogos = logos-liblogos.packages.${system}.default;
      });
    in
    {
      packages = forAllSystems ({ pkgs, logosLiblogos }: 
        let
          # Common configuration
          common = import ./nix/default.nix { 
            inherit pkgs logosLiblogos; 
          };
          src = ./.;
          
          # Package definition
          package = import ./nix/package.nix { 
            inherit pkgs common src logosLiblogos; 
          };
        in
        {
          # Default package
          default = package;
        }
      );

      devShells = forAllSystems ({ pkgs }: {
        default = pkgs.mkShell {
          nativeBuildInputs = [
            pkgs.nodejs
          ];
          
          shellHook = ''
            echo "🔧 Logos JS SDK Development Environment"
            echo "📦 Node.js version: $(node --version)"
            echo "📦 npm version: $(npm --version)"
            echo ""
            echo "Available commands:"
            echo "  npm run copy-libs  - Copy built libraries to SDK"
            echo "  npm test          - Run tests"
          '';
        };
      });
    };
}
