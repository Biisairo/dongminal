//! Go 기준선 `otterminal/internal/webserver/httproute` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 이 서버의 라우팅표 한 벌이다 (DRIFT_RECLAIM_SRS FR-DRC-10). 표는 **첫** 매칭 라우트를
//! 고른다. Go 는 표가 핸들러를 직접 부르지만, 여기서는 고른 핸들러를 돌려주고 부르는 일은
//! 호출자가 한다. 핸들러의 모양(동기·비동기, 수신자 타입)을 표가 정하지 않게 하기 위해서다.

/// 경로 매처.
#[derive(Clone, Copy, Debug)]
pub enum Matcher {
    /// 경로가 정확히 같다.
    Exact(&'static str),
    /// 접두사 아래 전부다 (`/api/runs/<id>`).
    Under(&'static str),
    /// 접두사 아래이면서 꼬리로 끝난다 (`/api/tools/<id>/busy`).
    UnderWith(&'static str, &'static str),
    /// 그 밖의 판정.
    Func(fn(&str) -> bool),
}

impl Matcher {
    pub fn matches(&self, path: &str) -> bool {
        match *self {
            Matcher::Exact(p) => path == p,
            Matcher::Under(prefix) => path.starts_with(prefix),
            Matcher::UnderWith(prefix, suffix) => {
                path.starts_with(prefix) && path.ends_with(suffix)
            }
            Matcher::Func(f) => f(path),
        }
    }
}

/// method + 경로 매처를 핸들러에 묶는다. `method` 가 `""` 이면 아무 method 나 매칭한다.
#[derive(Clone, Debug)]
pub struct Route<H> {
    pub method: &'static str,
    pub matcher: Matcher,
    pub handle: H,
}

/// **첫** 매칭 라우트의 핸들러를 돌려준다. 없으면 `None` 이다 — 404 로 접지 않는다.
///
/// `path` 는 Go `r.URL.Path` 와 같은 값(퍼센트 디코딩한 경로)이어야 한다.
pub fn dispatch<'a, H>(routes: &'a [Route<H>], method: &str, path: &str) -> Option<&'a H> {
    routes
        .iter()
        .find(|rt| (rt.method.is_empty() || rt.method == method) && rt.matcher.matches(path))
        .map(|rt| &rt.handle)
}

pub const METHOD_GET: &str = "GET";
pub const METHOD_POST: &str = "POST";
pub const METHOD_PUT: &str = "PUT";
pub const METHOD_DELETE: &str = "DELETE";

pub fn get<H>(path: &'static str, h: H) -> Route<H> {
    at(METHOD_GET, path, h)
}

pub fn post<H>(path: &'static str, h: H) -> Route<H> {
    at(METHOD_POST, path, h)
}

pub fn put<H>(path: &'static str, h: H) -> Route<H> {
    at(METHOD_PUT, path, h)
}

pub fn delete<H>(path: &'static str, h: H) -> Route<H> {
    at(METHOD_DELETE, path, h)
}

/// method 를 가리지 않는 종단이다.
pub fn any<H>(path: &'static str, h: H) -> Route<H> {
    at("", path, h)
}

/// method 와 경로를 직접 준다.
pub fn at<H>(method: &'static str, path: &'static str, h: H) -> Route<H> {
    Route {
        method,
        matcher: Matcher::Exact(path),
        handle: h,
    }
}

/// 경로가 정확히 같지 않은 종단이다.
pub fn when<H>(method: &'static str, matcher: Matcher, h: H) -> Route<H> {
    Route {
        method,
        matcher,
        handle: h,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Vec<Route<&'static str>> {
        vec![
            get("/api/state", "state"),
            post("/api/tools", "tools-create"),
            when(METHOD_DELETE, Matcher::Under("/api/runs/"), "run-delete"),
            when(
                METHOD_POST,
                Matcher::UnderWith("/api/tools/", "/busy"),
                "tool-busy",
            ),
            any("/api/any", "any"),
            get("/api/state", "shadowed"),
            when("", Matcher::Func(|p| p.len() == 2), "func"),
        ]
    }

    #[test]
    fn first_match_wins() {
        let t = table();
        assert_eq!(dispatch(&t, "GET", "/api/state"), Some(&"state"));
    }

    #[test]
    fn method_filters() {
        let t = table();
        assert_eq!(dispatch(&t, "POST", "/api/state"), None);
        assert_eq!(dispatch(&t, "GET", "/api/tools"), None);
        assert_eq!(dispatch(&t, "POST", "/api/tools"), Some(&"tools-create"));
    }

    #[test]
    fn empty_method_matches_any() {
        let t = table();
        for m in ["GET", "POST", "PATCH"] {
            assert_eq!(dispatch(&t, m, "/api/any"), Some(&"any"));
        }
        assert_eq!(dispatch(&t, "OPTIONS", "/x"), Some(&"func"));
    }

    #[test]
    fn under_and_under_with() {
        let t = table();
        assert_eq!(dispatch(&t, "DELETE", "/api/runs/r1"), Some(&"run-delete"));
        assert_eq!(dispatch(&t, "DELETE", "/api/runs/"), Some(&"run-delete"));
        assert_eq!(dispatch(&t, "DELETE", "/api/runs"), None);
        assert_eq!(
            dispatch(&t, "POST", "/api/tools/t1/busy"),
            Some(&"tool-busy")
        );
        assert_eq!(dispatch(&t, "POST", "/api/tools/t1/idle"), None);
    }

    #[test]
    fn exact_is_exact() {
        let t = table();
        assert_eq!(dispatch(&t, "GET", "/api/state/"), None);
        assert_eq!(dispatch(&t, "GET", "/api/stat"), None);
    }
}
