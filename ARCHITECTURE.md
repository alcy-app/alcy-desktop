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

### Workbench tab groups

React owns named, colored, collapsible tab groups as visual workspace state. Membership
keeps tabs contiguous without changing the resources, collections or flow execution.
Fixed tabs remain outside groups. Grouping promotes previews to regular tabs, and closing
a group uses the existing unsaved-change confirmation and resource cleanup paths.

The local `alcy-tab-session.json` v1 envelope accepts an optional additive `groups` list
with IDs, names, palette colors, collapsed state and ordered tab IDs. The existing native
session binding and atomic storage persist it; React validates individual groups and
memberships against recoverable request tabs. Existing v1 sessions need no migration.
Session-only views can be grouped while open but retain their existing restoration
lifecycle; only recoverable request memberships survive restart. Older builds ignore
this optional organization metadata and retain the request tabs.

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

### Flow editing and output inspection

Standard flows may declare an optional Start form and asynchronous HumanAction nodes. The shared form definition supports ordered collapsible sections, text, numeric quantities, static choices, booleans and result selectors. `alcy-app` validates definitions and answers and exposes typed values through `nodes.<id>.form.<field>` references restricted to actual ancestors. Initial answers are validated before any effects. The `FlowHumanInteraction` port pauses only the dependent branch. Native execution-scoped queues identify every wait independently, including repeated loop visits, and reject stale or duplicate submissions. Cancellation drops pending queues; execution does not survive application shutdown.

Result selectors prepare immutable native snapshots on blocking workers with cooperative cancellation, a 64 MiB aggregate snapshot limit and at most 100,000 items per source. Only projected pages of up to 100 rows and 64 KiB cross IPC. Submission carries source indices, and validation resolves original values natively. Answers and selected objects remain session-only; history stores waiting/submission events without their values. React keeps sessions outside the mounted canvas, so changing tabs preserves progress, drafts and diagram/panel mode. Closing a flow tab cancels its active run. Native output caches are separated by execution and released after completion when the session closes or starts a replacement run.

The panel view reuses the form renderer and Display inspector. It persists selected node IDs, titles, sizes and free positions independently from graph coordinates. Panels remain visible with live execution state; arrangement supports pointer and keyboard movement/resizing. A pending-action notice provides access even when its form was not selected as a panel. Load flows do not accept interactive forms.

Flow folders belong to workspace organization, separate from executable graphs and run history. The v5 `alcy-flows.json` manifest stores ordered folders, graphs, operator forms and independent panel geometry. A flow belongs to at most one folder; removing a folder leaves its graphs at the root. Rust validates folder identities, memberships and panel geometry on load and save. Versions 1–4 remain readable; versions 1–3 load without folders, and older flows default to empty forms and panels. Older builds reject v5 instead of silently dropping configuration. React owns collapse, search and rename state; changes use the existing typed list/save bindings and atomic storage path.

The canvas uses compact operation summaries; configuration and scripts live in the inspector. All node content uses React Flow's screen-space node toolbar portal and CSS layout zoom, keeping text, controls and async scrolling outside the graph's transform-scaled layer to avoid WebKit rasterization blur. Transparent chassis, connection handles and annotation resizers remain in graph coordinates for native dragging and edge positioning; logical content measurements keep their bounds synchronized. Display nodes have a scrollable viewport and local presentation formats shared with the inspector. Whole-body references read redacted response pages through the existing inspection binding; JSON containers fetch a bounded child page only when expanded, while text retains only the current page. Collapsing branches and changing executions cancel obsolete reads; response bodies are never added to execution events. HTML previews use an opaque sandbox without scripts. Explicit graph organization runs in a cancellable frontend Web Worker, using measured card bounds and fixed annotations. It changes only existing node positions through the normal save pipeline, retains a session-only undo until the next layout or topology change, and never reorganizes a saved graph on load. Execution and validation remain in Rust.

React owns the flow canvas, inspector sizing, data mapping and display-format preferences. Canvas controls use immediate hover and focus states, and their overlay-motion context keeps originating tooltips and menus static across portals. Other application surfaces retain their normal motion. The embedded request editor reuses the workbench components and its request-tab drafts. Explicit saves target either the linked collection request or the inline node; execution waits for pending edits to be saved or discarded. Inspector state and display formats do not change the persisted graph or execution semantics. Load flows expose their declared variables and aggregate results, without pretending to have a shared response across virtual users.

New canvas nodes use readable, unique reference IDs. Explicit renaming updates the existing node ID, edges, mock dependencies and template references in the flow; inline tabs retain their draft and saved snapshots, while affected linked requests become explicit-save drafts. This reuses the existing graph contract without adding an alias namespace or migrating existing IDs. A session-only lookup retains access to the latest run's original output IDs after a rename and resets when a new execution starts. Autocomplete derives its scope from the focused inspector or quick editor and reads bounded output fields on demand, including nested paths, without requiring the data explorer to be open.

`alcy-storage::FlowBodyCapture` captures the last textual output per node on a dedicated worker, with a two-entry nonblocking queue, a 64 MiB per-body limit and a 256 MiB per-run budget. Binary, oversized or unqueued bodies retain the existing bounded preview and an explicit availability state. Captures start in temporary storage; when response saving and history retention are enabled, completion moves them to `alcy-flow-runs/<run-id>.bodies/`. A versioned manifest maps node IDs to hashed filenames and output revisions. Standard history details use v3 and still read v1–2; the load detail format remains v1. Retention removes body directories with their run, and stale temporary captures from interrupted sessions are cleaned in the background.

The `alcy-app` output inspector uses a streaming JSON visitor rather than a response-sized object tree. Native commands schedule parsing and file reads on blocking workers, support cancellation and reject stale revisions and mismatched cursors. Typed bindings request one JSON level, scalar-value window or text window at a time, with at most 100 fields and a 64 KiB serialized IPC response. The history overview can omit output bodies entirely; individual outputs are fetched on demand. JSON pointers belong to inspection only: references inserted into fields retain the existing execution syntax and interpolation behavior, and unrepresentable paths cannot be mapped.

Load dataset mapping queries column pages and examples from the first row through the same cancellable inspection registry. Parsing reuses the existing iteration-data limits in Rust; full datasets never cross IPC. Examples describe configured input data, not a captured virtual user's runtime state.

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

`alcy-collection-import` converts supported static k6/JMeter subsets into that
graph without executing source code or contacting destinations. The k6 AST
delimits exported scenario and lifecycle bodies before static conversion;
unsupported statements reject the entire import. Syntax validation and local
module resolution are separate concerns (ADR 0053). Imported setup/teardown
uses existing runtime isolation: setup cookies and headers are not copied into
VUs. Preview and commit compile the graph before success, and commit rechecks
the source hash before saving assets.

Imported k6 thresholds connect to every execution scenario's `done` output.
These edges describe global completion assertions: the compiler accepts only
thresholds on that output and keeps their evaluation once per run, after all
scenarios and teardown. Existing flows with unconnected thresholds remain
compatible. Import analysis rejects more than 10,000 threshold completion
connections before constructing the graph, bounding scenario/threshold expansion.

The k6 importer resolves bounded declarative constants and request arguments
from the AST, including static JSON serialization, without executing the
script. `__ENV` string references become `K6_ENV_*` flow variables in a leading
setup session block. Its optional `requiredVariables` list defaults to empty
for existing configurations. Import analysis and commit validate structure;
execution preview and the runner require those values before any effects.
Configured destinations are resolved for confirmation without running setup.
The runner resolves each request URL in its VU state and validates HTTP/HTTPS
before applying cookies or invoking transport. Native import commands offload
analysis and persistence to blocking workers.

JMeter import builds a bounded format-specific XML hierarchy from streaming
events (2 MiB source, depth 128 and 50,000 nodes), then interprets each test
element with its following sibling `hashTree`. This keeps logical ownership
separate from XML nesting. Disabled elements skip their entire logical
subtrees only after the complete XML passes syntax, DTD and resource checks;
active unsupported elements reject the import atomically. The initial JMeter
schedule remains finite per-VU iterations without ramp-up or scheduler, using
the existing graph and persistence contracts.

JMeter scalar properties use an explicit compatibility matrix: translated
fields and known neutral values are accepted; unsupported options reject the
whole import with a source position and property name, without echoing values.
Source metadata alone never establishes compatibility. Sampler redirects map
to the existing native policy (absent/false means manual, true means follow).
The shared native transport requires explicit `use_keepalive=true`; connection
reset, per-phase timeouts, embedded resources and automatic redirect handling
remain unsupported. A literal absolute HTTP(S) Path overrides server fields;
otherwise authority and port are validated separately. JMeter literals that
would become native `{{...}}` interpolation reject import. These corrections
apply to new imports; existing saved flows keep their persisted configuration.

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

Application logs and pre-update workspace backups use `logs/` and `backups/`
beside the installed executable. On Linux, AppImages use the outer AppImage
location rather than their temporary mount; on macOS, directories stay beside
the `.app` bundle rather than inside it. Startup checks both directories for
write access and falls back to the existing application data directory if either
is unavailable. Existing files in the former `Documents/Alcy/` location remain
untouched; new writes use the selected location. Workspace locations and other
application settings keep their existing paths.

The release publisher provides signed Windows EXE/MSI installers, raw Linux
AppImages and, for macOS, a universal DMG for first installs plus the signed
`.app.tar.gz` updater archive. The native updater retains TLS and system proxy
support, with its optional archive extraction feature disabled: Windows and
Linux updates are never archives. On macOS the updater always extracts the
`.app.tar.gz` (the plugin's `tar`/`flate2` are unconditional there), only after
its signature is verified. macOS builds are ad-hoc signed (no Developer ID), so
a downloaded DMG must have its quarantine removed once; the app only offers to
install updates when it runs from a writable `.app` bundle.

### Version control providers

Workspace sync compares three SHA-256 hashes per file (last synced base,
local, remote) without a local repository. The use cases in `alcy-app` only
know the `RemoteRepository` and `WorkspaceFiles` ports; `alcy-gitlab` and
`alcy-onedrive` implement the remote side, and the composition root
dispatches between them by the link's provider (ADR 0063).

The link (`alcy-git-link.json`) records the provider's location and the base
hashes. GitLab links keep format v1; OneDrive links use v2, tagged by
provider, which older builds reject. GitLab commits several files atomically.
Graph has no multi-file transaction, so OneDrive writes each file guarded by
its eTag (`If-Match`); a push interrupted midway is reconciled by the next
status, which adopts as base every file whose local and remote contents
already match. Tokens live in the system keyring; OneDrive keeps only the
refresh token there and the access token in memory.

Team workspaces on OneDrive follow a convention, not an Alcy server: each
Teams team's document library holds an `Alcy/` folder with one subfolder per
workspace. Listing goes through the account's joined teams, so visibility is
exactly SharePoint's permission on that library. Opening one creates the
local copy, links it and pulls, or reuses a recent copy linked to the same
folder.

### Workspace documentation

Documents sit behind the `documents` feature flag: off, the module loads nothing
and each agent turn leaves out the document tools and guidance (the turn input
carries `documentsEnabled`). Documents are local workspace resources under
`alcy-documents/<id>/`. React owns
Markdown drafts, preview, source selection and editor tabs. Domain rules bound
content and enforce exact edits; `alcy-app` orchestrates revision checks, source
access and export through repository, source and asset ports. Tauri adapts the
ports and runs native work on blocking workers. `alcy-storage` persists versioned
metadata, immutable Markdown revisions and local PNG assets, and renders PDFs.
An atomic metadata replacement publishes a complete content revision. A changed
revision or an unsaved user draft prevents an agent write from replacing edits.

The agent uses the existing tool catalog and approvals. A new document starts
with the active conversation; other conversations and individual request executions
are selected in the document editor. Source reads include the complete saved
transcript before compaction and a scoped in-memory snapshot of an active turn.
Only selected sources are readable. Read pages are retained as redacted evidence;
if history is removed, cached pages explicitly identify that fallback. Selection
does not copy whole conversations into the workspace. Documents update on request,
without background model calls or automatic request execution.

Text pages are limited to 4 KiB, allowing JSON escaping within the existing 32 KiB
tool-result budget. Source and asset references are paged separately for the model.
The editor assembles bounded pages up to a 1 MiB document limit; saving stages
chunks natively and commits once, preserving concurrent edits. Generated images
reuse the request screenshot renderer without importable collection metadata.
Image uploads and reads are chunked. Native import accepts PNG/JPEG only, checks
allocation and dimensions, and rewrites PNG pixels to discard ancillary metadata.
Credentials and sensitive environment values are masked before source text reaches
the model or retained evidence. Supplied images remain local, with user captions;
this feature does not send images to providers or interpret their contents.

Documents use a Markdown dialect (ADR 0069): a leading `key: value` metadata
block (cover, table of contents, heading numbering, theme, language), `:::`
callout, column and alignment containers, `\pagebreak` and `[[toc]]` lines, image
size and alignment attributes and table captions. `alcy-app` parses it into a
typed model (blocks, styled inline runs, numbering) for the PDF and the agent
outline; the frontend has its own parser for the live preview, so the text never
crosses IPC per keystroke. The agent edits by section (unique heading) and
metadata as well as by exact passage.

Markdown export writes relative image references and a sibling asset directory.
PDF export uses `printpdf` with embedded DejaVu fonts (regular, bold, mono; italic
is slanted unless the theme brings one) and lays out the model natively: themed
headings, cover, a two-pass table of contents with page links, bookmarks,
running header and footer, callouts, columns, tables with repeated headers,
code blocks split across pages and sized images; text stays selectable. Tall
captures shrink to a page or continue across pages at a readable width. PDF
images have a 256 MiB aggregate decoded budget. Themes come from the
`DocumentThemes` registry (see Extensions).
Export runs locally, supports
cancellation and publishes the destination only after rendering succeeds. Images
resolve only through document asset identifiers; remote images, arbitrary file
references and raw HTML execution are unavailable. Documentation has its own v1
format and does not change chat/history formats or the internal sync allowlist.

### Agent

React stores the machine-local chat visibility and context-menu preferences in
`localStorage`, alongside other presentation preferences. Disabling chat removes
its panel, button, shortcut and context-menu actions; unmounting the panel uses
the existing cancellation path. Context-menu actions can also be hidden while
keeping chat enabled. Both preferences apply immediately, preserve provider
configuration and default to the existing behavior for installations without them.

The agent panel chats with a model that acts on the workbench through tools
(ADR 0064). The loop lives in `alcy-app` (`run_agent_turn`): it asks the
model, runs the tools it requests and feeds the results back, up to a fixed
number of rounds, with cancellation and bounded tool output. The model is the
`ChatModel` port, implemented by `alcy-agent` for the Anthropic Messages API
and for OpenAI-compatible Chat Completions (OpenCode Zen, local servers),
both streamed over SSE through `SharedHttpClient`, so the app's proxy and
certificates apply. Nothing leaves the machine until the user sets up a
provider and sends a message or explicitly compacts a saved chat; API keys
live in the system keyring.

Tools are a catalog of plain data in `alcy-app` (name, JSON Schema and an
approval class: read, edit or side effect). They run where the state lives,
in the UI: the `AgentToolHost` port is a bridge in `src-tauri` that sends
each call over the turn's channel and waits for the result. The frontend
asks for approval before side effects (sending, saving, environments),
applies edits to open tabs with a revert, and masks secrets before any value
reaches the model. Every agent front end goes through the same bridge, so
approval and masking hold for all of them.

The tool catalog also exposes flows, value monitors, collection runners and
loopback mock servers, together with collection and environment management.
A workbench-owned editor bridge registers typed controllers for mounted
canvases, runners and mock editors. Agent actions therefore use current
drafts and the same execution controls as the interface. Runner settings
remain session-only; no additional persisted resource format is introduced.
Flow graph edits merge nodes and edges by identity, while explicit node
renaming reuses reference rewriting and preserves linked request drafts.

The `import_from_text` side-effect tool reuses the native text import binding
and its existing format detection, documentation and script translation. It
regenerates identities and commits collections and environments through the
same explicit persistence paths as other agent writes. Imports return bounded
metadata and warnings, without request bodies or variable values. No tab opens
unless `openFirstRequest` is requested; importing never executes requests or
scripts. Independent documents use separate calls; shell command batches use
the native parser. Collection and environment saves are separate, so an
environment save failure reports that collections have already been imported.

Explicit resource writes cancel pending debounced saves, await native
validation/persistence and then publish their state. Concurrent manual
edits win; an outdated approval or save returns a recoverable conflict.
Mock drafts are validated through the existing native DTO conversion before
being shown in the editor. Persisted mutations and executions keep the
existing approval classes and automatic-approval option. Human forms are
always completed by the user, and disabled features remain unavailable.

Flow and runner execution tools return identifiers and starting states;
progress and output are queried separately. Standard and load flow sessions
survive canvas unmounts while their tab remains open, and closing a running
tab cancels its execution. Structured pages and bounded native output
inspection keep tool JSON below the transcript limit. Credential fields,
including inline requests and serialized load configurations, are masked;
partial updates restore masks from matching existing identities. Truncated
values and masks without an original cannot be written back.

The workbench editors (request body, GraphQL query and variables, scripts and
the response body) register in a small editor bridge: the agent highlights
text through each editor's search bar, and the latest selection goes with the
next message as its main context.

The transcript stays in Rust: each turn sends only the new message, and chats
are saved per workspace under app data (`agent-sessions/`), never in the
workspace folder. React remembers only in memory which chat is open in each
workspace, so switching workspaces brings it back but a new app start always
begins with a new chat; the previous ones stay in history. Requests carry
only the latest tool results in full, and a
chat near the provider's context budget has its oldest part summarized by the
model; the summary is saved with the chat, the transcript keeps everything
(spec 0135).

The composer handles slash commands locally. `/clear` starts an empty active
chat while preserving the previous saved conversation. `/compact` invokes an
explicit cancellable use case in `alcy-app` through a typed native binding.
It summarizes all messages not yet covered by the saved summary, without
adding a user turn or running tools. The full transcript remains available;
the next message carries the summary to the provider. Compaction reuses the
existing summary and token-usage fields, so stored sessions need no migration.
Native turns and compaction reserve the session before loading it, preventing
concurrent operations from overwriting one another with stale snapshots.
Editing the last turn after full manual compaction invalidates its summary;
the next request is rebuilt from the corrected transcript.

Final agent replies may end with a bounded `alcy-suggestions` JSON code block.
React renders its strings as optional follow-up buttons only after the turn
finishes. Clicking sends a new message through the existing turn and approval
paths. The trailer stays in the transcript text, so saved chats need no contract
change; it is hidden from rendered prose, copying and quoting.

Token usage is kept with each chat (ADR 0066): every finished turn records
its tokens (the title call of a new chat included) and the chat keeps a total,
also of turns later replaced. The chat shows each answer's cost under it and
the chat total above the composer.

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

Interactive calls report bounded message previews through a Tauri channel;
client and bidirectional streams accept additional messages and an explicit
half-close through an execution-scoped action queue. The protocol crate
consumes actions while draining response events, so transport backpressure
cannot prevent deadline handling. Closing a tab cancels its active gRPC call.
Only unary editor calls inherit the general request timeout; streams use an explicit
deadline when configured. The live UI retains up to 500 events and 1 MiB of
JSON text, with virtual rows; the native call stops with `RESOURCE_EXHAUSTED`
if its retained transcript exceeds 50 MiB or 10,000 events. Final response
bodies still use the existing windowed body cache across IPC.

The composition-root dispatcher also runs gRPC from collection runners and
standard flows, using the app's schema cache, custom CAs, proxy and timeout.
These calls collect responses and half-close after the saved request message;
the editor remains the interactive sender. `Response` carries optional gRPC
status and trailers in memory; existing history formats retain the wire status
headers and JSON body, so their persisted contracts stay unchanged. Runners
always fail non-OK protocol statuses, independently of their HTTP-error option.
Flows take the failure branch while retaining the received response for
inspection and references through `response.grpcStatus` and `response.messages`.

Pre-request scripts can change `al.request.grpc.service`, `method`, `message`
(JSON) and `metadata` (the request header API). Post-response scripts receive
`al.response.grpc` with code, code name, status message, trailers and received
JSON messages. Request edits remain read-only after sending. Interactive
messages share the variable snapshot produced by the call's pre-request script.

Code sharing generates `grpcurl` commands for gRPC instead of HTTP client code.
PNG sharing renders gRPC methods, JSON messages, protocol status, metadata and
trailers with bounded response previews. Embedded import data preserves the gRPC
message and schema configuration, without scripts.
The shell-command importer also parses pasted `grpcurl` calls in Rust, preserving
TLS, metadata, JSON, proto paths and deadlines. Import never executes the command
or reads referenced files; unsupported options fail before changing the request.
The external Insomnia importer reports skipped gRPC resources in both export
formats. Load flow compilation rejects gRPC settings before execution; mock
servers remain HTTP-only. Webclient snapshots retain gRPC entries marked as
unsupported, and the browser refuses to prepare HTTP calls from them.

### WebSocket

`alcy-websocket` opens WebSocket connections (spec 0140, ADR 0067). The
opening handshake is an HTTP/1.1 upgrade sent through the REST executor's
shared client (`ReqwestRestExecutor::upgrade_client`) with
`alcy_http_auth::send_authenticated`, so proxy, custom CAs, the "disable TLS
verification" option (still only on the reviewed client, ADR 0058), session
cookies and every authentication type apply exactly as on REST. The crate
verifies the 101 answer (`Sec-WebSocket-Accept`, offered subprotocols, no
unrequested extension) and hands the upgraded connection to
`tokio-tungstenite`, used only for framing (no TLS stack or connector of its
own). A refused upgrade is a `Response` with that status, headers and the
start of the body, not a transport error. WebSocket over HTTP/2 is not
available while the shared client is HTTP/1.1. Like the other protocol
crates, it is dispatched to only from the composition root.

One session engine serves two modes. Interactive connections (the editor)
stay open until the person disconnects, the server closes or the tab closes;
`execute_websocket_request` streams `opened`, `message` and `closed` events
through a Tauri channel and resolves when the connection ends, while
`send_websocket_message` and `close_websocket` act on the live session,
keyed by execution id (`WebSocketSessions`). Messages sent later resolve
`{{variables}}` with the values captured at connect. Cancelling reuses the
execution registry and drops the connection; a webview reload closes every
live session, since connections have no deadline. Limits follow gRPC: 256 KiB
of preview per event and 500 events or 1 MiB of text in the live UI; natively
16 MiB per message and 50 MiB or 10,000 messages per connection, beyond which
the connection is closed with 1009.

Collect mode serves runners, flows and `al.sendRequest` through the
protocol dispatcher: it sends the saved message (if any), then closes with
1000 at the first of server close, the expected number of replies (1 by
default) or the wait time (the request timeout by default). A run succeeds
when the upgrade returns 101 and the connection ends cleanly (1000, 1001, no
code, or a normal close by Alcy); `Response::protocol_failure` reports the
rest. The response body holds the received messages: the message itself when
there is one, a JSON array otherwise (JSON text as is, anything else as a
string, binary as base64). How the connection ended is kept in memory in
`Response.websocket` and in history as `websocket-close-code`,
`websocket-close-reason` and `websocket-closed-by` pseudo-headers, so the
history format is unchanged. Scripts see `al.request.websocket`
(subprotocols, message) and `al.response.websocket` (close, counts, received
messages); flows expose `response.messages` and `response.closeCode`.

Insomnia `websocket_request` resources and HAR WebSocket entries import as
WebSocket requests (the first saved or sent message becomes the composer
message); Bruno WebSocket items are reported as skipped. Code sharing
generates `websocat` commands. Load flows reject WebSocket requests, mock
servers remain HTTP-only and webclient snapshots mark them unsupported.

### Scripting

`alcy-scripting` runs pre-request and post-response scripts in `boa_engine`
with no I/O (ADR 0018), on its own thread with a large native stack.
`require` loads libraries bundled in the crate, or npm packages that the host
downloads before the script runs: `alcy-script-packages` scans the script for
literal `require('npm:…')` calls, fetches the packages from esm.sh and caches
them in the app data folder, and the interpreter receives their modules as
plain sources (ADR 0061). This is the only network access scripts can cause.

### Usage events

`alcy-app::UsageHub` records small typed usage events: app opened and closed,
workspace opened, requests sent from a tab, collection runs, flow and load
runs, mock servers started and stopped, mock hits, monitor changes, imports,
exports, settings, shortcuts, sidebar modules, agent messages, sync and
update installs. Events carry closed enums, counters, latency durations and
code identifiers only, never URLs, hosts, routes, bodies, headers, variable
values or text typed by the person. Nothing links events to each other or to
a person: each one has its own random id and only the local date (the
interface sends its UTC offset on activation), never a time of day, a session
or how long the app was used. Mock hits are counted by answer and aggregated
per minute because a load test can hit a mock thousands of times per second.

The hub forwards events to a `UsageEventSink` port that only enqueues. This
repository ships no sink: without one the hub stays dormant and nothing is
recorded, stored or sent. When the `usageEvents` feature flag is on, the
interface activates the hub once at startup and reports the few events only
it sees through `record_usage_event`, which accepts a closed set of events
and rejects identifiers that are not code identifiers. The native exit hook
(`RunEvent::Exit`) and the update install record `app_closed` and give the
sink a bounded deadline to deliver or persist.

Settings > Telemetry shows what is and is never recorded and the events of
the current run (`list_recent_usage_events`, at most 200, exactly as handed
to the sink), or that the build collects nothing when no sink exists. The
person's choice is on by default and stored in `usage-preferences.json` (v1)
in the app data directory; turning it off stops recording at once and asks
the sink to discard what was not sent (`UsageEventSink::discard`).

## Initial structure

```text
apps/desktop/          # React + TypeScript
src-tauri/             # Tauri adapter and composition root
crates/alcy-domain/    # core types and rules
crates/alcy-app/       # use cases and ports
crates/alcy-agent/     # agent model providers (Anthropic, OpenAI-compatible)
crates/alcy-collection-import/ # import of external collection formats
crates/alcy-gitlab/    # GitLab client (OAuth PKCE and API v4)
crates/alcy-onedrive/  # OneDrive/SharePoint client (Microsoft OAuth PKCE and Graph)
crates/alcy-load/      # reusable load plan, scheduler, runtime and metrics
crates/alcy-graphql/   # GraphQL capability
crates/alcy-grpc/      # gRPC capability (reflection, .proto, streaming)
crates/alcy-websocket/ # WebSocket capability (handshake, framing, sessions)
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
- Usage events: an extension's setup can register a `UsageEventSink` with `app.state::<alcy_app::UsageHub>().register_sink(...)`; only the first registration counts.
- Document themes: an extension's setup can add PDF export themes (colors, fonts, logo, header and footer text) with `app.state::<alcy_app::DocumentThemes>().register(...)`. Documents pick one with the `theme:` metadata key; the editor offers the choice once more than one theme exists.
- Build: extra Tauri configs merged with `tauri build --config` go in `src-tauri/config/`, which is protected like `tauri.conf.json`.

This repository ships the loader and no extension.

## Related decisions

Technology-specific decisions or boundary changes are recorded alongside the code that implements them.
