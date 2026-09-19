{
  description = "mapper — lidar map aggregation engine for dim-recording-viewer";

  inputs = {
    nixpkgs.url      = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
    flake-utils.url  = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };
        lib = pkgs.lib;

        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          targets = [
            "x86_64-unknown-linux-musl"
            "aarch64-unknown-linux-musl"
          ];
        };

        rustPlatform = pkgs.makeRustPlatform {
          cargo = rustToolchain;
          rustc = rustToolchain;
        };

        commonArgs = {
          pname   = "mapper";
          version = "0.1.0";
          src     = ./.;
          cargoLock = {
            lockFile = ./Cargo.lock;
            outputHashes = {
              "lcm-msgs-0.1.0" = "sha256-4DWFTf7Xqnx6pd2jXA/MVpRmZiFr6HqTSp9Qo9ZjToA=";
            };
          };
          doCheck = false;
          meta.mainProgram = "mapper";
        };

        # ── native build for the current system (what `nix run` uses) ────────
        nativeBuild = rustPlatform.buildRustPackage (commonArgs // {
          nativeBuildInputs = [ pkgs.pkg-config ];
          # rustPlatform links nix's libiconv on darwin, leaving a /nix/store
          # dylib reference that doesn't resolve on a mac without nix. Point it
          # at the system copy (present on every macOS) so the prebuilt binaries
          # in bin/ run anywhere. preFixup, so strip + codesign happen after.
          preFixup = lib.optionalString pkgs.stdenv.isDarwin ''
            bin=$out/bin/mapper
            for dep in $(otool -L "$bin" | awk '/\/nix\/store\/.*libiconv/ {print $1}'); do
              install_name_tool -change "$dep" /usr/lib/libiconv.2.dylib "$bin"
            done
            # (first otool line is the binary's own store path — skip it)
            if otool -L "$bin" | tail -n +2 | grep -q /nix/store; then
              echo "mapper still references the nix store:"; otool -L "$bin"; exit 1
            fi
          '';
        });

        # ── portable static musl cross builds (Linux targets) ───────────────
        # Everything is Rust plus rusqlite's bundled sqlite (C, built by the
        # cross cc), so the result runs on any Linux with no runtime deps.
        crossPkgs = target: import nixpkgs {
          inherit system overlays;
          crossSystem.config = target;
        };

        buildMuslCross = target:
          let
            cross       = crossPkgs target;
            targetSnake = builtins.replaceStrings ["-"] ["_"] target;
            targetUpper = lib.toUpper targetSnake;
            ccBinDir    = "${cross.stdenv.cc}/bin";
            ccPrefix    = cross.stdenv.cc.targetPrefix;
          in
          rustPlatform.buildRustPackage (commonArgs // {
            pname = "mapper-${target}";

            buildPhase = ''
              runHook preBuild
              cargo build --release --target ${target}
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out/bin
              install -m755 target/${target}/release/mapper $out/bin/mapper
              runHook postInstall
            '';

            # Env vars go in `env` so they don't collide with the cross
            # stdenv's own env attrs (modern nixpkgs forbids overlap).
            env = {
              "CARGO_TARGET_${targetUpper}_LINKER" = "${ccBinDir}/${ccPrefix}cc";
              "CC_${targetSnake}"  = "${ccBinDir}/${ccPrefix}cc";
              "AR_${targetSnake}"  = "${ccBinDir}/${ccPrefix}ar";
            };
          });

      in {
        packages = {
          default     = nativeBuild;
          native      = nativeBuild;
          linux-x86   = buildMuslCross "x86_64-unknown-linux-musl";
          linux-arm64 = buildMuslCross "aarch64-unknown-linux-musl";
        } // lib.optionalAttrs (system == "aarch64-darwin") {
          # Intel-mac build from an Apple-silicon mac. Nix runs the x86_64-darwin
          # derivation under Rosetta, which needs `extra-platforms = x86_64-darwin`
          # in nix.conf (and Rosetta installed). It's the same nativeBuild, just
          # evaluated for the other darwin system.
          darwin-x86 = self.packages.x86_64-darwin.native;
        };

        apps.default = {
          type = "app";
          program = "${nativeBuild}/bin/mapper";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [ rustToolchain pkgs.pkg-config ];
        };
      }
    );
}
