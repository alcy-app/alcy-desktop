use std::collections::HashSet;

use alcy_domain::{
    Authentication, BodyPayload, Endpoint, EndpointError, EnvironmentVariable, FormDataField,
    FormDataFieldValue, HeaderEntry, HeaderError, ProtocolId, Request, RequestDocument,
    RouteParameter, UrlEncodedField,
};
use thiserror::Error;

use crate::TemplateError;
use crate::node_reference::NodeRunHistory;
use crate::resolve_variables::resolve_request_template;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ResolveRequestError {
    #[error(transparent)]
    Template(#[from] TemplateError),
    #[error(transparent)]
    Header(#[from] HeaderError),
    #[error(transparent)]
    Endpoint(#[from] EndpointError),
}

fn route_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

/// Substitute `/:name` only in URL paths, excluding the scheme, authority,
/// query string and fragment.
pub fn apply_route_parameters(url: &str, parameters: &[RouteParameter]) -> String {
    let path_end = url.find(['?', '#']).unwrap_or(url.len());
    let (path, suffix) = url.split_at(path_end);
    let bytes = path.as_bytes();
    let mut output = String::with_capacity(url.len());
    let mut cursor = 0;
    let mut index = 0;

    while index + 2 < bytes.len() {
        if bytes[index] == b'/' && bytes[index + 1] == b':' {
            let mut end = index + 2;
            while end < bytes.len() && route_name_byte(bytes[end]) {
                end += 1;
            }
            if end > index + 2 {
                let name = &path[index + 2..end];
                if let Some(parameter) = parameters.iter().find(|parameter| parameter.name == name)
                {
                    output.push_str(&path[cursor..=index]);
                    output.push_str(&parameter.value);
                    cursor = end;
                    index = end;
                    continue;
                }
            }
        }
        index += 1;
    }
    output.push_str(&path[cursor..]);
    output.push_str(suffix);
    output
}

/// Resolve templates in an existing saved request against active variables and
/// ancestor outputs, keeping unknown environment placeholders literal. This
/// mirrors command DTO interpolation, including preserving GraphQL query text.
pub fn resolve_request_variables(
    request: &Request,
    variables: &[EnvironmentVariable],
    node_history: &NodeRunHistory,
    ancestors: &HashSet<String>,
) -> Result<Request, ResolveRequestError> {
    let resolve =
        |template: &str| resolve_request_template(template, variables, node_history, ancestors);

    let route_parameters = request
        .route_parameters
        .iter()
        .map(|parameter| {
            Ok(RouteParameter {
                name: parameter.name.clone(),
                value: resolve(&parameter.value)?,
            })
        })
        .collect::<Result<Vec<_>, ResolveRequestError>>()?;
    let endpoint_url = apply_route_parameters(&resolve(request.endpoint.url())?, &route_parameters);
    let endpoint = Endpoint::new(endpoint_url).map_err(ResolveRequestError::Endpoint)?;

    // A GraphQL query is sent as typed (its own `$variables` carry values);
    // REST bodies and gRPC messages (JSON) take `{{variables}}`.
    let body = match request.document.protocol {
        ProtocolId::Rest | ProtocolId::Grpc => resolve(&request.document.body)?,
        ProtocolId::GraphQl => request.document.body.clone(),
    };
    let document = RequestDocument::new(request.document.protocol, body);

    let request_variables = resolve(&request.variables)?;

    // Interpolate structured body fields before the REST executor encodes them.
    let body_payload = match &request.body_payload {
        BodyPayload::UrlEncoded(fields) => BodyPayload::UrlEncoded(
            fields
                .iter()
                .map(|field| -> Result<UrlEncodedField, ResolveRequestError> {
                    Ok(UrlEncodedField {
                        name: resolve(&field.name)?,
                        value: resolve(&field.value)?,
                        enabled: field.enabled,
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        BodyPayload::FormData(fields) => BodyPayload::FormData(
            fields
                .iter()
                .map(|field| -> Result<FormDataField, ResolveRequestError> {
                    Ok(FormDataField {
                        name: resolve(&field.name)?,
                        enabled: field.enabled,
                        value: match &field.value {
                            FormDataFieldValue::Text(value) => {
                                FormDataFieldValue::Text(resolve(value)?)
                            }
                            FormDataFieldValue::File { file_path } => FormDataFieldValue::File {
                                file_path: resolve(file_path)?,
                            },
                        },
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        BodyPayload::Binary { file_path } => BodyPayload::Binary {
            file_path: resolve(file_path)?,
        },
        other => other.clone(),
    };

    let headers = request
        .headers
        .iter()
        .map(|header| -> Result<HeaderEntry, ResolveRequestError> {
            let value = resolve(header.value())?;
            HeaderEntry::new(header.name(), value, header.enabled)
                .map_err(ResolveRequestError::Header)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let authentication = match &request.authentication {
        Authentication::None => Authentication::None,
        Authentication::Inherit => Authentication::Inherit,
        Authentication::CustomHeader { name, value } => Authentication::CustomHeader {
            name: resolve(name)?,
            value: resolve(value)?,
        },
        Authentication::Bearer { token } => Authentication::Bearer {
            token: resolve(token)?,
        },
        Authentication::Basic { username, password } => Authentication::Basic {
            username: resolve(username)?,
            password: resolve(password)?,
        },
        Authentication::Digest { username, password } => Authentication::Digest {
            username: resolve(username)?,
            password: resolve(password)?,
        },
        Authentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => Authentication::OAuth2ClientCredentials {
            client_id: resolve(client_id)?,
            client_secret: resolve(client_secret)?,
            token_url: resolve(token_url)?,
            scope: resolve(scope)?,
        },
    };

    Ok(Request::new(
        endpoint,
        document,
        request_variables,
        headers,
        authentication,
    )
    .with_method(request.method)
    .with_body_payload(body_payload)
    .with_route_parameters(route_parameters)
    .with_scripts(
        request.pre_request_script.clone(),
        request.post_response_script.clone(),
    )
    .with_redirect_policy(request.redirect_policy)
    .with_grpc(request.grpc.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{HttpMethod, RedirectPolicy, Response, ResponseMetadata};

    fn sample_variables() -> Vec<EnvironmentVariable> {
        vec![EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap()]
    }

    fn no_ancestors() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn applies_route_parameters_only_to_path_segments() {
        let parameters = vec![RouteParameter {
            name: "id".to_string(),
            value: "42".to_string(),
        }];

        assert_eq!(
            apply_route_parameters(
                "https://api.example.com:8443/users/:id?next=/:id#/:id",
                &parameters,
            ),
            "https://api.example.com:8443/users/42?next=/:id#/:id"
        );
    }

    #[test]
    fn resolves_variables_in_a_grpc_message_and_keeps_the_call() {
        let call = alcy_domain::GrpcCall {
            service: "helloworld.Greeter".to_string(),
            method: "SayHello".to_string(),
            deadline_ms: Some(2_000),
            ..Default::default()
        };
        let request = Request::new(
            Endpoint::new("{{host}}:50051").unwrap(),
            RequestDocument::new(ProtocolId::Grpc, r#"{"name": "{{user}}"}"#),
            "",
            vec![],
            Authentication::None,
        )
        .with_grpc(call.clone());
        let variables = vec![
            EnvironmentVariable::new("host", "localhost", false).unwrap(),
            EnvironmentVariable::new("user", "ana", false).unwrap(),
        ];

        let resolved = resolve_request_variables(
            &request,
            &variables,
            &NodeRunHistory::default(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(resolved.endpoint.url(), "localhost:50051");
        assert_eq!(resolved.document.body, r#"{"name": "ana"}"#);
        assert_eq!(resolved.grpc, call);
    }

    #[test]
    fn resolves_variables_inside_route_parameter_values() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/users/:id").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_route_parameters(vec![RouteParameter {
            name: "id".to_string(),
            value: "{{userId}}".to_string(),
        }]);
        let variables = vec![
            EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap(),
            EnvironmentVariable::new("userId", "42", false).unwrap(),
        ];

        let resolved = resolve_request_variables(
            &request,
            &variables,
            &NodeRunHistory::default(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(resolved.endpoint.url(), "https://api.example.com/users/42");
        assert_eq!(
            resolved.route_parameters,
            vec![RouteParameter {
                name: "id".to_string(),
                value: "42".to_string(),
            }]
        );
    }

    #[test]
    fn preserves_transient_redirect_policy() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/redirect").unwrap(),
            RequestDocument::new(ProtocolId::Rest, String::new()),
            String::new(),
            Vec::new(),
            Authentication::None,
        )
        .with_redirect_policy(RedirectPolicy::Manual);

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::default(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(resolved.redirect_policy, RedirectPolicy::Manual);
    }

    #[test]
    fn keeps_the_scripts_of_the_original_request() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_scripts("pre", "post");

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::default(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(resolved.pre_request_script, "pre");
        assert_eq!(resolved.post_response_script, "post");
    }

    #[test]
    fn keeps_and_resolves_the_structured_body_of_a_rest_request() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/upload").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_body_payload(BodyPayload::FormData(vec![
            FormDataField {
                name: "origin".to_string(),
                enabled: true,
                value: FormDataFieldValue::Text("{{baseUrl}}".to_string()),
            },
            FormDataField {
                name: "file".to_string(),
                enabled: false,
                value: FormDataFieldValue::File {
                    file_path: "files/photo.png".to_string(),
                },
            },
        ]));

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::default(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(
            resolved.body_payload,
            BodyPayload::FormData(vec![
                FormDataField {
                    name: "origin".to_string(),
                    enabled: true,
                    value: FormDataFieldValue::Text("https://api.example.com".to_string()),
                },
                FormDataField {
                    name: "file".to_string(),
                    enabled: false,
                    value: FormDataFieldValue::File {
                        file_path: "files/photo.png".to_string(),
                    },
                },
            ])
        );
    }

    #[test]
    fn resolves_the_urlencoded_fields_before_they_are_encoded() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/login").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_body_payload(BodyPayload::UrlEncoded(vec![UrlEncodedField {
            name: "redirect".to_string(),
            value: "{{baseUrl}}/home".to_string(),
            enabled: true,
        }]));

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::default(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(
            resolved.body_payload,
            BodyPayload::UrlEncoded(vec![UrlEncodedField {
                name: "redirect".to_string(),
                value: "https://api.example.com/home".to_string(),
                enabled: true,
            }])
        );
    }

    #[test]
    fn resolves_the_endpoint_url() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/graphql").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![],
            Authentication::None,
        );

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(resolved.endpoint.url(), "https://api.example.com/graphql");
    }

    #[test]
    fn resolves_a_node_reference_in_a_header() {
        let request = Request::new(
            Endpoint::new("https://api.example.com").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![
                HeaderEntry::new(
                    "Authorization",
                    "Bearer {{nodes.req-a.response.body.token}}",
                    true,
                )
                .unwrap(),
            ],
            Authentication::None,
        );
        let mut history = NodeRunHistory::new();
        history.record(
            "req-a".to_string(),
            Response::new(
                200,
                1,
                "{\"token\":\"abc123\"}",
                vec![],
                ResponseMetadata::default(),
            ),
        );
        let ancestors = HashSet::from(["req-a".to_string()]);

        let resolved =
            resolve_request_variables(&request, &sample_variables(), &history, &ancestors).unwrap();

        assert_eq!(resolved.headers[0].value(), "Bearer abc123");
    }

    #[test]
    fn does_not_resolve_a_graphql_document_body() {
        let request = Request::new(
            Endpoint::new("https://api.example.com/graphql").unwrap(),
            RequestDocument::new(
                ProtocolId::GraphQl,
                "query { field(base: \"{{baseUrl}}\") }",
            ),
            "{}",
            vec![],
            Authentication::None,
        );

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(
            resolved.document.body,
            "query { field(base: \"{{baseUrl}}\") }"
        );
    }

    #[test]
    fn resolves_a_rest_document_body() {
        let request = Request::new(
            Endpoint::new("https://api.example.com/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, "{\"url\":\"{{baseUrl}}\"}"),
            "",
            vec![],
            Authentication::None,
        );

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(
            resolved.document.body,
            "{\"url\":\"https://api.example.com\"}"
        );
    }

    #[test]
    fn preserves_the_http_method() {
        let request = Request::new(
            Endpoint::new("https://api.example.com/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_method(HttpMethod::Delete);

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(resolved.method, HttpMethod::Delete);
    }

    #[test]
    fn resolves_bearer_authentication() {
        let request = Request::new(
            Endpoint::new("https://api.example.com").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::Bearer {
                token: "{{baseUrl}}".to_string(),
            },
        );

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(
            resolved.authentication,
            Authentication::Bearer {
                token: "https://api.example.com".to_string(),
            }
        );
    }

    #[test]
    fn resolves_custom_header_authentication() {
        let request = Request::new(
            Endpoint::new("https://api.example.com").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::CustomHeader {
                name: "X-Api-Key".to_string(),
                value: "{{baseUrl}}".to_string(),
            },
        );

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(
            resolved.authentication,
            Authentication::CustomHeader {
                name: "X-Api-Key".to_string(),
                value: "https://api.example.com".to_string(),
            }
        );
    }

    #[test]
    fn preserves_missing_environment_variables_in_request_fields() {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/users/{{ missing }}").unwrap(),
            RequestDocument::new(ProtocolId::Rest, r#"{"name":"{{missing}}"}"#),
            r#"{"name":"{{missing}}"}"#,
            vec![HeaderEntry::new("X-Name", "{{missing}}", true).unwrap()],
            Authentication::Bearer {
                token: "{{missing}}".to_string(),
            },
        );

        let resolved = resolve_request_variables(
            &request,
            &sample_variables(),
            &NodeRunHistory::new(),
            &no_ancestors(),
        )
        .unwrap();

        assert_eq!(
            resolved.endpoint.url(),
            "https://api.example.com/users/{{ missing }}"
        );
        assert_eq!(resolved.document.body, r#"{"name":"{{missing}}"}"#);
        assert_eq!(resolved.variables, r#"{"name":"{{missing}}"}"#);
        assert_eq!(resolved.headers[0].value(), "{{missing}}");
        assert_eq!(
            resolved.authentication,
            Authentication::Bearer {
                token: "{{missing}}".to_string()
            }
        );
    }

    #[test]
    fn still_rejects_invalid_or_unavailable_node_outputs() {
        for reference in ["nodes.invalid", "nodes.req-a.response.status"] {
            let request = Request::new(
                Endpoint::new("https://api.example.com").unwrap(),
                RequestDocument::new(ProtocolId::Rest, format!("{{{{{reference}}}}}")),
                "",
                vec![],
                Authentication::None,
            );

            let error =
                resolve_request_variables(&request, &[], &NodeRunHistory::new(), &no_ancestors())
                    .unwrap_err();

            assert!(matches!(
                error,
                ResolveRequestError::Template(TemplateError::NodeReference(_))
            ));
        }
    }
}
