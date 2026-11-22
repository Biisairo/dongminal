use std::fmt;
use std::io;

/// 이 빌드가 도는 운영체제의 종류 (FR-XPL-4). 표시·기록용이며 분기의 근거가 아니다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OsKind {
    Darwin,
    Linux,
    Wsl,
    Windows,
}

impl OsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            OsKind::Darwin => "darwin",
            OsKind::Linux => "linux",
            OsKind::Wsl => "wsl",
            OsKind::Windows => "windows",
        }
    }
}

impl fmt::Display for OsKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// WSL2 는 osrelease 에, WSL1 은 version 에 표식을 남기므로 둘 다 본다.
const OS_RELEASE_PATH: &str = "/proc/sys/kernel/osrelease";
const PROC_VERSION_PATH: &str = "/proc/version";
const WSL_MARKER: &str = "microsoft";

/// 리눅스 빌드가 WSL 위에 있는지 가른다 (FR-XWS-1). 읽지 못한 경로는 판정을 끝내지 않는다.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_kind(read: impl Fn(&str) -> io::Result<Vec<u8>>) -> OsKind {
    for p in [OS_RELEASE_PATH, PROC_VERSION_PATH] {
        if let Ok(blob) = read(p)
            && String::from_utf8_lossy(&blob)
                .to_lowercase()
                .contains(WSL_MARKER)
        {
            return OsKind::Wsl;
        }
    }
    OsKind::Linux
}

pub(crate) fn current() -> OsKind {
    #[cfg(target_os = "linux")]
    {
        linux_kind(|p| std::fs::read(p))
    }
    #[cfg(windows)]
    {
        OsKind::Windows
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        OsKind::Darwin
    }
}

/// 이 바이너리가 빌드된 대상 — Go 의 `GOOS/GOARCH` 이름이다. 배포 애셋 이름이 이 값으로 정해진다.
pub fn build_target() -> &'static str {
    const OS: &str = match std::env::consts::OS.as_bytes() {
        b"macos" => "darwin",
        _ => std::env::consts::OS,
    };
    const ARCH: &str = match std::env::consts::ARCH.as_bytes() {
        b"x86_64" => "amd64",
        b"aarch64" => "arm64",
        b"x86" => "386",
        _ => std::env::consts::ARCH,
    };
    static TARGET: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TARGET.get_or_init(|| format!("{OS}/{ARCH}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn fake_read(
        files: HashMap<&'static str, &'static str>,
    ) -> impl Fn(&str) -> io::Result<Vec<u8>> {
        move |p| {
            files
                .get(p)
                .map(|s| s.as_bytes().to_vec())
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        }
    }

    #[test]
    fn linux_kind_cases() {
        for (name, files, want) in [
            (
                "WSL2 는 osrelease 에 microsoft 를 남긴다",
                vec![(OS_RELEASE_PATH, "5.15.153.1-microsoft-standard-WSL2\n")],
                OsKind::Wsl,
            ),
            (
                "WSL1 은 version 에만 남기기도 한다",
                vec![(
                    PROC_VERSION_PATH,
                    "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)\n",
                )],
                OsKind::Wsl,
            ),
            (
                "대소문자는 판정을 바꾸지 않는다",
                vec![(OS_RELEASE_PATH, "5.10.0-MICROSOFT-standard\n")],
                OsKind::Wsl,
            ),
            (
                "순수 리눅스",
                vec![
                    (OS_RELEASE_PATH, "6.8.0-45-generic\n"),
                    (
                        PROC_VERSION_PATH,
                        "Linux version 6.8.0-45-generic (buildd@lcy02)\n",
                    ),
                ],
                OsKind::Linux,
            ),
            ("읽을 수 없으면 리눅스다", vec![], OsKind::Linux),
        ] {
            assert_eq!(
                linux_kind(fake_read(files.into_iter().collect())),
                want,
                "{name}"
            );
        }
    }

    #[test]
    fn linux_kind_falls_through_read_error() {
        let read = |p: &str| {
            if p == OS_RELEASE_PATH {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                Ok(b"Linux version 5.15.153.1-microsoft-standard-WSL2".to_vec())
            }
        };
        assert_eq!(linux_kind(read), OsKind::Wsl);
    }

    #[test]
    fn names() {
        assert_eq!(OsKind::Wsl.to_string(), "wsl");
        assert_eq!(OsKind::Darwin.as_str(), "darwin");
    }

    #[test]
    fn build_target_is_go_names() {
        let t = build_target();
        let (os, arch) = t.split_once('/').unwrap();
        assert!(["darwin", "linux", "windows"].contains(&os), "{t}");
        assert!(["amd64", "arm64"].contains(&arch), "{t}");
    }
}
