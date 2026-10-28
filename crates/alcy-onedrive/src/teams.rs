//! Team catalog (spec 0133): a team's workspaces are the subfolders of
//! `Alcy/` in the team's document library. Who sees them is decided by
//! SharePoint's permission on that library; Alcy keeps no membership of its
//! own.

use alcy_app::RemoteError;
use reqwest::StatusCode;
use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use serde_json::json;
use thiserror::Error;

use crate::client::{
    DriveFolder, GraphItem, ITEM_SELECT, OnedriveSession, check, parse_json, segment, to_folder,
};

/// Folder that holds the workspaces in each team's library.
pub const CATALOG_FOLDER: &str = "Alcy";
const MAX_FOLDER_NAME_CHARS: usize = 100;
/// Teams are listed a page at a time; a user rarely has more than this.
const MAX_TEAM_PAGES: usize = 10;
/// Characters SharePoint refuses in file and folder names.
const INVALID_NAME_CHARS: [char; 9] = ['"', '*', ':', '<', '>', '?', '/', '\\', '|'];

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FolderNameError {
    #[error("informe o nome do workspace")]
    Empty,
    #[error("o nome do workspace passa de 100 caracteres")]
    TooLong,
    #[error("o nome não pode conter \" * : < > ? / \\ | nem terminar com ponto")]
    InvalidCharacters,
}

/// Trims and checks a new workspace folder name against SharePoint's rules
/// before any request.
pub fn validate_folder_name(name: &str) -> Result<String, FolderNameError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(FolderNameError::Empty);
    }
    if name.chars().count() > MAX_FOLDER_NAME_CHARS {
        return Err(FolderNameError::TooLong);
    }
    let invalid = name.contains(INVALID_NAME_CHARS)
        || name.ends_with('.')
        || name.starts_with("~$")
        || name.contains("_vti_");
    if invalid {
        return Err(FolderNameError::InvalidCharacters);
    }
    Ok(name.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Team {
    pub id: String,
    pub name: String,
}

/// A team's document library and its `Alcy/` folder (`None` while nobody
/// published a workspace there).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamCatalog {
    pub drive_id: String,
    pub folder: Option<DriveFolder>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphTeam {
    id: String,
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct TeamPage {
    value: Vec<GraphTeam>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Deserialize)]
struct Drive {
    id: String,
}

impl OnedriveSession<'_> {
    /// Teams the account belongs to, by name.
    pub async fn list_teams(&self) -> Result<Vec<Team>, RemoteError> {
        let graph_prefix = format!("{}/", self.client.graph_url(""));
        let mut url = self
            .client
            .graph_url("/me/joinedTeams?$select=id,displayName");
        let mut teams = Vec::new();
        for _ in 0..MAX_TEAM_PAGES {
            let response = self
                .send(|client, token| client.get(&url).bearer_auth(token))
                .await?;
            if response.status() == StatusCode::FORBIDDEN {
                return Err(RemoteError::Rejected(
                    "sem permissão para listar os times; entre novamente na conta ou peça ao \
                     administrador para aprovar o acesso aos times"
                        .into(),
                ));
            }
            let page: TeamPage = parse_json(check(response).await?).await?;
            teams.extend(page.value.into_iter().map(|team| Team {
                name: team.display_name.unwrap_or_else(|| team.id.clone()),
                id: team.id,
            }));
            match page.next_link {
                // Never send the token outside Graph.
                Some(next) if next.starts_with(&graph_prefix) => url = next,
                _ => break,
            }
        }
        teams.sort_by_key(|team| team.name.to_lowercase());
        Ok(teams)
    }

    /// The team's library and its catalog folder, if it exists.
    pub async fn team_catalog(&self, team_id: &str) -> Result<TeamCatalog, RemoteError> {
        let drive_id = self.team_drive(team_id).await?;
        let folder = self.catalog_folder(&drive_id).await?;
        Ok(TeamCatalog { drive_id, folder })
    }

    /// Creates `Alcy/<name>` in the team's library (and `Alcy/` itself when
    /// missing). A name already taken is a `Conflict`, never an overwrite.
    pub async fn create_team_workspace(
        &self,
        team_id: &str,
        name: &str,
    ) -> Result<DriveFolder, RemoteError> {
        let name =
            validate_folder_name(name).map_err(|error| RemoteError::Rejected(error.to_string()))?;
        let drive_id = self.team_drive(team_id).await?;
        let catalog = match self.catalog_folder(&drive_id).await? {
            Some(folder) => folder,
            None => {
                let root = self
                    .client
                    .graph_url(&format!("/drives/{}/root/children", segment(&drive_id)));
                match self.create_folder(&root, CATALOG_FOLDER, &drive_id).await {
                    Ok(folder) => folder,
                    // Someone else created it meanwhile.
                    Err(RemoteError::Conflict) => self
                        .catalog_folder(&drive_id)
                        .await?
                        .ok_or_else(|| RemoteError::NotFound(CATALOG_FOLDER.into()))?,
                    Err(error) => return Err(error),
                }
            }
        };
        let children = self.client.graph_url(&format!(
            "/drives/{}/items/{}/children",
            segment(&drive_id),
            segment(&catalog.id)
        ));
        self.create_folder(&children, &name, &drive_id).await
    }

    async fn team_drive(&self, team_id: &str) -> Result<String, RemoteError> {
        let url = self
            .client
            .graph_url(&format!("/groups/{}/drive", segment(team_id)));
        let drive: Drive = self.get_json(&url, "id").await?;
        Ok(drive.id)
    }

    async fn catalog_folder(&self, drive_id: &str) -> Result<Option<DriveFolder>, RemoteError> {
        let url = self.client.graph_url(&format!(
            "/drives/{}/root:/{CATALOG_FOLDER}:",
            segment(drive_id)
        ));
        let response = self
            .send(|client, token| {
                client
                    .get(&url)
                    .query(&[("$select", ITEM_SELECT)])
                    .bearer_auth(token)
            })
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let item: GraphItem = parse_json(check(response).await?).await?;
        to_folder(item, Some(drive_id)).map(Some).ok_or_else(|| {
            RemoteError::Rejected(format!(
                "\"{CATALOG_FOLDER}\" existe na biblioteca do time, mas não é uma pasta"
            ))
        })
    }

    async fn create_folder(
        &self,
        children_url: &str,
        name: &str,
        drive_id: &str,
    ) -> Result<DriveFolder, RemoteError> {
        let body = json!({
            "name": name,
            "folder": {},
            "@microsoft.graph.conflictBehavior": "fail",
        })
        .to_string();
        let response = self
            .send(|client, token| {
                client
                    .post(children_url)
                    .query(&[("$select", ITEM_SELECT)])
                    .bearer_auth(token)
                    .header(CONTENT_TYPE, "application/json")
                    .body(body.clone())
            })
            .await?;
        let item: GraphItem = parse_json(check(response).await?).await?;
        to_folder(item, Some(drive_id))
            .ok_or_else(|| RemoteError::Rejected("a pasta criada não foi reconhecida".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::tests::{account, logged_in};
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn validates_sharepoint_folder_names() {
        assert_eq!(
            validate_folder_name("  API Pagamentos ").unwrap(),
            "API Pagamentos"
        );
        assert_eq!(validate_folder_name(" "), Err(FolderNameError::Empty));
        assert_eq!(
            validate_folder_name(&"a".repeat(101)),
            Err(FolderNameError::TooLong)
        );
        for invalid in ["a/b", "a:b", "nome.", "~$temp", "x_vti_y", "a|b"] {
            assert_eq!(
                validate_folder_name(invalid),
                Err(FolderNameError::InvalidCharacters),
                "{invalid}"
            );
        }
    }

    async fn mount_drive(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path("/groups/T1/drive"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "b!team" })),
            )
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn lists_joined_teams_sorted_by_name() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/me/joinedTeams"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "value": [
                    { "id": "T2", "displayName": "Pagamentos" },
                    { "id": "T1", "displayName": "API" }
                ]
            })))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let teams = client
            .session(&account, &credentials)
            .list_teams()
            .await
            .unwrap();

        assert_eq!(
            teams,
            vec![
                Team {
                    id: "T1".into(),
                    name: "API".into()
                },
                Team {
                    id: "T2".into(),
                    name: "Pagamentos".into()
                },
            ]
        );
    }

    #[tokio::test]
    async fn missing_team_consent_asks_to_sign_in_again() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/me/joinedTeams"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let error = client
            .session(&account, &credentials)
            .list_teams()
            .await
            .unwrap_err();
        assert!(
            matches!(error, RemoteError::Rejected(message) if message.contains("entre novamente"))
        );
    }

    #[tokio::test]
    async fn catalog_is_empty_when_the_team_has_no_alcy_folder() {
        let server = MockServer::start().await;
        mount_drive(&server).await;
        Mock::given(method("GET"))
            .and(path("/drives/b!team/root:/Alcy:"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let catalog = client
            .session(&account, &credentials)
            .team_catalog("T1")
            .await
            .unwrap();
        assert_eq!(
            catalog,
            TeamCatalog {
                drive_id: "b!team".into(),
                folder: None
            }
        );
    }

    #[tokio::test]
    async fn creates_the_catalog_and_the_workspace_folder() {
        let server = MockServer::start().await;
        mount_drive(&server).await;
        Mock::given(method("GET"))
            .and(path("/drives/b!team/root:/Alcy:"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/drives/b!team/root/children"))
            .and(body_string_contains("\"name\":\"Alcy\""))
            .and(body_string_contains("\"fail\""))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": "CAT", "name": "Alcy", "folder": {},
                "parentReference": { "driveId": "b!team", "path": "/drive/root:" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/drives/b!team/items/CAT/children"))
            .and(body_string_contains("\"name\":\"API Pagamentos\""))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": "W1", "name": "API Pagamentos", "folder": {},
                "parentReference": { "driveId": "b!team", "path": "/drive/root:/Alcy" }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let folder = client
            .session(&account, &credentials)
            .create_team_workspace("T1", " API Pagamentos ")
            .await
            .unwrap();

        assert_eq!(folder.id, "W1");
        assert_eq!(folder.drive_id, "b!team");
        assert_eq!(folder.path, "/Alcy/API Pagamentos");
    }

    #[tokio::test]
    async fn taken_names_are_conflicts() {
        let server = MockServer::start().await;
        mount_drive(&server).await;
        Mock::given(method("GET"))
            .and(path("/drives/b!team/root:/Alcy:"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "CAT", "name": "Alcy", "folder": {},
                "parentReference": { "driveId": "b!team", "path": "/drive/root:" }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/drives/b!team/items/CAT/children"))
            .respond_with(ResponseTemplate::new(409))
            .mount(&server)
            .await;

        let (client, credentials) = logged_in(&server).await;
        let account = account();
        let session = client.session(&account, &credentials);
        assert_eq!(
            session.create_team_workspace("T1", "API").await,
            Err(RemoteError::Conflict)
        );
        assert!(matches!(
            session.create_team_workspace("T1", "a/b").await,
            Err(RemoteError::Rejected(_))
        ));
    }
}
