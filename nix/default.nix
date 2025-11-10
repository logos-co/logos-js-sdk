# Common build configuration shared across all packages
{ pkgs, logosLiblogos }:

{
  pname = "logos-js-sdk";
  version = "1.0.0";
  
  # Common native build inputs
  nativeBuildInputs = [ 
    pkgs.nodejs 
    pkgs.python3
    pkgs.gnumake
    pkgs.gcc
    pkgs.pkg-config
  ];
  
  # Metadata
  meta = with pkgs.lib; {
    description = "Logos JavaScript SDK with compiled logos-liblogos";
    platforms = platforms.unix;
    maintainers = [ ];
  };
}

