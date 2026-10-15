//! What a gRPC request calls (spec 0129, ADR 0062). Only the gRPC executor
//! reads it — the same pattern as `variables` for GraphQL and `body_payload`
//! for REST. The request message itself is the document body, as JSON.

/// Where the service, method and message types come from.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum GrpcSchemaSource {
    /// Asked to the server through the reflection service.
    #[default]
    Reflection,
    /// Compiled from local `.proto` files. Paths are relative to the
    /// workspace, like binary body files (ADR 0024).
    ProtoFiles {
        files: Vec<String>,
        /// Folders searched for the files' `import`s.
        import_paths: Vec<String>,
    },
}

/// The method a gRPC request calls and how to reach its schema.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GrpcCall {
    /// Fully qualified service name (`package.Service`); empty until chosen.
    pub service: String,
    /// Method name within the service; empty until chosen.
    pub method: String,
    pub schema_source: GrpcSchemaSource,
    /// Call deadline; `None` uses the configured request timeout.
    pub deadline_ms: Option<u64>,
}

impl GrpcCall {
    /// `/package.Service/Method`, the path gRPC sends the call to.
    pub fn path(&self) -> Option<String> {
        let service = self.service.trim();
        let method = self.method.trim();
        (!service.is_empty() && !method.is_empty()).then(|| format!("/{service}/{method}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_reflection_with_no_method_chosen() {
        let call = GrpcCall::default();
        assert_eq!(call.schema_source, GrpcSchemaSource::Reflection);
        assert_eq!(call.path(), None);
        assert_eq!(call.deadline_ms, None);
    }

    #[test]
    fn builds_the_call_path_once_service_and_method_are_set() {
        let call = GrpcCall {
            service: " helloworld.Greeter ".to_string(),
            method: "SayHello".to_string(),
            ..GrpcCall::default()
        };
        assert_eq!(call.path().as_deref(), Some("/helloworld.Greeter/SayHello"));
        let without_method = GrpcCall {
            method: String::new(),
            ..call
        };
        assert_eq!(without_method.path(), None);
    }
}
