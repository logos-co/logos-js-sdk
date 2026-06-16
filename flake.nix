{
  description = "Logos JavaScript SDK with compiled logos-liblogos";

  inputs = {
    logos-nix.url = "github:logos-co/logos-nix";
    nixpkgs.follows = "logos-nix/nixpkgs";
    logos-cpp-sdk.url = "github:logos-co/logos-cpp-sdk";
    logos-liblogos.url = "github:logos-co/logos-liblogos";
    # liblogos_protocol.{so,dylib} exports the lp_* C ABI the SDK binds via koffi.
    logos-protocol.url = "github:logos-co/logos-protocol";
    logos-capability-module.url = "github:logos-co/logos-capability-module";

    # Test-only: needed to build the calc_module test fixture
    logos-module.url = "github:logos-co/logos-module";
    logos-module-builder.url = "github:logos-co/logos-module-builder";
  };

  outputs = { self, nixpkgs, logos-nix, logos-cpp-sdk, logos-liblogos, logos-protocol, logos-capability-module, logos-module, logos-module-builder }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        inherit system;
        pkgs = import nixpkgs { inherit system; };
        logosSdk = logos-cpp-sdk.packages.${system}.default;
        logosLiblogos = logos-liblogos.packages.${system}.default;
        logosProtocol = logos-protocol.packages.${system}.default;
        logosModule = logos-module.packages.${system}.default;
        logosCapabilityModule = logos-capability-module.packages.${system}.default;
      });
    in
    {
      packages = forAllSystems ({ pkgs, logosLiblogos, logosProtocol, logosCapabilityModule, logosSdk, logosModule, ... }:
        let
          common = import ./nix/default.nix {
            inherit pkgs logosLiblogos logosProtocol logosCapabilityModule;
          };
          src = ./.;
          package = import ./nix/package.nix {
            inherit pkgs common src logosLiblogos logosProtocol logosCapabilityModule;
          };
        in
        {
          default = package;

          # Test fixture: calc_module plugin for integration tests
          calc-module-fixture = import ./nix/test-calc-module.nix {
            inherit pkgs logosSdk logosModule;
            logosModuleBuilderSrc = logos-module-builder;
          };
        }
      );

      # `nix run .#copy-libs` — copies native binaries into lib/{platform}/ and bin/{platform}/
      apps = forAllSystems ({ pkgs, logosLiblogos, logosProtocol, ... }: {
        copy-libs = {
          type = "app";
          program = let
            script = pkgs.writeShellScript "copy-libs" ''
              export LOGOS_LIBLOGOS_ROOT="${logosLiblogos}"
              export LOGOS_PROTOCOL_ROOT="${logosProtocol}"
              exec ${pkgs.nodejs}/bin/node "''${1:-$(pwd)}/scripts/copy-libs.js"
            '';
          in "${script}";
        };
      });

      devShells = forAllSystems ({ pkgs, logosLiblogos, logosProtocol, logosCapabilityModule, ... }: {
        default = pkgs.mkShell {
          nativeBuildInputs = [
            pkgs.nodejs
          ];

          shellHook = ''
            export LOGOS_LIBLOGOS_ROOT="${logosLiblogos}"
            export LOGOS_PROTOCOL_ROOT="${logosProtocol}"
            export LOGOS_CAPABILITY_MODULE_ROOT="${logosCapabilityModule}"

            echo "Logos JS SDK Development Environment"
            echo "Node.js version: $(node --version)"
            echo "npm version: $(npm --version)"
            echo ""
            echo "LOGOS_LIBLOGOS_ROOT: $LOGOS_LIBLOGOS_ROOT"
            echo "LOGOS_PROTOCOL_ROOT: $LOGOS_PROTOCOL_ROOT"
            echo "LOGOS_CAPABILITY_MODULE_ROOT: $LOGOS_CAPABILITY_MODULE_ROOT"
          '';
        };
      });
    };
}
