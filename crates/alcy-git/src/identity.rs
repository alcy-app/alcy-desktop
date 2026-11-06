/// `user.name` and `user.email` as git itself would read them outside any
/// repository: system, global (`~/.gitconfig`) and XDG configuration.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SystemIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Reads the identity without running the git binary; missing or unreadable
/// configuration just means no identity.
pub fn system_identity() -> SystemIdentity {
    match gix::config(None, &gix::open::Options::default()) {
        Ok(config) => identity_from(&config),
        Err(_) => SystemIdentity::default(),
    }
}

fn identity_from(config: &gix::config::File) -> SystemIdentity {
    let value = |key: &str| {
        config
            .string(key)
            .map(|value| value.to_string().trim().to_string())
            .filter(|value| !value.is_empty())
    };
    SystemIdentity {
        name: value("user.name"),
        email: value("user.email"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn reads_user_name_and_email() {
        let config =
            gix::config::File::from_str("[user]\n\tname = Ana Lima\n\temail = ana@example.com\n")
                .unwrap();
        assert_eq!(
            identity_from(&config),
            SystemIdentity {
                name: Some("Ana Lima".to_string()),
                email: Some("ana@example.com".to_string()),
            }
        );

        let partial = gix::config::File::from_str("[user]\n\tname = \n").unwrap();
        assert_eq!(identity_from(&partial), SystemIdentity::default());
    }
}
