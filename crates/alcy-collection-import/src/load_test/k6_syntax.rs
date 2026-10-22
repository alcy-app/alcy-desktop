//! AST boundaries for the deliberately static k6 import matrix.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use super::k6_values::{K6Resolver, K6Value};
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, BindingPatternKind, Declaration, ExportDefaultDeclarationKind, Expression,
    FormalParameters, FunctionBody, ImportDeclarationSpecifier, ObjectPropertyKind, PropertyKey,
    Statement, VariableDeclarationKind,
};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};

use super::{K6MetricDefinition, K6StaticImport, LoadImportDiagnostic, LoadTestImportError, diag};

pub(super) struct K6Syntax {
    pub imports: Vec<K6StaticImport>,
    pub functions: BTreeMap<String, Range<usize>>,
    pub calls: Vec<K6StaticCall>,
    pub metrics: Vec<K6MetricDefinition>,
    pub options: Option<(usize, K6Value)>,
    pub required_variables: Vec<String>,
}

pub(super) struct K6StaticCall {
    pub callee: String,
    pub offset: usize,
    pub argument_offset: usize,
    pub response_name: Option<String>,
    pub arguments: Vec<K6Value>,
}

struct StaticBody<'a> {
    name: String,
    own_name: Option<String>,
    body: &'a FunctionBody<'a>,
    params: &'a FormalParameters<'a>,
    asynchronous: bool,
    generator: bool,
    offset: usize,
}

/// Inspect syntax without evaluating it. Unknown statements cannot disappear
/// during lowering, and nested callbacks cannot become unconditional requests.
pub(super) fn parse_k6_syntax(name: &str, source: &str) -> Result<K6Syntax, LoadTestImportError> {
    let source_type =
        SourceType::from_path(name.to_ascii_lowercase()).unwrap_or_else(|_| SourceType::mjs());
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    let mut diagnostics = parsed
        .errors
        .into_iter()
        .map(|error| {
            let offset = error
                .labels
                .as_ref()
                .and_then(|labels| labels.first())
                .map_or(0, |label| label.offset());
            diag(
                source,
                offset,
                format!("sintaxe JavaScript/TypeScript inválida: {error}"),
            )
        })
        .collect::<Vec<_>>();
    if parsed.panicked {
        diagnostics.push(diag(
            source,
            0,
            "o parser JavaScript/TypeScript não conseguiu recuperar a análise",
        ));
    }
    if !diagnostics.is_empty() {
        return Err(LoadTestImportError::Incompatible { diagnostics });
    }

    let mut syntax = K6Syntax {
        imports: Vec::new(),
        functions: BTreeMap::new(),
        calls: Vec::new(),
        metrics: Vec::new(),
        options: None,
        required_variables: Vec::new(),
    };
    let mut bindings = BTreeMap::new();
    for statement in &parsed.program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        let module = import.source.value.as_str();
        syntax.imports.push(K6StaticImport {
            specifier: module.into(),
            offset: import.source.span.start as usize,
        });
        for specifier in import.specifiers.iter().flatten() {
            let binding = match specifier {
                ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                    (module == "k6/http" && specifier.local.name == "http")
                        .then_some(("http", "k6/http"))
                }
                ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                    let imported = specifier.imported.name();
                    let local = specifier.local.name.as_str();
                    let supported = (module == "k6" && matches!(local, "sleep" | "check"))
                        || (module == "k6/metrics"
                            && matches!(local, "Counter" | "Gauge" | "Rate" | "Trend"));
                    (supported && imported == local).then_some((local, module))
                }
                _ => None,
            };
            if let Some((name, module)) = binding {
                if bindings
                    .insert(name.to_string(), module.to_string())
                    .is_some()
                {
                    diagnostics.push(diag(
                        source,
                        specifier.span().start as usize,
                        "binding k6 duplicado",
                    ));
                }
            } else {
                diagnostics.push(diag(
                    source,
                    specifier.span().start as usize,
                    "binding ou alias de import k6 não suportado",
                ));
            }
        }
    }
    diagnostics.extend(super::forbidden_k6_constructs(source, &syntax.imports));

    let mut resolver = K6Resolver::new(source);
    let mut bodies = Vec::new();
    let mut declarations = BTreeSet::new();
    for statement in &parsed.program.body {
        let offset = statement.span().start as usize;
        let (exported, declaration) = match statement {
            Statement::ImportDeclaration(_)
            | Statement::EmptyStatement(_)
            | Statement::TSTypeAliasDeclaration(_)
            | Statement::TSInterfaceDeclaration(_) => continue,
            Statement::ExportNamedDeclaration(export) => (true, export.declaration.as_ref()),
            Statement::ExportDefaultDeclaration(default) => {
                let body = match &default.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        function.body.as_deref().map(|body| StaticBody {
                            name: "default".into(),
                            own_name: function.id.as_ref().map(|id| id.name.to_string()),
                            body,
                            params: &function.params,
                            asynchronous: function.r#async,
                            generator: function.generator || function.this_param.is_some(),
                            offset,
                        })
                    }
                    ExportDefaultDeclarationKind::ArrowFunctionExpression(arrow)
                        if !arrow.expression =>
                    {
                        Some(StaticBody {
                            name: "default".into(),
                            own_name: None,
                            body: &arrow.body,
                            params: &arrow.params,
                            asynchronous: arrow.r#async,
                            generator: false,
                            offset,
                        })
                    }
                    _ => None,
                };
                if let Some(body) = body {
                    bodies.push(body);
                } else {
                    diagnostics.push(diag(
                        source,
                        offset,
                        "export default exige função estática com corpo",
                    ));
                }
                continue;
            }
            _ => (false, statement.as_declaration()),
        };
        if let Some(Declaration::FunctionDeclaration(function)) = declaration {
            if let (true, Some(id), Some(body)) = (exported, &function.id, function.body.as_deref())
            {
                bodies.push(StaticBody {
                    name: id.name.to_string(),
                    own_name: None,
                    body,
                    params: &function.params,
                    asynchronous: function.r#async,
                    generator: function.generator || function.this_param.is_some(),
                    offset,
                });
            } else {
                diagnostics.push(diag(
                    source,
                    offset,
                    "helper k6 precisa de tradução explícita",
                ));
            }
            continue;
        }
        let Some(Declaration::VariableDeclaration(variables)) = declaration else {
            diagnostics.push(diag(
                source,
                offset,
                "declaração ou helper k6 fora da matriz estática",
            ));
            continue;
        };
        for variable in &variables.declarations {
            let BindingPatternKind::BindingIdentifier(id) = &variable.id.kind else {
                diagnostics.push(diag(source, offset, "desestruturação k6 não suportada"));
                continue;
            };
            let name = id.name.as_str();
            if bindings.contains_key(name)
                || matches!(name, "JSON" | "__ENV")
                || !declarations.insert(name.to_string())
            {
                diagnostics.push(diag(
                    source,
                    offset,
                    "binding k6 duplicado ou conflitante com import",
                ));
            }
            let Some(init) = &variable.init else {
                diagnostics.push(diag(source, offset, "declaração k6 exige valor estático"));
                continue;
            };
            match init {
                _ if name == "options"
                    && exported
                    && variables.kind == VariableDeclarationKind::Const =>
                {
                    match resolver.resolve(init) {
                        Ok(value) if value.object().is_some() && !value.dynamic() => {
                            resolver.values.insert(name.into(), value.clone());
                            syntax.options = Some((init.span().start as usize, value));
                        }
                        _ => diagnostics.push(diag(
                            source,
                            init.span().start as usize,
                            "options k6 requires a static object without runtime variables",
                        )),
                    }
                }
                Expression::NewExpression(metric) if !exported && name != "options" => {
                    let constructor = identifier(&metric.callee).unwrap_or_default();
                    let kind = match constructor {
                        "Counter" => "counter",
                        "Gauge" => "gauge",
                        "Rate" => "rate",
                        "Trend" => "trend",
                        _ => "",
                    };
                    let metric_name = match metric.arguments.as_slice() {
                        [argument] => argument
                            .as_expression()
                            .and_then(|value| resolver.resolve(value).ok())
                            .and_then(|value| value.string().map(str::to_string)),
                        _ => None,
                    };
                    if kind.is_empty()
                        || bindings.get(constructor).map(String::as_str) != Some("k6/metrics")
                    {
                        diagnostics.push(diag(
                            source,
                            offset,
                            "construtor de métrica k6 não suportado",
                        ));
                    } else if let Some(metric_name) = metric_name {
                        syntax.metrics.push(K6MetricDefinition {
                            variable: name.into(),
                            name: metric_name,
                            kind,
                        });
                    } else {
                        diagnostics.push(diag(
                            source,
                            offset,
                            "métrica k6 exige nome literal e construtor sem opções",
                        ));
                    }
                }
                _ if name != "options" && variables.kind == VariableDeclarationKind::Const => {
                    match resolver.resolve(init) {
                        Ok(value) => {
                            resolver.values.insert(name.into(), value);
                        }
                        Err(message) => {
                            diagnostics.push(diag(source, init.span().start as usize, message))
                        }
                    }
                }
                Expression::StringLiteral(_)
                | Expression::NumericLiteral(_)
                | Expression::BooleanLiteral(_)
                | Expression::NullLiteral(_)
                    if name != "options" => {}
                _ => diagnostics.push(diag(
                    source,
                    offset,
                    "declaração k6 fora da matriz de valores estáticos",
                )),
            }
        }
    }
    for body in bodies {
        if body.asynchronous
            || body.generator
            || !body.params.items.is_empty()
            || body.params.rest.is_some()
        {
            diagnostics.push(diag(source, body.offset, "funções k6 exigem corpo síncrono sem parâmetros; dados de setup ainda não são traduzidos"));
        }
        let shadowed = body.own_name.as_ref().is_some_and(|name| {
            bindings.contains_key(name)
                || matches!(name.as_str(), "JSON" | "__ENV")
                || !declarations.insert(name.clone())
        });
        if shadowed
            || matches!(body.name.as_str(), "JSON" | "__ENV")
            || bindings.contains_key(&body.name)
            || !declarations.insert(body.name.clone())
        {
            diagnostics.push(diag(
                source,
                body.offset,
                "função k6 duplicada ou conflitante com import ou métrica",
            ));
        }
        syntax.functions.insert(
            body.name,
            body.body.span.start as usize..body.body.span.end as usize,
        );
        read_body(
            source,
            body.body,
            &bindings,
            &declarations,
            &mut syntax,
            &mut resolver,
            &mut diagnostics,
        );
    }
    syntax.required_variables = resolver.required_variables.into_iter().collect();
    if diagnostics.is_empty() {
        Ok(syntax)
    } else {
        Err(LoadTestImportError::Incompatible { diagnostics })
    }
}

fn identifier<'a>(expression: &'a Expression<'_>) -> Option<&'a str> {
    if let Expression::Identifier(id) = expression {
        Some(id.name.as_str())
    } else {
        None
    }
}

fn read_body(
    source: &str,
    body: &FunctionBody<'_>,
    bindings: &BTreeMap<String, String>,
    declarations: &BTreeSet<String>,
    syntax: &mut K6Syntax,
    resolver: &mut K6Resolver<'_>,
    diagnostics: &mut Vec<LoadImportDiagnostic>,
) {
    let global_values = resolver.values.clone();
    let mut locals = BTreeSet::new();
    for (index, statement) in body.statements.iter().enumerate() {
        let offset = statement.span().start as usize;
        let (expression, response_name) = match statement {
            Statement::EmptyStatement(_) => continue,
            Statement::ReturnStatement(ret) => {
                if ret.argument.is_some() || index + 1 != body.statements.len() {
                    diagnostics.push(diag(
                        source,
                        offset,
                        "return com dados ou saída antecipada k6 ainda não é traduzido",
                    ));
                }
                continue;
            }
            Statement::ExpressionStatement(expression) => (&expression.expression, None),
            Statement::VariableDeclaration(variables) => {
                let [variable] = variables.declarations.as_slice() else {
                    diagnostics.push(diag(
                        source,
                        offset,
                        "declaração de resposta k6 exige uma variável",
                    ));
                    continue;
                };
                let BindingPatternKind::BindingIdentifier(id) = &variable.id.kind else {
                    diagnostics.push(diag(
                        source,
                        offset,
                        "desestruturação de resposta k6 não suportada",
                    ));
                    continue;
                };
                let name = id.name.to_string();
                if bindings.contains_key(&name)
                    || matches!(name.as_str(), "JSON" | "__ENV")
                    || declarations.contains(&name)
                    || !locals.insert(name.clone())
                {
                    diagnostics.push(diag(
                        source,
                        offset,
                        "variável de resposta k6 duplicada ou conflitante",
                    ));
                }
                let Some(init) = &variable.init else {
                    diagnostics.push(diag(
                        source,
                        offset,
                        "variável de resposta k6 exige request estática",
                    ));
                    continue;
                };
                if variables.kind == VariableDeclarationKind::Const
                    && !matches!(init, Expression::CallExpression(call) if matches!(&call.callee,
                        Expression::StaticMemberExpression(member) if identifier(&member.object) == Some("http")))
                {
                    match resolver.resolve(init) {
                        Ok(value) => {
                            resolver.values.insert(name, value);
                        }
                        Err(message) => {
                            diagnostics.push(diag(source, init.span().start as usize, message))
                        }
                    }
                    continue;
                }
                (init, Some(name))
            }
            _ => {
                diagnostics.push(diag(source, offset, "statement k6 não suportado; controle de fluxo e helpers exigem tradução explícita"));
                continue;
            }
        };
        let Expression::CallExpression(call) = expression else {
            diagnostics.push(diag(
                source,
                offset,
                "efeito k6 exige chamada estática direta",
            ));
            continue;
        };
        let callee = match &call.callee {
            Expression::Identifier(id) => {
                let name = id.name.as_str();
                (bindings.get(name).map(String::as_str) == Some("k6")
                    && matches!(name, "sleep" | "check"))
                .then(|| name.to_string())
            }
            Expression::StaticMemberExpression(member) => {
                let object = identifier(&member.object).unwrap_or_default();
                let method = member.property.name.as_str();
                let supported = (object == "http"
                    && bindings.contains_key("http")
                    && matches!(
                        method,
                        "get" | "post" | "put" | "patch" | "del" | "head" | "options" | "request"
                    ))
                    || (method == "add"
                        && syntax
                            .metrics
                            .iter()
                            .any(|metric| metric.variable == object));
                (supported && !member.optional).then(|| format!("{object}.{method}"))
            }
            _ => None,
        };
        let Some(callee) = callee.filter(|callee| {
            !call.optional && (response_name.is_none() || callee.starts_with("http."))
        }) else {
            diagnostics.push(diag(
                source,
                offset,
                "chamada, alias ou helper k6 não suportado",
            ));
            continue;
        };
        if (callee == "check" && call.arguments.len() != 2)
            || (callee == "sleep" && call.arguments.len() != 1)
            || (callee.ends_with(".add") && !(1..=2).contains(&call.arguments.len()))
        {
            diagnostics.push(diag(
                source,
                offset,
                "argumentos extras ou ausentes na chamada k6",
            ));
            continue;
        }
        let arguments = if callee == "check" {
            let valid = matches!(call.arguments.as_slice(), [Argument::Identifier(_), Argument::ObjectExpression(object)]
            if object.properties.len() == 1 && object.properties.iter().all(|property| {
                matches!(property, ObjectPropertyKind::ObjectProperty(property)
                    if !property.computed && !property.method && !property.shorthand
                        && static_key(source, &property.key).is_some_and(|key| key != "__proto__")
                        && matches!(&property.value, Expression::ArrowFunctionExpression(arrow) if arrow.expression && !arrow.r#async))
            }));
            if !valid {
                diagnostics.push(diag(source, offset, "unsupported k6 check arguments"));
                continue;
            }
            Vec::new()
        } else {
            match resolver.arguments(&call.arguments) {
                Ok(arguments) => arguments,
                Err(message) => {
                    diagnostics.push(diag(source, offset, message));
                    continue;
                }
            }
        };
        let argument_offset = call
            .arguments
            .first()
            .map_or(call.span.end as usize - 1, |arg| arg.span().start as usize);
        syntax.calls.push(K6StaticCall {
            callee,
            offset: call.span.start as usize,
            argument_offset,
            response_name,
            arguments,
        });
    }
    resolver.values = global_values;
}

fn static_key<'a>(source: &str, key: &'a PropertyKey<'_>) -> Option<&'a str> {
    match key {
        PropertyKey::StaticIdentifier(id) => Some(id.name.as_str()),
        PropertyKey::StringLiteral(value)
            if plain_string(
                source,
                value.span.start as usize,
                value.span.end as usize,
                value.value.as_str(),
            ) =>
        {
            Some(value.value.as_str())
        }
        _ => None,
    }
}

fn plain_string(source: &str, start: usize, end: usize, cooked: &str) -> bool {
    source.get(start..end).is_some_and(|raw| {
        matches!(raw.as_bytes().first(), Some(b'\'' | b'"'))
            && raw.get(1..raw.len().saturating_sub(1)) == Some(cooked)
    })
}
