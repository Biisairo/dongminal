use std::fmt;

/// wsentry 의 오류. `Display` 는 Go 의 `err.Error()` 와 같다.
#[derive(Debug)]
pub enum Error {
    NotAbsolute,
    NotFound,
    NotDir,
    Unavailable,
    EmptyPath,
    /// 파일시스템 루트다. 행이 되면 파일 조작이 파일시스템 전체를 대상으로 삼는다 (D-16).
    FilesystemRoot,
    /// 홈을 얻지 못했다. 값은 문구다.
    Home(String),
    /// 메모·플러그인 자리를 만들지 못했다 (Go `*os.PathError`). 값은 문구다.
    Io(String),
    /// workspace 블롭을 풀지 못했다.
    Parse(otter_gocompat::json::Error),
    Marshal(otter_gocompat::json::Error),
    /// 저장 실패. 경합이면 `is_stale` 이다.
    Workspace(otter_shared_workspace::Error),
}

impl Error {
    /// Go `errors.Is(err, workspace.ErrStale)`.
    pub fn is_stale(&self) -> bool {
        matches!(self, Error::Workspace(e) if e.is_stale())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotAbsolute => f.write_str("경로가 절대경로가 아니다"),
            Error::NotFound => f.write_str("경로가 없다"),
            Error::NotDir => f.write_str("디렉터리가 아니다"),
            Error::Unavailable => f.write_str("workspace 를 쓸 수 없다"),
            Error::EmptyPath => f.write_str("경로가 비었다"),
            Error::FilesystemRoot => f.write_str("파일시스템 루트는 행이 될 수 없다"),
            Error::Home(s) | Error::Io(s) => f.write_str(s),
            Error::Parse(e) => write!(f, "workspace 파싱: {e}"),
            Error::Marshal(e) => write!(f, "{e}"),
            Error::Workspace(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}
