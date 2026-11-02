//! Bounded XML decoding and JMeter's element/following-hashTree ownership.

use std::collections::HashMap;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use super::{LoadTestImportError, MAX_JMETER_XML_DEPTH, MAX_JMETER_XML_NODES, diag};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum JmeterThreadGroupKind {
    Standard,
    Setup,
    Teardown,
}

#[derive(Debug)]
pub(super) struct JmeterThreadGroup {
    pub kind: JmeterThreadGroupKind,
    pub name: String,
    pub offset: usize,
    pub properties: HashMap<String, String>,
    pub samplers: Vec<JmeterHttpSampler>,
}

#[derive(Debug)]
pub(super) struct JmeterHttpSampler {
    pub name: String,
    pub offset: usize,
    pub properties: HashMap<String, String>,
    pub arguments: Vec<JmeterHttpArgument>,
}

#[derive(Debug)]
pub(super) struct JmeterHttpArgument {
    pub properties: HashMap<String, String>,
}

/// This intermediate hierarchy stays inside the importer. The source byte,
/// element and depth budgets bound it before logical conversion can begin.
#[derive(Debug)]
struct XmlElement {
    tag: String,
    attributes: HashMap<String, String>,
    children: Vec<Self>,
    text: String,
    offset: usize,
}

fn incompatible(source: &str, offset: usize, message: impl Into<String>) -> LoadTestImportError {
    LoadTestImportError::Incompatible {
        diagnostics: vec![diag(source, offset, message)],
    }
}

fn xml_element(
    source: &str,
    offset: usize,
    element: &BytesStart<'_>,
    depth: usize,
    nodes: &mut usize,
) -> Result<XmlElement, LoadTestImportError> {
    *nodes += 1;
    if *nodes > MAX_JMETER_XML_NODES {
        return Err(incompatible(
            source,
            offset,
            format!("XML JMeter excede o limite de {MAX_JMETER_XML_NODES} elementos"),
        ));
    }
    if depth > MAX_JMETER_XML_DEPTH {
        return Err(incompatible(
            source,
            offset,
            format!("XML JMeter excede o limite de profundidade {MAX_JMETER_XML_DEPTH}"),
        ));
    }
    let tag = std::str::from_utf8(element.name().as_ref())
        .map_err(|_| incompatible(source, offset, "nome XML não está em UTF-8"))?
        .to_string();
    let mut attributes = HashMap::new();
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|error| {
            incompatible(source, offset, format!("atributo XML inválido: {error}"))
        })?;
        let name = std::str::from_utf8(attribute.key.as_ref())
            .map_err(|_| incompatible(source, offset, "nome de atributo XML inválido"))?;
        let raw = std::str::from_utf8(attribute.value.as_ref())
            .map_err(|_| incompatible(source, offset, "atributo XML não está em UTF-8"))?;
        let value = quick_xml::escape::unescape(raw).map_err(|error| {
            incompatible(source, offset, format!("entidade XML inválida: {error}"))
        })?;
        attributes.insert(name.to_string(), value.into_owned());
    }
    Ok(XmlElement {
        tag,
        attributes,
        children: Vec::new(),
        text: String::new(),
        offset,
    })
}

fn append_text(
    source: &str,
    offset: usize,
    stack: &mut [XmlElement],
    value: &str,
) -> Result<(), LoadTestImportError> {
    if let Some(parent) = stack.last_mut() {
        parent.text.push_str(value);
    } else if !value.trim().is_empty() {
        return Err(incompatible(
            source,
            offset,
            "texto fora da raiz XML JMeter",
        ));
    }
    Ok(())
}

fn finish_element(
    source: &str,
    element: XmlElement,
    stack: &mut [XmlElement],
    root: &mut Option<XmlElement>,
) -> Result<(), LoadTestImportError> {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(element);
    } else if root.is_some() {
        return Err(incompatible(
            source,
            element.offset,
            "XML JMeter possui mais de uma raiz",
        ));
    } else {
        *root = Some(element);
    }
    Ok(())
}

/// Decode the entire source first, including disabled subtrees. DTDs, unknown
/// entities and malformed XML must never be hidden by an enabled=false flag.
fn read_xml(source: &str) -> Result<XmlElement, LoadTestImportError> {
    let mut reader = Reader::from_reader(source.as_bytes());
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut stack = Vec::new();
    let mut root = None;
    let mut nodes = 0_usize;
    loop {
        let offset = reader.buffer_position() as usize;
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            incompatible(source, offset, format!("XML JMeter inválido: {error}"))
        })?;
        match event {
            Event::Eof => break,
            Event::DocType(_) => {
                return Err(incompatible(
                    source,
                    offset,
                    "DTD e entidades XML externas não são permitidas",
                ));
            }
            Event::Start(element) => {
                stack.push(xml_element(
                    source,
                    offset,
                    &element,
                    stack.len() + 1,
                    &mut nodes,
                )?);
            }
            Event::Empty(element) => {
                let element = xml_element(source, offset, &element, stack.len() + 1, &mut nodes)?;
                finish_element(source, element, &mut stack, &mut root)?;
            }
            Event::End(end) => {
                let element = stack
                    .pop()
                    .ok_or_else(|| incompatible(source, offset, "fechamento XML sem elemento"))?;
                if element.tag.as_bytes() != end.name().as_ref() {
                    return Err(incompatible(
                        source,
                        offset,
                        "fechamento XML não corresponde ao elemento",
                    ));
                }
                finish_element(source, element, &mut stack, &mut root)?;
            }
            Event::Text(text) => {
                let value = text
                    .xml10_content()
                    .map_err(|_| incompatible(source, offset, "texto XML não está em UTF-8"))?;
                append_text(source, offset, &mut stack, &value)?;
            }
            Event::CData(text) => {
                let value = text
                    .xml10_content()
                    .map_err(|_| incompatible(source, offset, "CDATA XML não está em UTF-8"))?;
                append_text(source, offset, &mut stack, &value)?;
            }
            Event::GeneralRef(reference) => {
                let raw = std::str::from_utf8(reference.as_ref())
                    .map_err(|_| incompatible(source, offset, "referência XML inválida"))?;
                let encoded = format!("&{raw};");
                let value = quick_xml::escape::unescape(&encoded).map_err(|error| {
                    incompatible(
                        source,
                        offset,
                        format!("entidade XML não permitida: {error}"),
                    )
                })?;
                append_text(source, offset, &mut stack, &value)?;
            }
            _ => {}
        }
        buffer.clear();
    }
    if !stack.is_empty() {
        return Err(incompatible(
            source,
            source.len(),
            "XML JMeter não foi fechado",
        ));
    }
    root.ok_or_else(|| incompatible(source, 0, "XML JMeter sem raiz"))
}

#[derive(Clone, Copy)]
enum TreeOwner {
    Root,
    TestPlan,
    Group(usize),
    Sampler,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PropertyScope {
    TestPlan,
    Group,
    Sampler,
    Argument,
}

#[derive(Default)]
struct PropertyValues {
    fields: HashMap<String, String>,
    arguments: Vec<JmeterHttpArgument>,
}

/// Metadata alone cannot preserve an option's effects. Accept only translated
/// fields or explicitly inert values of known options; fail closed for new ones.
fn supported_scalar(scope: PropertyScope, name: &str, value: &str) -> bool {
    let boolean = value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("false");
    let disabled = value.eq_ignore_ascii_case("false");
    let enabled = value.eq_ignore_ascii_case("true");
    if name == "TestElement.comments" {
        return true;
    }
    match scope {
        PropertyScope::TestPlan => true, // Validated separately by test_plan_properties.
        PropertyScope::Group => match name {
            "ThreadGroup.num_threads"
            | "ThreadGroup.ramp_time"
            | "ThreadGroup.scheduler"
            | "ThreadGroup.duration"
            | "ThreadGroup.delay"
            | "ThreadGroup.on_sample_error"
            | "LoopController.loops"
            | "LoopController.continue_forever" => true, // Schedule validation follows.
            "ThreadGroup.same_user_on_next_iteration" => enabled,
            "ThreadGroup.delayedStart" => disabled,
            _ => false,
        },
        PropertyScope::Sampler => match name {
            "HTTPSampler.protocol"
            | "HTTPSampler.domain"
            | "HTTPSampler.port"
            | "HTTPSampler.path"
            | "HTTPSampler.method" => true,
            "HTTPSampler.follow_redirects" | "HTTPSampler.postBodyRaw" => boolean,
            "HTTPSampler.use_keepalive" => enabled,
            "HTTPSampler.auto_redirects"
            | "HTTPSampler.image_parser"
            | "HTTPSampler.concurrentDwn"
            | "HTTPSampler.DO_MULTIPART_POST"
            | "HTTPSampler.BROWSER_COMPATIBLE_MULTIPART"
            | "HTTPSampler.monitor"
            | "HTTPSampler.md5" => disabled,
            "HTTPSampler.contentEncoding" => {
                value.is_empty() || value.eq_ignore_ascii_case("UTF-8")
            }
            "HTTPSampler.concurrentPool" => value.is_empty() || value == "6",
            "HTTPSampler.ipSourceType" => value.is_empty() || value == "0",
            "HTTPSampler.connect_timeout"
            | "HTTPSampler.response_timeout"
            | "HTTPSampler.implementation"
            | "HTTPSampler.proxyScheme"
            | "HTTPSampler.proxyHost"
            | "HTTPSampler.proxyPort"
            | "HTTPSampler.proxyUser"
            | "HTTPSampler.proxyPass"
            | "HTTPSampler.ipSource"
            | "HTTPSampler.embedded_url_re"
            | "HTTPSampler.embedded_url_exclude_re"
            | "HTTPSampler.FILE_NAME"
            | "HTTPSampler.FILE_FIELD"
            | "HTTPSampler.mimetype"
            | "HTTPSampler.CONTENT_TYPE" => value.is_empty(),
            _ => false,
        },
        PropertyScope::Argument => match name {
            "Argument.value" => true,
            "Argument.name" => value.is_empty(),
            "Argument.metadata" => value.is_empty() || value == "=",
            "HTTPArgument.always_encode" => disabled,
            "HTTPArgument.use_equals" => boolean,
            _ => false,
        },
    }
}

fn properties(
    source: &str,
    element: &XmlElement,
    scope: PropertyScope,
    result: &mut PropertyValues,
) -> Result<(), LoadTestImportError> {
    for child in &element.children {
        let property_name = child
            .attributes
            .get("name")
            .map(String::as_str)
            .unwrap_or_default();
        match child.tag.as_str() {
            "stringProp" | "boolProp" | "intProp" | "longProp" => {
                if property_name.is_empty() || !child.children.is_empty() {
                    return Err(incompatible(
                        source,
                        child.offset,
                        "propriedade JMeter exige nome e valor escalar",
                    ));
                }
                let value = if scope == PropertyScope::Argument {
                    child.text.as_str()
                } else {
                    child.text.trim()
                };
                if !matches!(property_name, "TestPlan.comments" | "TestElement.comments")
                    && value.contains("${")
                {
                    return Err(incompatible(
                        source,
                        child.offset,
                        "expressões e variáveis dinâmicas JMeter ainda não são traduzidas",
                    ));
                }
                if !matches!(property_name, "TestPlan.comments" | "TestElement.comments")
                    && value.contains("{{")
                {
                    return Err(incompatible(
                        source,
                        child.offset,
                        format!(
                            "JMeter literal contains an unrepresented native template: {property_name}"
                        ),
                    ));
                }
                if !supported_scalar(scope, property_name, value) {
                    return Err(incompatible(
                        source,
                        child.offset,
                        format!("unsupported JMeter option or value: {property_name}"),
                    ));
                }
                if result
                    .fields
                    .insert(property_name.into(), value.into())
                    .is_some()
                {
                    return Err(incompatible(
                        source,
                        child.offset,
                        format!("propriedade JMeter duplicada: {property_name}"),
                    ));
                }
            }
            "elementProp"
                if child
                    .attributes
                    .get("elementType")
                    .is_some_and(|kind| kind == "HTTPArgument") =>
            {
                if scope != PropertyScope::Sampler {
                    return Err(incompatible(
                        source,
                        child.offset,
                        "HTTPArgument precisa estar dentro de um HTTP Sampler",
                    ));
                }
                let mut argument = PropertyValues::default();
                properties(source, child, PropertyScope::Argument, &mut argument)?;
                result.arguments.push(JmeterHttpArgument {
                    properties: argument.fields,
                });
            }
            "elementProp" => {
                let kind = child
                    .attributes
                    .get("elementType")
                    .map(String::as_str)
                    .unwrap_or_default();
                let supported = (scope == PropertyScope::Group
                    && kind == "LoopController"
                    && property_name == "ThreadGroup.main_controller")
                    || (matches!(scope, PropertyScope::TestPlan | PropertyScope::Sampler)
                        && kind == "Arguments");
                if !supported {
                    return Err(incompatible(
                        source,
                        child.offset,
                        format!("elementProp JMeter não suportado: {kind}"),
                    ));
                }
                properties(source, child, scope, result)?;
            }
            "collectionProp"
                if property_name == "Arguments.arguments"
                    && matches!(scope, PropertyScope::TestPlan | PropertyScope::Sampler) =>
            {
                properties(source, child, scope, result)?;
            }
            _ => {
                return Err(incompatible(
                    source,
                    child.offset,
                    format!("elemento JMeter não suportado: {}", child.tag),
                ));
            }
        }
    }
    if !element.text.trim().is_empty() {
        return Err(incompatible(
            source,
            element.offset,
            "texto fora de propriedade escalar JMeter",
        ));
    }
    Ok(())
}

fn enabled(source: &str, element: &XmlElement) -> Result<bool, LoadTestImportError> {
    match element.attributes.get("enabled") {
        None => Ok(true),
        Some(value) if value.eq_ignore_ascii_case("true") => Ok(true),
        Some(value) if value.eq_ignore_ascii_case("false") => Ok(false),
        Some(_) => Err(incompatible(
            source,
            element.offset,
            "enabled JMeter precisa ser true ou false",
        )),
    }
}

fn test_plan_properties(source: &str, element: &XmlElement) -> Result<(), LoadTestImportError> {
    let mut values = PropertyValues::default();
    properties(source, element, PropertyScope::TestPlan, &mut values)?;
    for (name, value) in values.fields {
        let supported = match name.as_str() {
            "TestPlan.comments" | "TestElement.comments" => true,
            "TestPlan.functional_mode" | "TestPlan.serialize_threadgroups" => {
                value.eq_ignore_ascii_case("false")
            }
            "TestPlan.tearDown_on_shutdown" => {
                value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("false")
            }
            "TestPlan.user_define_classpath" => value.is_empty(),
            _ => false,
        };
        if !supported {
            return Err(incompatible(
                source,
                element.offset,
                format!("propriedade de TestPlan JMeter não suportada: {name}"),
            ));
        }
    }
    Ok(())
}

/// A test element owns the sibling hashTree after its declaration, rather
/// than XML descendants inside that declaration. Keep each ownership scope
/// until its whole logical subtree has been converted.
fn walk_tree(
    source: &str,
    tree: &XmlElement,
    owner: TreeOwner,
    groups: &mut Vec<JmeterThreadGroup>,
) -> Result<(), LoadTestImportError> {
    if tree.tag != "hashTree"
        || !tree.text.trim().is_empty()
        || !tree.children.len().is_multiple_of(2)
    {
        return Err(incompatible(
            source,
            tree.offset,
            "elemento JMeter exige um hashTree irmão seguinte",
        ));
    }
    if matches!(owner, TreeOwner::Root) && tree.children.len() != 2 {
        return Err(incompatible(
            source,
            tree.offset,
            "raiz JMeter exige um único TestPlan e seu hashTree",
        ));
    }
    for pair in tree.children.chunks_exact(2) {
        let element = &pair[0];
        let children = &pair[1];
        if element.tag == "hashTree" || children.tag != "hashTree" {
            return Err(incompatible(
                source,
                element.offset,
                "elemento JMeter exige um hashTree irmão seguinte",
            ));
        }
        if !enabled(source, element)? {
            continue;
        }
        if element
            .attributes
            .get("testclass")
            .is_some_and(|class| class != &element.tag)
        {
            return Err(incompatible(
                source,
                element.offset,
                "testclass JMeter não corresponde ao elemento suportado",
            ));
        }
        let next_owner = match (owner, element.tag.as_str()) {
            (TreeOwner::Root, "TestPlan") => {
                test_plan_properties(source, element)?;
                TreeOwner::TestPlan
            }
            (TreeOwner::TestPlan, "ThreadGroup" | "SetupThreadGroup" | "PostThreadGroup") => {
                let mut values = PropertyValues::default();
                properties(source, element, PropertyScope::Group, &mut values)?;
                let kind = match element.tag.as_str() {
                    "ThreadGroup" => JmeterThreadGroupKind::Standard,
                    "SetupThreadGroup" => JmeterThreadGroupKind::Setup,
                    _ => JmeterThreadGroupKind::Teardown,
                };
                groups.push(JmeterThreadGroup {
                    kind,
                    name: element
                        .attributes
                        .get("testname")
                        .cloned()
                        .unwrap_or_else(|| element.tag.clone()),
                    offset: element.offset,
                    properties: values.fields,
                    samplers: Vec::new(),
                });
                TreeOwner::Group(groups.len() - 1)
            }
            (TreeOwner::Group(group), "HTTPSamplerProxy") => {
                let mut values = PropertyValues::default();
                properties(source, element, PropertyScope::Sampler, &mut values)?;
                // JMeter defaults this to false. The native shared transport
                // cannot promise a fresh connection for each sampler request.
                if !values
                    .fields
                    .get("HTTPSampler.use_keepalive")
                    .is_some_and(|value| value.eq_ignore_ascii_case("true"))
                {
                    return Err(incompatible(
                        source,
                        element.offset,
                        "JMeter import requires explicit HTTPSampler.use_keepalive=true; per-request connection reset is not supported",
                    ));
                }
                groups[group].samplers.push(JmeterHttpSampler {
                    name: element
                        .attributes
                        .get("testname")
                        .cloned()
                        .unwrap_or_else(|| "HTTP Request".into()),
                    offset: element.offset,
                    properties: values.fields,
                    arguments: values.arguments,
                });
                TreeOwner::Sampler
            }
            _ => {
                return Err(incompatible(
                    source,
                    element.offset,
                    format!(
                        "elemento JMeter não suportado neste escopo: {}",
                        element.tag
                    ),
                ));
            }
        };
        walk_tree(source, children, next_owner, groups)?;
    }
    Ok(())
}

pub(super) fn parse_jmeter(source: &str) -> Result<Vec<JmeterThreadGroup>, LoadTestImportError> {
    let root = read_xml(source)?;
    if root.tag != "jmeterTestPlan"
        || !root.text.trim().is_empty()
        || root.children.len() != 1
        || root.children[0].tag != "hashTree"
    {
        return Err(incompatible(
            source,
            root.offset,
            "XML JMeter exige jmeterTestPlan com um hashTree raiz",
        ));
    }
    let mut groups = Vec::new();
    walk_tree(source, &root.children[0], TreeOwner::Root, &mut groups)?;
    Ok(groups)
}
