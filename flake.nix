{
    description = "Mapper (dim-recording-viewer), a dimOS Desktop app: `nix build .#dimosApp` → bin/dimos-app-server (Deno backend + built React frontend + the Rust map builder)";
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    inputs.rust-overlay = {
        url = "github:oxalica/rust-overlay";
        inputs.nixpkgs.follows = "nixpkgs";
    };
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };
    outputs = { self, nixpkgs, rust-overlay }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
            # the map builder for <arch> Linux, from any machine: a static musl binary linked by zig, so no Linux builder or cross gcc
            crossMapper = pkgs: arch:
                let
                    target = "${arch}-unknown-linux-musl";
                    # 1.86 = nixpkgs' rustc; newer rustc passes aarch64 a linker flag zig rejects (--fix-cortex-a53-843419)
                    toolchain = (import nixpkgs { inherit (pkgs) system; overlays = [ (import rust-overlay) ]; })
                        .rust-bin.stable."1.86.0".minimal.override { targets = [ target ]; };
                in
                (pkgs.makeRustPlatform { cargo = toolchain; rustc = toolchain; }).buildRustPackage {
                    pname = "mapper-${arch}-linux";
                    version = "0.1.0";
                    src = ./mapper;
                    cargoLock = {
                        lockFile = ./mapper/Cargo.lock;
                        outputHashes."lcm-msgs-0.1.0" = "sha256-4DWFTf7Xqnx6pd2jXA/MVpRmZiFr6HqTSp9Qo9ZjToA=";
                    };
                    nativeBuildInputs = [ pkgs.cargo-zigbuild pkgs.zig ];
                    # cargo-auditable's -Wl,--undefined is another flag zig's linker rejects
                    auditable = false;
                    buildPhase = ''
                        export HOME=$TMPDIR ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig
                        cargo zigbuild --release --offline --target ${target}
                    '';
                    doCheck = false;
                    installPhase = "install -Dm755 target/${target}/release/mapper $out/bin/mapper";
                };
            # dimosApp for <arch> Linux: its shell and deno are the target's (cache.nixos.org downloads); the rest is JS
            linuxApp = pkgs: frontend: backend: arch:
                let linux = nixpkgs.legacyPackages."${arch}-linux"; in
                pkgs.writeTextFile {
                    name = "dimos-app-server-${arch}-linux";
                    destination = "/bin/dimos-app-server";
                    executable = true;
                    text = "#!${linux.runtimeShell}\nexec ${linux.deno}/bin/deno run -A --no-lock --config ${backend}/deno.json ${backend}/backend/main.ts --frontend ${frontend} --mapper ${crossMapper pkgs arch}/bin/mapper \"$@\"\n";
                };
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
                dimosApp-aarch64-linux = linuxApp pkgs frontend backend "aarch64";
                dimosApp-x86_64-linux = linuxApp pkgs frontend backend "x86_64";
            });
        };
}
