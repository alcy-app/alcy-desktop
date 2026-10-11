# Alcy

Alcy is a local-first desktop client for building, running and inspecting GraphQL and REST API requests, with a simple, fast and fully local experience.

## Stack

- Tauri 2;
- stable Rust;
- React;
- strict TypeScript;
- Vite;
- pnpm.

## Structure

```text
apps/desktop/   # React + TypeScript interface
src-tauri/      # Tauri adapter and composition root
crates/         # domain, use cases and capabilities in Rust
```

## Development

```bash
pnpm install
pnpm dev
```

The full validation (lint, type checking, tests and Rust workspace checks) runs with:

```bash
pnpm check
```

## More information

- [Architecture](ARCHITECTURE.md)
- [Agent instructions](AGENTS.md)
