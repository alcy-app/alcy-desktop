# Alcy

Alcy is a local-first desktop client for building, running and inspecting GraphQL, REST, gRPC and WebSocket API requests, with a simple, fast and fully local experience.

## gRPC

Create a gRPC request, enter the server address and load its schema through
server reflection or local `.proto` files. Select a service and method, then
edit the JSON message, metadata and authentication. Unary, server streaming,
client streaming and bidirectional streaming calls are supported. For client
and bidirectional streams, send additional messages and end the outgoing
stream in the editor. Cancel stops the active call.

Use `host:port`, `grpc://` or `http://` for plaintext connections and `grpcs://`
or `https://` for TLS. Without a scheme, port 443 selects TLS. Custom CAs and
HTTP proxies configured in Alcy also apply to gRPC. Unary editor calls use
the general timeout; streams only use a deadline when explicitly configured.

Pre-request scripts can edit `al.request.grpc.service`, `method`, `message`
(a JSON value) and `metadata` (the headers API). Post-response scripts can
inspect `al.response.grpc.code`, `codeName`, `message`, `trailers` and
`messages`. Collection runs and standard flows support all four call kinds;
they send the saved JSON message once, close the outgoing stream and collect
the responses. Non-OK gRPC statuses fail the step. Flows retain the response
and expose `response.grpcStatus` and `response.messages` to successor nodes.

Share a gRPC request as a [grpcurl](https://github.com/fullstorydev/grpcurl)
command. It includes the saved message, metadata, explicit deadline and local
schema paths; run it from the workspace folder when using relative paths.
Configure certificates and proxies separately in grpcurl. Scripts and
interactive stream messages are not included in the generated command.

gRPC is not supported by load tests or mock servers. Exported webclients
retain gRPC entries with an unsupported warning and cannot send them.
Insomnia imports skip gRPC entries and report them in the import warnings.

## WebSocket

Create a WebSocket request, enter a `ws://` or `wss://` address and press
Connect. The message list shows what is sent and received as it happens;
write a text, JSON or binary (base64) message in the composer and send it as
many times as needed while connected. Disconnect closes the connection
normally; closing the tab or reloading the window also closes it. Headers,
query and route parameters, every authentication type, session cookies,
custom CAs, the TLS options and HTTP proxies apply to the connection
handshake as they do to REST. Subprotocols are set in the Settings tab.

Collection runs and standard flows connect, send the saved message, wait for
the expected number of replies (1 by default) or the configured wait, and
close. A refused handshake or an abnormal close fails the step. Scripts see
`al.request.websocket` and `al.response.websocket`; flows expose
`response.messages` and `response.closeCode`.

Share a WebSocket request as a [websocat](https://github.com/vi/websocat)
command. Insomnia and HAR WebSocket entries are imported; load tests, mock
servers and exported webclients do not support WebSocket.

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
