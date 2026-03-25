# Common build configuration shared across all packages
{ pkgs, logosLiblogos, logosModuleClient, logosCapabilityModule }:

{
  pname = "logos-js-sdk";
  version = "1.0.0";

  # Common native build inputs
  nativeBuildInputs = [
    pkgs.nodejs
  ];

  # Metadata
  meta = with pkgs.lib; {
    description = "Logos JavaScript SDK with compiled logos-liblogos";
    platforms = platforms.unix;
  };
}
