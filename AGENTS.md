# Repository build rule

Before building or rebuilding servo-mcp, fetch the servo-wasm submodule's
`origin/main` and update the gitlink to that revision. The checkout provides
the shared RPC types and request schema. The deployed servo-wasm Worker is the
browser backend and must support the RPC contract used by the MCP server.

# Forked Git dependencies

All dependencies hosted in our GitHub forks must follow the fork's rolling
default branch (`main` or `master`) using `branch = "main"` or
`branch = "master"` in `Cargo.toml`. Do not pin fork dependencies with `rev`, a
commit SHA, or a tag. Keep this policy in effect across manifests, lockfile
updates, CI changes, and dependency refreshes. Cargo.lock may record the
resolved commit for reproducibility, but the manifest must continue to track
the branch HEAD.
