//! gRPC capability (spec 0129, ADR 0062): calls any method of any service
//! without generated code. Message types come from server reflection or from
//! local `.proto` files compiled in-process; messages travel as JSON at the
//! edges and as protobuf on the wire.
//!
//! Like `alcy-rest` and `alcy-graphql`, this crate sits beside the other
//! protocol capabilities and is only dispatched to from the composition root.

mod base64;
mod call;
mod codec;
mod connect;
mod error;
mod schema;

pub use call::{
    CallHandle, CallOutcome, ClientAction, GrpcEvent, GrpcStatus, MetadataEntry, start_call,
};
pub use codec::DynamicCodec;
pub use connect::{ConnectionSettings, GrpcTarget, connect};
pub use error::GrpcError;
// Types the composition root keeps between calls (schema cache, channels).
pub use prost_reflect::DescriptorPool;
pub use schema::{
    MethodKind, MethodSummary, SchemaSummary, ServiceSummary, compile_proto_files,
    compile_workspace_proto_files, describe, find_method, message_from_json, message_to_json,
    reflect, resolve_against,
};
pub use tonic::transport::Channel;
