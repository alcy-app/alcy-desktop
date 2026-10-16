//! Maps grpcurl arguments to a saved request without running a shell or reading files.

use std::{collections::HashSet, time::Duration};

use alcy_domain::{
    Authentication, Endpoint, GrpcCall, GrpcSchemaSource, HeaderEntry, ProtocolId, Request,
    RequestDocument, SavedRequest,
};

use super::{CollectionImportError, IdGenerator, unique_name};

fn invalid(message: impl Into<String>) -> CollectionImportError {
    CollectionImportError::Invalid(message.into())
}

pub(super) fn parse(
    args: &[String],
    ids: &mut IdGenerator,
    names: &mut HashSet<String>,
) -> Result<SavedRequest, CollectionImportError> {
    let mut args = args.iter();
    let mut plaintext = false;
    let mut reflection = None;
    let mut files = Vec::new();
    let mut import_paths = Vec::new();
    let mut headers = Vec::new();
    let mut message = "{}".to_string();
    let mut deadline_ms = None;
    let mut positional = Vec::new();
    while let Some(arg) = args.next() {
        if arg == "--" {
            positional.extend(args);
            break;
        }
        let Some(flag) = arg.strip_prefix('-') else {
            positional.push(arg);
            positional.extend(args);
            break;
        };
        let flag = flag.strip_prefix('-').unwrap_or(flag);
        let (name, inline) = flag
            .split_once('=')
            .map_or((flag, None), |(name, value)| (name, Some(value)));
        match name {
            "plaintext" => plaintext = boolean(name, inline)?,
            "use-reflection" => reflection = Some(boolean(name, inline)?),
            // These flags only affect grpcurl's console output.
            "v" | "vv" | "emit-defaults" | "format-error" | "msg-template" => {
                boolean(name, inline)?;
            }
            "H" | "d" | "proto" | "import-path" | "max-time" | "format" => {
                let value = inline
                    .or_else(|| args.next().map(String::as_str))
                    .ok_or_else(|| invalid(format!("grpcurl: falta o valor de -{name}")))?;
                match name {
                    "H" => {
                        let (name, value) = value.split_once(':').ok_or_else(|| {
                            invalid("grpcurl: metadata deve usar o formato 'nome: valor'")
                        })?;
                        let header = HeaderEntry::new(name.trim(), value.trim(), true)?;
                        header.validate_http()?;
                        headers.push(header);
                    }
                    "d" => {
                        if value == "@" {
                            return Err(invalid(
                                "grpcurl: substitua -d @ pela mensagem JSON no próprio comando",
                            ));
                        }
                        message = if value.trim().is_empty() { "{}" } else { value }.to_string();
                        serde_json::from_str::<serde_json::Value>(&message).map_err(|_| {
                            invalid("grpcurl: -d deve conter uma única mensagem JSON válida")
                        })?;
                    }
                    "proto" | "import-path" => {
                        if value.trim().is_empty() {
                            return Err(invalid(format!("grpcurl: -{name} não pode estar vazio")));
                        }
                        if name == "proto" {
                            files.push(value.to_string());
                        } else {
                            import_paths.push(value.to_string());
                        }
                    }
                    "max-time" => deadline_ms = deadline(value)?,
                    "format" if value != "json" => {
                        return Err(invalid("grpcurl: somente -format json é suportado"));
                    }
                    _ => {}
                }
            }
            _ => {
                return Err(invalid(format!(
                    "grpcurl: a opção -{name} não é suportada na importação"
                )));
            }
        }
    }
    let [address, symbol] = positional.as_slice() else {
        return Err(invalid(
            "grpcurl: informe o endereço e o serviço/método da chamada",
        ));
    };
    if address.is_empty()
        || address.chars().any(char::is_whitespace)
        || address.contains(['/', '?', '#', '@'])
        || matches!(symbol.as_str(), "list" | "describe")
    {
        return Err(invalid(
            "grpcurl: informe um endereço host:porta e um serviço/método",
        ));
    }
    let symbol = symbol.trim_start_matches('/').trim_start_matches('.');
    let (service, method) = symbol
        .rsplit_once('/')
        .or_else(|| symbol.rsplit_once('.'))
        .filter(|(service, method)| service.split('.').all(is_identifier) && is_identifier(method))
        .ok_or_else(|| invalid("grpcurl: método inválido; use pacote.Serviço/Método"))?;
    let schema_source = if files.is_empty() {
        if reflection == Some(false) {
            return Err(invalid(
                "grpcurl: -use-reflection=false exige arquivos -proto",
            ));
        }
        GrpcSchemaSource::Reflection
    } else {
        if reflection == Some(true) {
            return Err(invalid(
                "grpcurl: combine apenas arquivos -proto ou reflection",
            ));
        }
        GrpcSchemaSource::ProtoFiles {
            files,
            import_paths,
        }
    };
    let endpoint = format!("{}://{address}", if plaintext { "grpc" } else { "grpcs" });
    let request = Request::new(
        Endpoint::new(endpoint)?,
        RequestDocument::new(ProtocolId::Grpc, message),
        String::new(),
        headers,
        Authentication::None,
    )
    .with_grpc(GrpcCall {
        service: service.to_string(),
        method: method.to_string(),
        schema_source,
        deadline_ms,
    });
    let name = unique_name(&format!("{service}/{method}"), names);
    SavedRequest::new(ids.next("request"), name, request).map_err(Into::into)
}

fn boolean(name: &str, value: Option<&str>) -> Result<bool, CollectionImportError> {
    match value.unwrap_or("true") {
        "true" | "1" | "t" | "T" | "TRUE" | "True" => Ok(true),
        "false" | "0" | "f" | "F" | "FALSE" | "False" => Ok(false),
        _ => Err(invalid(format!(
            "grpcurl: valor booleano inválido para -{name}"
        ))),
    }
}

fn deadline(value: &str) -> Result<Option<u64>, CollectionImportError> {
    let milliseconds = value
        .parse::<f64>()
        .ok()
        .and_then(|seconds| Duration::try_from_secs_f64(seconds).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .filter(|millis| *millis > 0 || value.parse::<f64>() == Ok(0.0))
        .ok_or_else(|| {
            invalid(
                "grpcurl: -max-time deve ser zero ou um prazo válido em segundos (mínimo 0.001)",
            )
        })?;
    Ok((milliseconds > 0).then_some(milliseconds))
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_shell_commands;

    fn request(command: &str) -> Request {
        parse_shell_commands(command).unwrap().collections[0].requests()[0]
            .request
            .clone()
    }

    #[test]
    fn imports_plaintext_call_metadata_and_json_without_running_shell_content() {
        let imported = request(
            r#"# Copied command
$ grpcurl -plaintext -H 'authorization: Bearer {{token}}' \
  -H 'x-id: first' -H 'x-id: second' -d '{"greeting":"$(echo hello); `id`"}' \
  grpcb.in:9000 hello.HelloService/SayHello"#,
        );
        assert_eq!(imported.document.protocol, ProtocolId::Grpc);
        assert_eq!(imported.endpoint.url(), "grpc://grpcb.in:9000");
        assert_eq!(
            imported.grpc.path().as_deref(),
            Some("/hello.HelloService/SayHello")
        );
        assert_eq!(imported.grpc.schema_source, GrpcSchemaSource::Reflection);
        assert_eq!(
            imported.document.body,
            r#"{"greeting":"$(echo hello); `id`"}"#
        );
        assert_eq!(imported.headers.len(), 3);
        assert_eq!(imported.headers[0].value(), "Bearer {{token}}");
        assert_eq!(imported.headers[1].value(), "first");
        assert_eq!(imported.headers[2].value(), "second");
    }

    #[test]
    fn preserves_tls_on_nonstandard_ports_and_accepts_dotted_method_names() {
        let imported =
            request("/usr/bin/grpcurl -plaintext=false api.test:8443 package.Service.Method");
        assert_eq!(imported.endpoint.url(), "grpcs://api.test:8443");
        assert_eq!(
            imported.grpc.path().as_deref(),
            Some("/package.Service/Method")
        );
        assert_eq!(imported.document.body, "{}");
        assert_eq!(
            request("grpcurl '[::1]:443' /pkg.Svc/Call").endpoint.url(),
            "grpcs://[::1]:443"
        );
    }

    #[test]
    fn imports_generated_snippet_with_proto_paths_quoting_and_deadline() {
        let imported = request(
            r#"# Run from the workspace folder.
grpcurl -plaintext \
  -import-path 'protos' -import-path 'third party' -import-path '.' \
  -proto 'protos/hello.proto' -proto 'protos/O'\''Brien.proto' \
  -max-time 2.5 -H 'x-id: 42' -d '{"name":"O'\''Brien"}' \
  -- 'localhost:50051' 'test.Greeter/Hello'"#,
        );
        assert_eq!(imported.grpc.deadline_ms, Some(2500));
        assert_eq!(imported.document.body, r#"{"name":"O'Brien"}"#);
        assert_eq!(
            imported.grpc.schema_source,
            GrpcSchemaSource::ProtoFiles {
                files: vec![
                    "protos/hello.proto".to_string(),
                    "protos/O'Brien.proto".to_string()
                ],
                import_paths: vec![
                    "protos".to_string(),
                    "third party".to_string(),
                    ".".to_string()
                ],
            }
        );
    }

    #[test]
    fn accepts_equals_options_and_mixed_command_imports() {
        let data = parse_shell_commands(
            r#"grpcurl.exe --plaintext -max-time=0 -format=json -v -d='{}' host:90 Svc/Call
curl https://api.test
grpcurl -proto=a.proto -use-reflection=false host:443 Svc/Call"#,
        )
        .unwrap();
        let requests = data.collections[0].requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].request.grpc.deadline_ms, None);
        assert_eq!(requests[1].request.document.protocol, ProtocolId::Rest);
        assert_eq!(requests[2].name(), "Svc/Call (2)");
    }

    #[test]
    fn rejects_unsupported_options_or_missing_data_instead_of_importing_a_different_call() {
        for command in [
            "grpcurl -insecure host:443 Svc/Call",
            "grpcurl -cacert private.pem host:443 Svc/Call",
            "grpcurl -rpc-header 'secret: value' host:443 Svc/Call",
            "grpcurl -reflect-header 'secret: value' host:443 Svc/Call",
            "grpcurl -expand-headers host:443 Svc/Call",
            "grpcurl -d @ host:443 Svc/Call",
            "grpcurl -d @message.json host:443 Svc/Call",
            "grpcurl -d '{} {}' host:443 Svc/Call",
            "grpcurl -format text -d 'name: value' host:443 Svc/Call",
            "grpcurl host:443 list",
            "grpcurl host:443 describe",
            "grpcurl host:443",
            "grpcurl host:443 /Svc/",
            "grpcurl -H broken host:443 Svc/Call",
            "grpcurl -H 'x: a\nb' host:443 Svc/Call",
            "grpcurl -plaintext=invalid host:443 Svc/Call",
            "grpcurl -proto '' host:443 Svc/Call",
            "grpcurl -use-reflection=false host:443 Svc/Call",
            "grpcurl -use-reflection -proto a.proto host:443 Svc/Call",
            "grpcurl -d",
            "grpcurl host:443 Svc/Call < message.json",
            "grpcurl 'unix:///tmp/service' Svc/Call",
        ] {
            assert!(
                matches!(
                    parse_shell_commands(command),
                    Err(CollectionImportError::Invalid(_))
                ),
                "{command}"
            );
        }
    }

    #[test]
    fn rejects_invalid_deadlines() {
        for value in ["-1", "NaN", "inf", "1e100", "0.0001", "invalid"] {
            assert!(deadline(value).is_err(), "{value}");
        }
        assert_eq!(deadline("0.001").unwrap(), Some(1));
    }
}
