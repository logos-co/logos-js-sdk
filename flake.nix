{
  description = "Logos JavaScript SDK with compiled logos-liblogos";

  inputs = {
    logos-nix.url = "github:logos-co/logos-nix";
    nixpkgs.follows = "logos-nix/nixpkgs";
    logos-cpp-sdk.url = "github:logos-co/logos-cpp-sdk";
    logos-liblogos.url = "github:logos-co/logos-liblogos";
    logos-module-client.url = "github:logos-co/logos-module-client";
    logos-capability-module.url = "github:logos-co/logos-capability-module";
  };

  outputs = { self, nixpkgs, logos-nix, logos-cpp-sdk, logos-liblogos, logos-module-client, logos-capability-module }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        inherit system;
        pkgs = import nixpkgs { inherit system; };
        logosLiblogos = logos-liblogos.packages.${system}.default;
        logosModuleClient = logos-module-client.packages.${system}.default;
        logosCapabilityModule = logos-capability-module.packages.${system}.default;
      });
    in
    {
      packages = forAllSystems ({ pkgs, logosLiblogos, logosModuleClient, logosCapabilityModule, ... }:
        let
          common = import ./nix/default.nix {
            inherit pkgs logosLiblogos logosModuleClient logosCapabilityModule;
          };
          src = ./.;
          package = import ./nix/package.nix {
            inherit pkgs common src logosLiblogos logosModuleClient logosCapabilityModule;
          };
        in
        {
          default = package;
        }
      );

      # `nix run .#copy-libs` — copies native binaries into lib/{platform}/ and bin/{platform}/
      apps = forAllSystems ({ pkgs, logosLiblogos, logosModuleClient, ... }: {
        copy-libs = {
          type = "app";
          program = let
            script = pkgs.writeShellScript "copy-libs" ''
              export LOGOS_LIBLOGOS_ROOT="${logosLiblogos}"
              export LOGOS_MODULE_CLIENT_ROOT="${logosModuleClient}"
              exec ${pkgs.nodejs}/bin/node "''${1:-$(pwd)}/scripts/copy-libs.js"
            '';
          in "${script}";
        };
      });

      devShells = forAllSystems ({ pkgs, logosLiblogos, logosModuleClient, logosCapabilityModule, ... }: {
        default = pkgs.mkShell {
          nativeBuildInputs = [
            pkgs.nodejs
          ];

          shellHook = ''
            export LOGOS_LIBLOGOS_ROOT="${logosLiblogos}"
            export LOGOS_MODULE_CLIENT_ROOT="${logosModuleClient}"
            export LOGOS_CAPABILITY_MODULE_ROOT="${logosCapabilityModule}"

            echo "Logos JS SDK Development Environment"
            echo "Node.js version: $(node --version)"
            echo "npm version: $(npm --version)"
            echo ""
            echo "LOGOS_LIBLOGOS_ROOT: $LOGOS_LIBLOGOS_ROOT"
            echo "LOGOS_MODULE_CLIENT_ROOT: $LOGOS_MODULE_CLIENT_ROOT"
            echo "LOGOS_CAPABILITY_MODULE_ROOT: $LOGOS_CAPABILITY_MODULE_ROOT"
          '';
        };
      });
    };
}
