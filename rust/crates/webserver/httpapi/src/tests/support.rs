//! 시험 도우미 (Go `httptest` 자리). 서버를 TCP 없이 직접 부른다.

use std::path::Path;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};

use crate::access::{AccessConfig, AccessEntry, AccessStore};
use crate::{Config, Deps, Server};

/// 응답 하나를 읽어 둔 것이다.
pub(crate) struct Resp {
    pub(crate) status: u16,
    pub(crate) headers: http::HeaderMap,
    pub(crate) body: String,
}

impl Resp {
    pub(crate) fn header(&self, k: &str) -> String {
        self.headers
            .get(k)
            .map(|v| v.to_str().unwrap_or_default().to_owned())
            .unwrap_or_default()
    }

    pub(crate) fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

/// 기본 Host 다 (Go httptest 서버의 주소 모양).
pub(crate) const TEST_HOST: &str = "127.0.0.1:58146";
pub(crate) const TEST_ORIGIN: &str = "http://127.0.0.1:58146";
pub(crate) const LOCAL: &str = "127.0.0.1:5000";

pub(crate) fn server(dir: &Path, deps: Deps) -> Arc<Server> {
    server_with(dir, deps, Vec::new())
}

pub(crate) fn server_with(dir: &Path, deps: Deps, allowed_hosts: Vec<String>) -> Arc<Server> {
    Server::new(
        Config {
            data_dir: dir.to_path_buf(),
            allowed_hosts,
            ..Config::default()
        },
        deps,
    )
}

/// 요청 하나. 머리의 값이 빈 문자열이면 그 머리를 지운다(`Host` 포함).
pub(crate) async fn call(
    srv: &Arc<Server>,
    method: &str,
    target: &str,
    headers: &[(&str, &str)],
    body: &str,
    remote: &str,
) -> Resp {
    let mut b = http::Request::builder().method(method).uri(target);
    let mut host_set = false;
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("host") {
            host_set = true;
        }
        if !v.is_empty() {
            b = b.header(*k, *v);
        }
    }
    if !host_set {
        b = b.header("Host", TEST_HOST);
    }
    let req = b.body(Full::new(Bytes::from(body.to_owned()))).unwrap();
    let res = srv.serve_addr(req, remote.to_owned()).await;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    Resp {
        status,
        headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    }
}

pub(crate) async fn get(srv: &Arc<Server>, target: &str) -> Resp {
    call(srv, "GET", target, &[], "", LOCAL).await
}

/// JSON POST (dmctl 처럼 Origin 없이).
pub(crate) async fn post_json(srv: &Arc<Server>, target: &str, body: &str) -> Resp {
    call(
        srv,
        "POST",
        target,
        &[("Content-Type", "application/json")],
        body,
        LOCAL,
    )
    .await
}

pub(crate) fn entry(value: &str) -> AccessEntry {
    AccessEntry {
        id: format!("e-{value}"),
        value: value.to_owned(),
        enabled: true,
    }
}

pub(crate) fn cfg(
    enabled: bool,
    entries: Vec<AccessEntry>,
    hosts: Vec<AccessEntry>,
) -> AccessConfig {
    AccessConfig {
        enabled,
        entries: Some(entries),
        hosts: Some(hosts),
    }
}

/// 해석·인터페이스 수집을 끈 저장소 (Go `newTestAccessStore`).
pub(crate) fn quiet(st: &AccessStore) {
    *st.lookup_host.write().unwrap() = Arc::new(|_: &str| Ok(Vec::new()));
    *st.interface_addrs.write().unwrap() = Arc::new(|| Ok(Vec::new()));
}

pub(crate) fn test_store(dir: &Path) -> Arc<AccessStore> {
    let st = Arc::new(AccessStore::new(dir.join("access.json")));
    quiet(&st);
    st
}
