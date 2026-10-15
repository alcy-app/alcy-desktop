# Alcy architecture

## Overview

Alcy is a modular desktop monolith. React and Rust are separated by an explicit IPC boundary, but every module is compiled and shipped as a single application.

There will be no dynamic plugin loading in the MVP.

## Stack

- Desktop shell: Tauri 2.
- Frontend: React, strict TypeScript and Vite.
- Native core: stable Rust.
- JavaScript package management: pnpm.
- Initial persistence: versioned local files.
- Future auxiliary persistence: SQLite, only when history and indexing justify it.

Windows is the primary platform for validation, distribution and benchmarking. Development also happens on Ubuntu.

## Layers

```text
React UI
    ↓
Frontend features
    ↓
Typed IPC bindings
    ↓
Tauri commands
    ↓
Application use cases
    ↓
Domain
    ↑
GraphQL, storage and platform adapters
```

### Frontend

Responsible for:

- layout and navigation;
- editor and panels;
- visual state and forms not yet persisted;
- loading, empty and error states;
- accessibility and shortcuts.

The frontend does not access the file system, database, shell or network directly.

### IPC bindings

Responsible for:

- wrapping `invoke`, events and channels;
- exposing typed contracts to the frontend;
- keeping visual components from depending on Tauri directly;
- keeping payloads small and predictable.

### Tauri adapter

Responsible for:

- registering commands and capabilities;
- validating input DTOs;
- calling use cases;
- converting results and errors into output DTOs;
- composing the application's implementations.

Commands contain no business rules.

### Application

Responsible for use cases and orchestration, for example:

- running and cancelling a request;
- loading or refreshing a schema;
- resolving variables;
- saving environments;
- opening local resources.

### Domain

Holds types and rules independent of interface and infrastructure:

- request and response;
- endpoint;
- environment and variable;
- execution status;
- identifiers and domain errors.

The domain does not depend on Tauri, concrete HTTP, storage or frontend types.

### GraphQL

Responsible for:

- GraphQL documents and operations;
- parsing and validation;
- schema and introspection;
- interpreting GraphQL errors;
- protocol-specific execution.

The generic core knows the protocol identifier, but does not take in GraphQL-specific fields.

### REST

Responsible for:

- running arbitrary HTTP requests (method, raw body, headers and authentication);
- mapping network/timeout errors to the domain types.

It does not depend on `alcy-graphql` nor the other way around — protocol capabilities sit side by side. The generic core knows the protocol identifier, but does not take in REST-specific fields.

### Mock server

The mock server receives HTTP configurations persisted per workspace and only listens on loopback while the desktop app is open. Route and rule evaluation, the listener and the temporary log live in Rust; React only edits and controls the servers through the bindings layer. There is no access from the local network and no persisted call data (ADR 0052).

Flows control mock servers through the `MockServerControl` port in `alcy-app`, implemented on top of the runtime in `src-tauri/src/mock_runtime/` (ADR 0056). Each running server keeps in memory, with a limit, the calls received per route for the "Wait for call" and "Verify calls" blocks; at the end, the run stops the mocks it started.

### OpenAPI

Responsible for:

- interpreting an OpenAPI 3.0/3.1 document (JSON or YAML) and converting it into collections of REST requests (`Collection`/`Folder`/`SavedRequest`).
- extracting the operations' documentation (parameters, body, responses and schemas) as `ApiDocsSource` (ADR 0035).

It does not run requests, does not depend on `alcy-graphql`/`alcy-rest` and is not depended on by `alcy-storage` — the same side-by-side separation as the other protocol capabilities (ADR 0006).

### Load

`alcy-load` holds the typed plan, scheduler, concurrent runtime, VU state,
metrics and thresholds, without depending on `alcy-app`, Tauri, graphs or
workspace storage. Transport and cancellation are ports supplied by the
consumer; a Rust program can run the same core without starting the desktop
app.

`alcy-app` compiles the `Load` graph into that plan and adapts its existing
ports. The domain provides generic HTTP types and preserves the graph and the
execution kind, but does not import the runner. Temporary numeric samples
belong to the run, not to canonical storage (ADRs 0043 and 0047).

The plan also holds structured instruction bodies and optional setup/teardown
phases. The compiler delimits bodies in the graph; the runner executes trees
without knowing their edges. Setup initializes variables copied to each VU,
and teardown waits for the scenarios to finish. Datasets are immutable data
already resolved by the consumer, with a cursor isolated per dataset/VU; the
core does not open workspace assets (ADR 0055).

The runner checks scenarios, simultaneous VU peaks, open rate, steps and
configured duration against the consumer's budgets before starting any
effect. Numeric samples share a budget per run; percentiles stay exact, with
a bounded external fan-in merge. Exceeding a budget is an error, never a
silent reduction of the load or of the sampling (ADR 0049).

`LoadTransport` also accepts optional DNS, connection, TLS, send, wait and
receive telemetry. The runner measures the total duration and only emits a
phase metric when the transport declared it; unavailable values do not become
zero. The timeout configured in the plan is applied by the runner, which drops
the transport's future when it expires (ADR 0050).

The desktop app only receives aggregated snapshots through the channel. When
the run ends, it writes a bounded report — metrics, thresholds and up to 500
compact samples without response bodies — into the v2 flow history; the
interface fetches the samples in pages of up to 100. The index tells `standard`
and `load` runs apart, still reads the v1 index and applies the same retention
configured for the general history (ADR 0054).

### External collection import

Responsible for:

- detecting supported external collection formats from their content;
- converting hierarchy, HTTP/GraphQL requests, headers, body and authentication into `Collection`/`Folder`/`SavedRequest`;
- extracting request and parameter descriptions as imported documentation (ADR 0035);
- keeping the details of those formats out of the domain, storage and Tauri commands.

It does not run requests or persist the result. The import command only
orchestrates the attempt across OpenAPI, external collections and the native
format (ADR 0012).

### Storage and platform

Responsible for:

- local files and atomic writes;
- versioned formats and migrations;
- disposable cache;
- operating system directories and integrations.

Canonical data and rebuildable data must stay separate.

### gRPC

`alcy-grpc` calls any method of any service without generated code (spec
0129, ADR 0062): message types come from server reflection or from local
`.proto` files compiled in-process, messages are JSON at the edges and
protobuf on the wire. One streaming engine serves the four call kinds and
reports events (sent, headers, received, finished with status and
trailers). It has its own transport (tonic over hyper/h2 with rustls), since
the shared HTTP client has no HTTP/2: certificates are always verified,
against the system roots plus the configured custom CAs, and HTTP proxies
are reached through a `CONNECT` tunnel. Like the other protocol crates, it
is dispatched to only from the composition root.

### Scripting

`alcy-scripting` runs pre-request and post-response scripts in `boa_engine`
with no I/O (ADR 0018), on its own thread with a large native stack.
`require` loads libraries bundled in the crate, or npm packages that the host
downloads before the script runs: `alcy-script-packages` scans the script for
literal `require('npm:…')` calls, fetches the packages from esm.sh and caches
them in the app data folder, and the interpreter receives their modules as
plain sources (ADR 0061). This is the only network access scripts can cause.

## Initial structure

```text
apps/desktop/          # React + TypeScript
src-tauri/             # Tauri adapter and composition root
crates/alcy-domain/    # core types and rules
crates/alcy-app/       # use cases and ports
crates/alcy-collection-import/ # import of external collection formats
crates/alcy-gitlab/    # GitLab client (OAuth PKCE and API v4)
crates/alcy-load/      # reusable load plan, scheduler, runtime and metrics
crates/alcy-graphql/   # GraphQL capability
crates/alcy-grpc/      # gRPC capability (reflection, .proto, streaming)
crates/alcy-openapi/   # import of OpenAPI documents
crates/alcy-rest/      # REST capability
crates/alcy-scripting/ # script interpreter (boa) and `require`
crates/alcy-script-packages/ # npm packages for scripts (esm.sh + cache)
crates/alcy-storage/   # local persistence
crates/alcy-platform/  # native integrations
```

Crates are only created when they have a real responsibility and boundary. The scaffold can start smaller and be split as the code grows.

## IPC boundary

Use commands for actions and queries with a clear start and end.

Use events for small lifecycle notifications.

Use channels for progress, streaming or long operations.

Not allowed:

- IPC per keystroke;
- repeatedly sending large responses;
- returning the whole workspace after small changes;
- exposing the crates' internal types directly;
- granting the frontend generic native access.

## State

Rust is the canonical source for persisted data, executions, schema and native resources.

React keeps presentation state and edits not yet saved.

Global state should only exist when there are independent consumers and a clearly defined lifecycle.

## Performance

- heavy parsing stays in Rust;
- potentially large lists must be virtualized;
- schemas and full contents are loaded on demand;
- caches have a limit and an invalidation policy;
- long operations accept cancellation;
- large responses are not duplicated without need;
- official benchmarks run on the reference Windows machine.

## Security

- capabilities follow least privilege;
- the frontend gets no unrestricted access to the system;
- secrets and sensitive headers do not show up in logs;
- error messages for the interface do not reveal unnecessary internal details.

## Evolution

The MVP does not implement plugins. Preparing for extensibility is limited to well-separated modules, small contracts, versioned models and a centralized composition root.

An SDK will only be extracted once multiple real cases validate the internal contracts.

## Extensions

A downstream build adds features without editing shared files:

- Rust: pass `alcy_desktop_lib::Extension` values to `run_with` in `src-tauri/src/main.rs`. Each one declares app commands of its own (handled before the app's) and a setup that runs after the app's.
- Frontend: add a folder with an `index.ts` under `apps/desktop/src/extensions/` that default-exports an `AppExtension` (`extensions/types.ts`). It can wrap the app, add sidebar modules and add workbench tabs, and translates its own text.
  Its Tauri calls go in its own `bindings/` folder, and its test doubles in its own `test-setup.ts`, loaded by `src/test-setup.ts`.
- Build: extra Tauri configs merged with `tauri build --config` go in `src-tauri/config/`, which is protected like `tauri.conf.json`.

This repository ships the loader and no extension.

## Related decisions

Technology-specific decisions or boundary changes are recorded alongside the code that implements them.
