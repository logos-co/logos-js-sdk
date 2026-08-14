{
  description = "logos-js-sdk — protocol-native, Qt-free JavaScript SDK (lp_* consumer + provider over koffi)";

  inputs = {
    logos-nix.url = "github:logos-co/logos-nix";
    nixpkgs.follows = "logos-nix/nixpkgs";

    # The shared liblogos_protocol exposes the lp_* C ABI the SDK binds via
    # koffi.
    #
    # The shared library itself is MERGED (logos-protocol#4): master's
    # cpp/CMakeLists.txt builds a `logos_protocol_shared` target unconditionally
    # and installs it as $out/lib/liblogos_protocol.{so,dylib} inside the
    # ordinary `logos-protocol` / `logos-protocol-lib` package — so the CONSUMER
    # half of this SDK (lp_client_*) runs on master today, and `protocolShared`
    # below falls back to that attribute automatically.
    #
    # What is NOT merged is a FUNCTIONAL lp_provider_*. On master
    # lp_provider_register() stores the callbacks and serves nothing, and
    # lp_provider_emit_event / lp_provider_save_token return LP_ERR_UNSUPPORTED
    # (-2) — see the note above lp_provider_create in logos_protocol.h. Serving
    # a provider through the C ABI lands in logos-protocol#12
    # (feat/qtfree-plain-provider), whose stack tips at #16
    # (feat/protocol-shared-lib) — the branch pinned here.
    #
    # So: keep this branch pin until #12–#16 merge, then flip the url to master.
    # Nothing else in this flake has to change when you do.
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

      # The shared liblogos_protocol lives in a different attribute depending on
      # which logos-protocol this is pinned to:
      #   - the #12–#16 stack exposes a dedicated `logos-protocol-shared`
      #     package (the shared target is behind an option there);
      #   - master builds the shared target unconditionally (#4, merged) and
      #     installs it into the ordinary `logos-protocol` package.
      # Resolving with `or` means re-pinning the input to master is a ONE-LINE
      # change: no other edit in this file is needed.
      protocolSharedFor = system:
        let p = logos-protocol.packages.${system};
        in p.logos-protocol-shared or p.logos-protocol;
    in
    {
      checks = forAllSystems ({ system, pkgs }:
        let
          protocolShared = protocolSharedFor system;
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
            # koffi's prebuilt .node needs libstdc++ resolvable at load time on
            # Linux (nix has no default lib path); harmless on Darwin.
            buildInputs = [ pkgs.stdenv.cc.cc.lib ];
            checkPhase = ''
              runHook preCheck
              export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
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
          protocolShared = protocolSharedFor system;
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
