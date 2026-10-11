# Rust Agent Guide

- The domain does not depend on Tauri or concrete infrastructure.
- Commands stay out of the domain and application crates.
- Prefer explicit types and small abstractions.
- Do not create a trait without a real boundary or variation.
- Do not use `unwrap` or `expect` in user-triggered flows.
- I/O and long operations must support cancellation where applicable.
- Errors must be structured and preserved up to the presentation boundary.
- Do not use `unsafe` without a justification recorded in `ARCHITECTURE.md` and dedicated tests.
- Add fixtures or benchmarks for performance-sensitive changes.
