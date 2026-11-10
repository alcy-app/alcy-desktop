//! The only place Alcy runs a process: the system's `git`, for the
//! operations that talk to a remote (clone, fetch, push) and for editing the
//! remote's URL (ADR 0074). Everything else stays in-process with `gix`.
//!
//! Running the installed git means the person's own setup applies: SSH keys
//! and agent, credential managers, proxies, certificates. Alcy never sees or
//! stores a credential. Guards:
//!
//! - arguments are passed as a vector, never through a shell;
//! - the `ext::` and `fd::` transports, which run commands or use inherited
//!   file descriptors, are refused in the URL and disabled by configuration;
//! - no terminal prompt (`GIT_TERMINAL_PROMPT=0`, stdin closed): a missing
//!   credential fails instead of hanging; graphical credential managers
//!   still work;
//! - dropping the future kills the process (cancellation, invariant 7).

use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;

use alcy_app::RemoteError;

use crate::GitError;

/// Configuration passed to every invocation.
const SAFE_CONFIG: [&str; 4] = [
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.fd.allow=never",
];

/// Longest error excerpt kept from git's output.
const MAX_MESSAGE: usize = 400;

/// Runs `git <args>` in `dir` and returns its standard output.
pub(crate) async fn git(dir: Option<&Path>, args: &[OsString]) -> Result<String, GitError> {
    let mut command = tokio::process::Command::new("git");
    command
        .args(SAFE_CONFIG)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        // English output, so failures can be told apart.
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = dir {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: no console window flashing over the app.
        command.creation_flags(0x0800_0000);
    }
    let output = match command.output().await {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(GitError::GitMissing);
        }
        Err(error) => return Err(GitError::Command(error.to_string())),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() {
        return Ok(stdout.into_owned());
    }
    // `push --porcelain` reports why each ref was refused on standard output.
    if refused_by_remote_folder(&stdout.to_lowercase()) {
        return Err(GitError::RemoteFolderBusy);
    }
    Err(classify(&String::from_utf8_lossy(&output.stderr)))
}

/// Refusals from a folder whose checked-out branch would change under its
/// working files. `text` is lowercase.
fn refused_by_remote_folder(text: &str) -> bool {
    [
        "branch is currently checked out",
        "refusing to update checked out branch",
        "working directory has",
        "could not refresh index",
        "could not update working tree",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// What `safe.directory` needs for a folder git refused over its ownership:
/// the value git itself suggests, which accounts for how it spells the path
/// on each platform (`%(prefix)///server/share` on a Windows share).
fn untrusted_folder(stderr: &str) -> Option<String> {
    let suggested = stderr
        .lines()
        .find_map(|line| line.split_once("--add safe.directory "))?
        .1
        .trim();
    let path = suggested
        .strip_prefix('\'')
        .and_then(|path| path.strip_suffix('\''))
        .map_or_else(|| suggested.to_string(), |path| path.replace("'\\''", "'"));
    (!path.is_empty()).then_some(path)
}

/// Turns git's error output into a structured failure.
pub(crate) fn classify(stderr: &str) -> GitError {
    let lower = stderr.to_lowercase();
    let message = excerpt(stderr);
    let any = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    if lower.contains("dubious ownership")
        && let Some(path) = untrusted_folder(stderr)
    {
        GitError::UntrustedFolder(path)
    } else if refused_by_remote_folder(&lower) {
        // Before `PushRejected`: pulling would not help here.
        GitError::RemoteFolderBusy
    } else if any(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "permission denied (publickey",
        "access denied",
        "invalid username or password",
        "http basic",
        "the requested url returned error: 401",
        "the requested url returned error: 403",
    ]) {
        GitError::Auth(message)
    } else if any(&[
        "[rejected]",
        "non-fast-forward",
        "fetch first",
        "failed to push some refs",
    ]) {
        GitError::PushRejected
    } else if any(&[
        "could not resolve host",
        "could not resolve hostname",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "network is unreachable",
        "failed to connect",
        "unable to access",
    ]) {
        GitError::Remote(RemoteError::Network(message))
    } else {
        GitError::Command(message)
    }
}

/// The meaningful lines of git's output, without hints, shortened.
fn excerpt(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("hint:"))
        .map(|line| {
            line.strip_prefix("fatal: ")
                .or_else(|| line.strip_prefix("error: "))
                .unwrap_or(line)
        })
        .collect();
    let joined = lines.join(" ");
    if joined.chars().count() <= MAX_MESSAGE {
        joined
    } else {
        let cut: String = joined.chars().take(MAX_MESSAGE).collect();
        format!("{cut}…")
    }
}

/// A remote URL as typed: HTTPS, SSH (`user@host:path`), `file://` or a
/// folder path. Refuses what git would read as an option or a command.
pub fn validate_remote_url(url: &str) -> Result<String, GitError> {
    let url = url.trim();
    let invalid = || GitError::InvalidRemote(url.to_string());
    if url.is_empty() || url.starts_with('-') || url.chars().any(char::is_control) {
        return Err(invalid());
    }
    let lower = url.to_lowercase();
    if lower.starts_with("ext::") || lower.starts_with("fd::") {
        return Err(invalid());
    }
    Ok(url.to_string())
}

/// A `safe.directory` value that names one folder: never the `*` that trusts
/// every repository on the computer, nor something git would read as an
/// option.
pub(crate) fn validate_trusted_folder(path: &str) -> Result<&str, GitError> {
    let path = path.trim();
    if path.is_empty() || path == "*" || path.starts_with('-') || path.chars().any(char::is_control)
    {
        return Err(GitError::InvalidRemote(path.to_string()));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_failures_apart() {
        assert!(matches!(
            classify("fatal: Authentication failed for 'https://example.com/r.git/'"),
            GitError::Auth(message) if message == "Authentication failed for 'https://example.com/r.git/'"
        ));
        assert!(matches!(
            classify(
                "fatal: could not read Username for 'https://example.com': terminal prompts disabled"
            ),
            GitError::Auth(_)
        ));
        assert!(matches!(
            classify(
                "git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository."
            ),
            GitError::Auth(_)
        ));
        assert_eq!(
            classify(
                " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/tmp/o'\nhint: Updates were rejected"
            ),
            GitError::PushRejected
        );
        assert!(matches!(
            classify(
                "fatal: unable to access 'https://nowhere.invalid/': Could not resolve host: nowhere.invalid"
            ),
            GitError::Remote(RemoteError::Network(_))
        ));
        assert_eq!(
            classify("fatal: '/tmp/x' does not appear to be a git repository\nhint: check it"),
            GitError::Command("'/tmp/x' does not appear to be a git repository".to_string())
        );
        let long = "x".repeat(MAX_MESSAGE * 2);
        let GitError::Command(message) = classify(&long) else {
            panic!("expected a command failure");
        };
        assert_eq!(message.chars().count(), MAX_MESSAGE + 1);
    }

    #[test]
    fn a_folder_owned_by_someone_else_reports_what_to_trust() {
        let report = |path: &str, suggested: &str| {
            format!(
                "fatal: detected dubious ownership in repository at '{path}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory {suggested}\nfatal: Could not read from remote repository.\n"
            )
        };
        assert_eq!(
            classify(&report("/srv/team/.git", "/srv/team/.git")),
            GitError::UntrustedFolder("/srv/team/.git".to_string())
        );
        assert_eq!(
            classify(&report(
                "//server/share/api/.git",
                "%(prefix)///server/share/api/.git"
            )),
            GitError::UntrustedFolder("%(prefix)///server/share/api/.git".to_string())
        );
        assert_eq!(
            classify(&report("/srv/o time/.git", "'/srv/o time/.git'")),
            GitError::UntrustedFolder("/srv/o time/.git".to_string())
        );
        assert_eq!(
            classify(&report("/srv/d'agua/.git", r"'/srv/d'\''agua/.git'")),
            GitError::UntrustedFolder("/srv/d'agua/.git".to_string())
        );
        // Without the suggestion there is nothing precise to trust.
        assert!(matches!(
            classify("fatal: detected dubious ownership in repository at '/srv/team'"),
            GitError::Command(_)
        ));
    }

    #[test]
    fn a_refusing_remote_folder_is_not_a_request_to_pull() {
        for stderr in [
            "remote: error: refusing to update checked out branch: refs/heads/main\nerror: failed to push some refs to '/srv/team'",
            " ! [remote rejected] main -> main (branch is currently checked out)\nerror: failed to push some refs to '/srv/team'",
            " ! [remote rejected] main -> main (Working directory has unstaged changes)\nerror: failed to push some refs to '/srv/team'",
        ] {
            assert_eq!(classify(stderr), GitError::RemoteFolderBusy, "{stderr}");
        }
    }

    #[test]
    fn only_a_specific_folder_can_be_trusted() {
        for path in [
            "/srv/team/.git",
            "%(prefix)///server/share/api/.git",
            "C:/repos/api",
        ] {
            assert_eq!(validate_trusted_folder(&format!(" {path} ")).unwrap(), path);
        }
        for path in ["", "  ", "*", " * ", "--global", "/srv/\nteam"] {
            assert!(validate_trusted_folder(path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn remote_urls_cannot_smuggle_options_or_commands() {
        for url in [
            "https://example.com/team/api.git",
            "git@example.com:team/api.git",
            "ssh://git@example.com/team/api.git",
            "file:///srv/git/api.git",
            "/srv/git/api.git",
            r"\\server\share\api.git",
            r"C:\repos\api.git",
        ] {
            assert_eq!(validate_remote_url(&format!(" {url} ")).unwrap(), url);
        }
        for url in [
            "",
            "  ",
            "--upload-pack=touch /tmp/x",
            "ext::sh -c touch% /tmp/x",
            "EXT::sh",
            "fd::3",
            "https://example.com/\nrepo",
        ] {
            assert!(validate_remote_url(url).is_err(), "{url:?}");
        }
    }
}
