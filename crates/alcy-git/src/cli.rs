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
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    Err(classify(&String::from_utf8_lossy(&output.stderr)))
}

/// Turns git's error output into a structured failure.
pub(crate) fn classify(stderr: &str) -> GitError {
    let lower = stderr.to_lowercase();
    let message = excerpt(stderr);
    let any = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    if any(&[
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
