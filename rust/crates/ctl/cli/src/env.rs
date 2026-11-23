//! 환경변수 읽기. 검사가 프로세스 환경을 바꾸지 않고 값을 주입할 수 있게 한 자리다.

/// 환경변수를 읽는 수단이다. 없는 변수는 빈 문자열이다 (Go `os.Getenv`).
pub(crate) struct Env<'a> {
    lookup: Option<&'a dyn Fn(&str) -> String>,
}

impl<'a> Env<'a> {
    /// 이 프로세스의 환경이다.
    pub(crate) fn process() -> Env<'static> {
        Env { lookup: None }
    }

    #[cfg(test)]
    pub(crate) fn from_fn(f: &'a dyn Fn(&str) -> String) -> Self {
        Self { lookup: Some(f) }
    }

    pub(crate) fn get(&self, key: &str) -> String {
        match self.lookup {
            Some(f) => f(key),
            None => std::env::var_os(key)
                .map(|v| v.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }
    }

    /// Go `os.UserHomeDir` 다. 문구도 같다.
    pub(crate) fn user_home_dir(&self) -> Result<String, String> {
        let (key, missing) = if cfg!(windows) {
            ("USERPROFILE", "%userprofile% is not defined")
        } else {
            ("HOME", "$HOME is not defined")
        };
        let v = self.get(key);
        if v.is_empty() {
            return Err(missing.to_owned());
        }
        Ok(v)
    }
}
