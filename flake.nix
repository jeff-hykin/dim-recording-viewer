{
    description = "Mapper (dim-recording-viewer), a dimOS Desktop app: `nix build .#dimosApp` → bin/dimos-app-server (Deno backend + built React frontend + the Rust map builder)";
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };
    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
        in {
            packages = forAll (pkgs: rec {
                # the map builder: reads a recording's scans, writes the voxel map back into it
                mapper = pkgs.rustPlatform.buildRustPackage {
                    pname = "mapper";
                    version = "0.1.0";
                    src = ./mapper;
                    cargoLock = {
                        lockFile = ./mapper/Cargo.lock;
                        outputHashes."lcm-msgs-0.1.0" = "sha256-4DWFTf7Xqnx6pd2jXA/MVpRmZiFr6HqTSp9Qo9ZjToA=";
                    };
                    doCheck = false;
                    meta.mainProgram = "mapper";
                };
                frontend = pkgs.buildNpmPackage {
                    pname = "mapper-frontend";
                    version = "0.1.0";
                    src = ./frontend;
                    # `nix build .#frontend` prints the right hash when package-lock.json changes
                    npmDepsHash = "sha256-/3Km8zdts2DK16I/8uGpYWF0R29YMHgGyTc4K54Wscc=";
                    installPhase = "cp -r dist $out";
                };
                # the backend's decoders (@dimos/msgs, mcap, ros2 CDR, lz4) as a node_modules the backend runs against
                backendModules = pkgs.buildNpmPackage {
                    pname = "mapper-backend-modules";
                    version = "0.1.0";
                    src = pkgs.lib.fileset.toSource {
                        root = ./.;
                        fileset = pkgs.lib.fileset.unions [ ./package.json ./package-lock.json ./.npmrc ];
                    };
                    npmDepsHash = "sha256-Yo4vF4KsA4EZIZFgWb0KbRE57fYQEYL/xhNDJjRCxGo=";
                    dontNpmBuild = true;
                    installPhase = "mkdir -p $out && cp -r node_modules package.json $out/";
                };
                backend = pkgs.runCommand "mapper-backend" { } ''
                    mkdir -p $out
                    cp -r ${./backend} $out/backend
                    cp ${./deno.json} $out/deno.json
                    ln -s ${backendModules}/node_modules $out/node_modules
                    cp ${backendModules}/package.json $out/package.json
                '';
                dimosApp = pkgs.writeShellScriptBin "dimos-app-server" ''
                    exec ${pkgs.deno}/bin/deno run -A --no-lock --config ${backend}/deno.json ${backend}/backend/main.ts \
                        --frontend ${frontend} --mapper ${pkgs.lib.getExe mapper} "$@"
                '';
                default = dimosApp;
            });
        };
}
