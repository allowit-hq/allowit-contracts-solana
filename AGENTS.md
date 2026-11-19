# Repository scope

Keep contract implementation, technical build/API documentation and release inputs in this repository. Planning, research, reviews, acceptance reports, recordings and generated evidence belong to the canonical `allowit-hq/allowit-project` knowledge repository: original supplied inputs under `.agents/1-sources/`, human knowledge in `wiki/`, and generated task outputs in `.agents/artifacts/`. Preserve original source bodies and file hashes before removing historical outputs here. Do not commit task artifacts or reports in this repository. Use explicit output paths in the main project for retained generated evidence.

# Verification

For changes under `verification/`, including documentation, run `python3 -m unittest discover -s verification/tests`. Before changing a verification file, check whether observations, locks or receipts bind its hash, including references from other verification folders. Preserve hash-bound inputs. Never re-hash a lock, receipt or correspondence file to make a check pass.

# Build and pins

All packages share one version and depend on each other by path. The root Cargo workspace and its `Cargo.lock` hold every package. The SBF test harness `sbf-tests/` keeps its own lock, so its pins cannot change the programs' dependencies. Allowit core (package `allowit-sdk`, repository allowit-core) is the only git dependency. Pins point one way: this repository depends on allowit-core, and allowit-sdk depends on the host crates here. Never add a git dependency on allowit-sdk or a `[patch]` section. Allowit core is declared in the root `[workspace.dependencies]`. `[workspace.metadata.allowit.track]` says which revision it must be pinned to. Run `scripts/build.sh` before pushing: it fails on a stale pin or on a second copy of a git package in a lock, builds the root workspace, and builds the SBF programs with `cargo build-sbf` (Agave tooling). `scripts/build.sh --update [repo...]` moves stale pins, or only those of the named repositories, and refreshes the locks.
