{
    description = "dim-recording-viewer (Mapper): plays back dimos recordings in 3D, as a dimOS Desktop app";

    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    inputs.dim-app.url = "github:jeff-hykin/dim-app/v0.5.0";

    outputs = { self, nixpkgs, dim-app }: {
        # the Rust mapper runs from the binaries shipped in mapper/bin, one per platform
        packages = dim-app.lib.forAllSystems nixpkgs (pkgs: {
            dimosApp = dim-app.lib.mkDimosApp {
                inherit pkgs;
                name = "dim-recording-viewer";
                src = self;
                frontend = "dim/apps/recording_viewer/frontend";
                backend = "dim/apps/recording_viewer/main.js";
            };
        });
    };
}
