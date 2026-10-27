# Repository build rule

Before every build or rebuild of `servo-mcp`, fetch the `servo-wasm` submodule's
`origin/main` and update the submodule checkout to that latest `main` commit.
Build against that revision; do not build from the previously pinned submodule
revision. The parent repository's `servo-wasm` gitlink should reflect the
revision used for the build.

# Forked Git dependencies

All dependencies hosted in our GitHub forks must follow the fork's rolling
default branch (`main` or `master`) using `branch = "main"` or
`branch = "master"` in `Cargo.toml`. Do not pin fork dependencies with `rev`, a
commit SHA, or a tag. Keep this policy in effect across manifests, lockfile
updates, CI changes, and dependency refreshes. Cargo.lock may record the
resolved commit for reproducibility, but the manifest must continue to track
the branch HEAD.
