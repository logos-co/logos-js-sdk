# Builds the calc_module test fixture as a Qt plugin
{ pkgs, logosSdk, logosModule, logosModuleBuilderSrc }:

pkgs.stdenv.mkDerivation {
  pname = "calc-module-test-fixture";
  version = "1.0.0";

  src = ../test/fixtures/calc-module;

  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
    pkgs.pkg-config
    pkgs.qt6.wrapQtAppsNoGuiHook
  ];

  buildInputs = [
    pkgs.qt6.qtbase
    pkgs.qt6.qtremoteobjects
  ];

  cmakeFlags = [
    "-GNinja"
    "-DLOGOS_CPP_SDK_ROOT=${logosSdk}"
    "-DLOGOS_MODULE_ROOT=${logosModule}"
  ];

  env = {
    LOGOS_MODULE_BUILDER_ROOT = "${logosModuleBuilderSrc}";
    LOGOS_CPP_SDK_ROOT = "${logosSdk}";
    LOGOS_MODULE_ROOT = "${logosModule}";
  };

  installPhase = ''
    mkdir -p $out/lib
    find . -name '*.so' -exec cp {} $out/lib/ \;
    find . -name '*.dylib' -exec cp {} $out/lib/ \;
  '';
}
