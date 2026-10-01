{
    description = "dim-recording-viewer (Mapper): plays back dimos recordings in 3D, as a dimOS Desktop app";

    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
            # the shipped mapper binary main.js picks for each system (mapper-<Deno.build.os>-<Deno.build.arch>)
            shippedName = {
                aarch64-darwin = "mapper-darwin-aarch64";
                x86_64-darwin = "mapper-darwin-x86_64";
                x86_64-linux = "mapper-linux-x86_64";
                aarch64-linux = "mapper-linux-aarch64";
            };
        in {
            apps = forAllSystems (system: pkgs: {
                install = {
                    type = "app";
                    program = toString (pkgs.writeShellScript "install" ''
                        set -e
                        app=dim/apps/recording_viewer
                        mapper=$app/mapper
                        # fetch the backend's remote imports (dim-app, @dimos/msgs, lz4) now so the first start is fast
                        ${pkgs.deno}/bin/deno cache --no-lock "$app/main.js"
                        # the Rust mapper (lidar map aggregation): the shipped binary for this system, else build it now
                        shipped="$mapper/bin/${shippedName.${system}}"
                        # it has no --help; run with no args, a binary that loads answers "--db is required"
                        if [ -x "$shipped" ] && "$shipped" 2>&1 | grep -q -- "--db is required"; then
                            echo "dim-recording-viewer: using shipped mapper $shipped"
                        else
                            echo "dim-recording-viewer: no runnable shipped mapper for ${system}, building it with nix"
                            nix --extra-experimental-features "nix-command flakes" build -L "path:$PWD/$mapper" -o "$mapper/result"
                        fi
                    '');
                };
            });
        };
}
