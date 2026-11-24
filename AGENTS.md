# Repository scope

Keep contract implementation, technical build/API documentation and release inputs in this repository. Planning, research, reviews, acceptance reports, recordings and generated evidence belong to the canonical `allowit-hq/allowit-project` knowledge repository: original supplied inputs under `.agents/1-sources/`, human knowledge in `wiki/`, and generated task outputs in `.agents/artifacts/`. Preserve original source bodies and file hashes before removing historical outputs here. Do not commit task artifacts or reports in this repository. Use explicit output paths in the main project for retained generated evidence.

# Build and pins

`rust-toolchain.toml` pins the Rust release. Pins point one way: this repository may depend on allowit-core, and allowit-sdk depends on the rail crate here. Never add a git dependency on allowit-sdk or a `[patch]` section.
