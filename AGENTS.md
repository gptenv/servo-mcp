# Repository build rule

Before every build or rebuild of `servo-mcp`, fetch the `servo-wasm` submodule's
`origin/main` and update the submodule checkout to that latest `main` commit.
Build against that revision; do not build from the previously pinned submodule
revision. The parent repository's `servo-wasm` gitlink should reflect the
revision used for the build.
