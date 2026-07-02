{
  description = "logos-js-sdk — protocol-native, Qt-free JavaScript SDK (lp_* consumer + provider over koffi)";

  inputs = {
    logos-nix.url = "github:logos-co/logos-nix";
    nixpkgs.follows = "logos-nix/nixpkgs";

    # The shared liblogos_protocol exposes the lp_* C ABI the SDK binds via
    # koffi. NOTE: pinned to the branch that adds the shared-lib target +
    # Qt-free provider/consumer path — re-pin to master once those merge.
    logos-protocol.url = "github:logos-co/logos-protocol/feat/protocol-shared-lib";
    logos-protocol.inputs.logos-nix.follows = "logos-nix";

    # The shared liblogos_lidl_c exposes lidl_parse_to_json for the codegen.
    # Pinned to the branch that adds the shared-lib target — re-pin after merge.
    logos-lidl.url = "github:logos-co/logos-lidl/feat/shared-c-abi-lib";
    logos-lidl.inputs.logos-nix.follows = "logos-nix";
  };

  outputs = { self, nixpkgs, logos-nix, logos-protocol, logos-lidl }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        inherit system;
        pkgs = import nixpkgs { inherit system; };
      });
      ext = system: if nixpkgs.lib.hasSuffix "darwin" system then "dylib" else "so";
    in
    {
      checks = forAllSystems ({ system, pkgs }:
        let
          protocolShared = logos-protocol.packages.${system}.logos-protocol-shared;
          lidlShared = logos-lidl.packages.${system}.logos-lidl;
          e = ext system;
        in
        {
          # Hermetic e2e: a Node provider (child process) and consumer exchange
          # calls + events over plain TCP, plus a .lidl→JS codegen round-trip —
          # no liblogos_core, no Qt loop. koffi's prebuilt binary ships in the
          # npm package, so no native build is needed inside the sandbox.
          e2e = pkgs.buildNpmPackage {
            pname = "logos-js-sdk-e2e";
            version = "2.0.0";
            src = ./.;
            npmDepsHash = "sha256-CDPBw5lbbuSOkXN7qbkhKcCHTiQ5kN/pdI+JMHPwTgc=";
            dontNpmBuild = true;
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              export LOGOS_PROTOCOL_LIB=${protocolShared}/lib/liblogos_protocol.${e}
              export LOGOS_LIDL_LIB=${lidlShared}/lib/liblogos_lidl_c.${e}
              node test/e2e.js
              runHook postCheck
            '';
            installPhase = "mkdir -p $out; touch $out/e2e-passed";
          };
        }
      );

      devShells = forAllSystems ({ system, pkgs }:
        let
          protocolShared = logos-protocol.packages.${system}.logos-protocol-shared;
          lidlShared = logos-lidl.packages.${system}.logos-lidl;
          e = ext system;
        in
        {
          default = pkgs.mkShell {
            nativeBuildInputs = [ pkgs.nodejs ];
            shellHook = ''
              export LOGOS_PROTOCOL_LIB="${protocolShared}/lib/liblogos_protocol.${e}"
              export LOGOS_LIDL_LIB="${lidlShared}/lib/liblogos_lidl_c.${e}"
              echo "logos-js-sdk dev shell — node $(node --version)"
              echo "  LOGOS_PROTOCOL_LIB=$LOGOS_PROTOCOL_LIB"
              echo "  LOGOS_LIDL_LIB=$LOGOS_LIDL_LIB"
              echo "  run: npm ci && npm test"
            '';
          };
        }
      );
    };
}
