{
  description = "Lidar map aggregation engine for the recording viewer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        mapper = pkgs.rustPlatform.buildRustPackage {
          pname = "mapper";
          version = "0.1.0";
          src = ./.;
          cargoLock = {
            lockFile = ./Cargo.lock;
            outputHashes = {
              "lcm-msgs-0.1.0" = "sha256-4DWFTf7Xqnx6pd2jXA/MVpRmZiFr6HqTSp9Qo9ZjToA=";
            };
          };
          nativeBuildInputs = [ pkgs.pkg-config ];
        };
      in
      {
        packages.default = mapper;
        apps.default = {
          type = "app";
          program = "${mapper}/bin/mapper";
        };
      });
}
