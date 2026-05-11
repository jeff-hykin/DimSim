{
  description = "DimSim — browser-based 3D simulator (Three.js + Rapier3D) with a Deno CLI for headless eval";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            deno
            nodejs_22
            git
          ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
            # Playwright-bundled Chromium; only available on Linux in nixpkgs
            playwright-driver.browsers
          ];

          shellHook = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
            export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
          '';
        };
      });
}
