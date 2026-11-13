//! When collection scripts may run (spec 0162).
//!
//! Scripts read every variable, sensitive ones included, and the
//! pre-request script rewrites the URL and headers before interpolation. A
//! collection's scripts therefore run only when the person trusts where they
//! came from: the workspace (decided once, locally, per person) and, for an
//! imported collection, the collection itself (a mark that travels with it).

use std::collections::HashMap;

use crate::collection::Collection;

/// What this person decided about the scripts of a workspace folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceScriptTrust {
    Trusted,
    Untrusted,
    /// Never asked: the workspace had no scripts when it was opened.
    Undecided,
}

/// Why the scripts of a request were not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptsSkipReason {
    /// The workspace is not trusted (or not decided yet).
    Workspace,
    /// The collection was imported without trusting its scripts.
    Collection,
}

impl ScriptsSkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Collection => "collection",
        }
    }
}

/// Why the scripts of the saved request `request_id` must not run, or `None`
/// when they may. A request outside every collection (an unsaved tab) runs
/// its scripts: the person wrote them.
pub fn scripts_skip_reason(
    workspace: WorkspaceScriptTrust,
    collections: &[Collection],
    request_id: Option<&str>,
) -> Option<ScriptsSkipReason> {
    let request_id = request_id?;
    let collection = collections
        .iter()
        .find(|collection| collection.contains_request(request_id))?;
    collection_skip_reason(workspace, collection)
}

/// Why the scripts of a collection must not run, or `None` when they may.
pub fn collection_skip_reason(
    workspace: WorkspaceScriptTrust,
    collection: &Collection,
) -> Option<ScriptsSkipReason> {
    if workspace != WorkspaceScriptTrust::Trusted {
        return Some(ScriptsSkipReason::Workspace);
    }
    collection
        .untrusted_scripts()
        .then_some(ScriptsSkipReason::Collection)
}

/// Clears the scripts that must not run, so a runner or flow executes those
/// requests without them. Returns why each affected request lost its scripts.
pub fn withhold_untrusted_scripts(
    workspace: WorkspaceScriptTrust,
    collections: &mut [Collection],
) -> HashMap<String, ScriptsSkipReason> {
    let mut withheld = HashMap::new();
    for collection in collections {
        if let Some(reason) = collection_skip_reason(workspace, collection) {
            for id in collection.withhold_scripts() {
                withheld.insert(id, reason);
            }
        }
    }
    withheld
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Authentication, Endpoint, Folder, ProtocolId, Request, RequestDocument, SavedRequest,
    };

    fn request(id: &str, pre: &str) -> SavedRequest {
        let request = Request::new(
            Endpoint::new("https://api.example.com").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_scripts(pre, "");
        SavedRequest::new(id, id, request).unwrap()
    }

    fn collection(untrusted: bool) -> Collection {
        let folder = Folder::new("folder", "Folder", vec![], vec![request("nested", "1")]).unwrap();
        Collection::new(
            "collection",
            "API",
            vec![folder],
            vec![request("scripted", "al.x = 1"), request("plain", "  ")],
        )
        .unwrap()
        .with_untrusted_scripts(untrusted)
    }

    #[test]
    fn a_trusted_workspace_runs_scripts_of_unmarked_collections() {
        let collections = [collection(false)];
        let reason =
            scripts_skip_reason(WorkspaceScriptTrust::Trusted, &collections, Some("nested"));
        assert_eq!(reason, None);
    }

    #[test]
    fn a_marked_collection_skips_its_scripts() {
        let collections = [collection(true)];
        let reason = scripts_skip_reason(
            WorkspaceScriptTrust::Trusted,
            &collections,
            Some("scripted"),
        );
        assert_eq!(reason, Some(ScriptsSkipReason::Collection));
    }

    #[test]
    fn an_untrusted_or_undecided_workspace_skips_every_collection() {
        let collections = [collection(false)];
        for workspace in [
            WorkspaceScriptTrust::Untrusted,
            WorkspaceScriptTrust::Undecided,
        ] {
            let reason = scripts_skip_reason(workspace, &collections, Some("scripted"));
            assert_eq!(reason, Some(ScriptsSkipReason::Workspace));
        }
    }

    #[test]
    fn requests_outside_every_collection_run_their_scripts() {
        let collections = [collection(true)];
        assert_eq!(
            scripts_skip_reason(WorkspaceScriptTrust::Untrusted, &collections, None),
            None
        );
        assert_eq!(
            scripts_skip_reason(WorkspaceScriptTrust::Untrusted, &collections, Some("other")),
            None
        );
    }

    #[test]
    fn withholding_clears_scripts_and_reports_the_requests_that_had_one() {
        let mut collections = [collection(true), collection(false)];
        collections[1].id = "trusted".to_string();

        let withheld = withhold_untrusted_scripts(WorkspaceScriptTrust::Trusted, &mut collections);

        assert!(!collections[0].has_scripts());
        assert!(collections[1].has_scripts());
        let mut ids: Vec<_> = withheld.keys().cloned().collect();
        ids.sort();
        assert_eq!(ids, ["nested", "scripted"]);
        assert!(
            withheld
                .values()
                .all(|reason| *reason == ScriptsSkipReason::Collection)
        );
    }
}
