//! Anthropic OAuth API 클라이언트. 토큰은 헤더로만 보내고 어디에도 남기지 않는다.

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use dm_gocompat::json;
use dm_gocompat::strconv::quote;
use futures_util::future::BoxFuture;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;

use crate::error::{Error, HttpStatusError, Sentinel};

/// Anthropic API 주소다. 시험은 가짜 서버로 바꾼다.
pub const DEFAULT_API_BASE: &str = "https://api.anthropic.com";
/// OAuth 토큰 엔드포인트의 주소다.
pub const DEFAULT_TOKEN_BASE: &str = "https://platform.claude.com";

const PROFILE_PATH: &str = "/api/oauth/profile";
const PROFILE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_API_BODY: usize = 1 << 20;

const TOKEN_PATH: &str = "/v1/oauth/token";
/// Claude Code 의 공개 OAuth 클라이언트 식별자다. 비밀이 아니다.
pub(crate) const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_TIMEOUT: Duration = Duration::from_secs(10);

const USAGE_PATH: &str = "/api/oauth/usage";
const USAGE_BETA: &str = "oauth-2025-04-20";
const USAGE_TIMEOUT: Duration = Duration::from_secs(5);

const CLAIM_TIMEOUT: Duration = Duration::from_secs(25);

const ERR_PROFILE_SHAPE: &str = "profile 응답에 account.uuid 가 없습니다";
const ERR_TOKEN_SHAPE: &str = "token 응답을 읽을 수 없습니다";
const DEADLINE_EXCEEDED: &str = "context deadline exceeded";

/// Go `url.PathEscape` 가 남기는 글자: 영숫자와 `-_.~$&+:=@`.
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~')
    .remove(b'$')
    .remove(b'&')
    .remove(b'+')
    .remove(b':')
    .remove(b'=')
    .remove(b'@');

/// 토큰 주인이다 (FR-CAC-33).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub account_uuid: String,
    pub email: String,
    pub org_uuid: String,
}

/// 토큰의 주인을 묻는다.
pub trait ProfileLookup: Send + Sync {
    fn profile<'a>(&'a self, access_token: &'a str) -> BoxFuture<'a, Result<Identity, Error>>;
}

/// 갱신 응답이다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TokenResult {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub scopes: Vec<String>,
}

/// Anthropic OAuth API 를 부른다.
#[derive(Debug, Clone, Default)]
pub struct Client {
    /// 비면 [`DEFAULT_API_BASE`].
    pub base: String,
    /// OAuth 토큰 엔드포인트 주소다. 비면 [`DEFAULT_TOKEN_BASE`].
    pub token_base: String,
    /// 비면 공용 클라이언트(Go `http.DefaultClient`).
    pub hc: Option<reqwest::Client>,
    pub user_agent: String,
}

fn default_client() -> reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        // reqwest 의 rustls-no-provider 는 프로세스 공통 암호 공급자를 요구한다. 이미 있으면 그대로 쓴다.
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
    .clone()
}

/// 받은 응답의 상태·`Retry-After`·본문(최대 [`MAX_API_BODY`]).
struct Reply {
    status: u16,
    retry_after: String,
    body: Vec<u8>,
}

impl Client {
    fn base(&self) -> String {
        if self.base.is_empty() {
            DEFAULT_API_BASE.to_owned()
        } else {
            self.base.trim_end_matches('/').to_owned()
        }
    }

    fn token_base(&self) -> String {
        if self.token_base.is_empty() {
            DEFAULT_TOKEN_BASE.to_owned()
        } else {
            self.token_base.trim_end_matches('/').to_owned()
        }
    }

    fn client(&self) -> reqwest::Client {
        self.hc.clone().unwrap_or_else(default_client)
    }

    /// 요청 하나를 timeout 안에 보내고 본문을 읽는다. 전송 오류 문구는 Go `*url.Error` 의 꼴이다.
    async fn send(
        &self,
        method: reqwest::Method,
        url: String,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<Reply, Error> {
        let verb = if method == reqwest::Method::POST {
            "Post"
        } else {
            "Get"
        };
        let transport = |e: &dyn std::fmt::Display| Error::new(format!("{verb} {}: {e}", quote(&url)));
        let mut req = self.client().request(method, &url);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        if !self.user_agent.is_empty() {
            req = req.header(reqwest::header::USER_AGENT, &self.user_agent);
        }
        if let Some(b) = body {
            req = req.body(b);
        }
        let run = async {
            let mut res = req.send().await.map_err(|e| transport(&e))?;
            let status = res.status().as_u16();
            let retry_after = res
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let mut body = Vec::new();
            while body.len() < MAX_API_BODY {
                match res.chunk().await.map_err(|e| Error::new(e.to_string()))? {
                    Some(c) => body.extend_from_slice(&c),
                    None => break,
                }
            }
            body.truncate(MAX_API_BODY);
            Ok(Reply {
                status,
                retry_after,
                body,
            })
        };
        match tokio::time::timeout(timeout, run).await {
            Ok(r) => r,
            Err(_) => Err(transport(&DEADLINE_EXCEEDED)),
        }
    }

    /// Bearer 토큰으로 GET 해서 본문을 돌려준다. 2xx 가 아니면 본문과 함께 상태 오류다.
    async fn get(
        &self,
        path: &str,
        token: &str,
        timeout: Duration,
        extra: &[(&str, &str)],
    ) -> Result<Vec<u8>, (Vec<u8>, Error)> {
        let auth = format!("Bearer {token}");
        let mut headers = vec![
            ("Authorization", auth.as_str()),
            ("Content-Type", "application/json"),
        ];
        headers.extend_from_slice(extra);
        let r = self
            .send(
                reqwest::Method::GET,
                format!("{}{path}", self.base()),
                &headers,
                None,
                timeout,
            )
            .await
            .map_err(|e| (Vec::new(), e))?;
        status_ok(r)
    }

    /// `GET /api/oauth/profile` 이다. `account.uuid` 가 없으면 오류다.
    pub async fn profile(&self, token: &str) -> Result<Identity, Error> {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Account {
            uuid: String,
            email: String,
        }
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Org {
            uuid: String,
        }
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Body {
            account: Option<Account>,
            organization: Option<Org>,
        }
        let body = self
            .get(PROFILE_PATH, token, PROFILE_TIMEOUT, &[])
            .await
            .map_err(|(_, e)| e)?;
        let v = match json::unmarshal::<Body>(&body) {
            Ok(v) => v,
            Err(_) => return Err(Error::new(ERR_PROFILE_SHAPE)),
        };
        let Some(acc) = v.account.filter(|a| !a.uuid.trim().is_empty()) else {
            return Err(Error::new(ERR_PROFILE_SHAPE));
        };
        Ok(Identity {
            account_uuid: acc.uuid.trim().to_owned(),
            email: acc.email,
            org_uuid: v.organization.map(|o| o.uuid).unwrap_or_default(),
        })
    }

    /// refresh token 으로 새 access token 을 받는다 (FR-CAC-40). 400·401·403 이고 본문의 `error`
    /// 가 `invalid_grant`·`invalid_client` 일 때만 영구 실패([`Sentinel::ReloginRequired`])다.
    pub async fn refresh(&self, refresh_token: &str) -> Result<TokenResult, Error> {
        let req: BTreeMap<&str, &str> = BTreeMap::from([
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", OAUTH_CLIENT_ID),
        ]);
        let body = json::marshal(&req)?;
        let r = self
            .send(
                reqwest::Method::POST,
                format!("{}{TOKEN_PATH}", self.token_base()),
                &[("Content-Type", "application/json")],
                Some(body),
                REFRESH_TIMEOUT,
            )
            .await?;
        if r.status != 200 {
            if matches!(r.status, 400 | 401 | 403) {
                #[derive(Deserialize, Default)]
                #[serde(default)]
                struct E {
                    error: String,
                }
                if let Ok(e) = json::unmarshal::<E>(&r.body)
                    && (e.error == "invalid_grant" || e.error == "invalid_client")
                {
                    return Err(Error::tagged(
                        Sentinel::ReloginRequired,
                        format!("{} ({})", Sentinel::ReloginRequired.text(), e.error),
                    ));
                }
            }
            return Err(HttpStatusError {
                status: r.status,
                retry_after: r.retry_after,
            }
            .into());
        }
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct V {
            access_token: String,
            refresh_token: String,
            expires_in: i64,
            scope: String,
        }
        match json::unmarshal::<V>(&r.body) {
            Ok(v) if !v.access_token.is_empty() => Ok(TokenResult {
                access_token: v.access_token,
                refresh_token: v.refresh_token,
                expires_in: v.expires_in,
                scopes: v.scope.split_whitespace().map(str::to_owned).collect(),
            }),
            _ => Err(Error::new(ERR_TOKEN_SHAPE)),
        }
    }

    /// `GET /api/oauth/usage[?query]` 의 본문이다 (FR-CAC-51·60). 상태 오류면 본문도 함께 준다.
    pub async fn usage_raw(&self, token: &str, query: &str) -> Result<Vec<u8>, Error> {
        let mut path = USAGE_PATH.to_owned();
        if !query.is_empty() {
            path.push('?');
            path.push_str(query);
        }
        self.get(&path, token, USAGE_TIMEOUT, &[("anthropic-beta", USAGE_BETA)])
            .await
            .map_err(|(_, e)| e)
    }

    /// `POST /api/organizations/{org}/reset_rate_limits` 다 (FR-CAC-62). 25초 제한. 상태 오류여도
    /// 본문을 돌려준다.
    pub async fn claim_reset(
        &self,
        token: &str,
        org: &str,
        body: &BTreeMap<String, serde_json::Value>,
    ) -> (Vec<u8>, Result<(), Error>) {
        let b = match json::marshal(body) {
            Ok(b) => b,
            Err(e) => return (Vec::new(), Err(e.into())),
        };
        let auth = format!("Bearer {token}");
        let url = format!(
            "{}/api/organizations/{}/reset_rate_limits",
            self.base(),
            utf8_percent_encode(org, PATH_SEGMENT)
        );
        let r = self
            .send(
                reqwest::Method::POST,
                url,
                &[
                    ("Authorization", auth.as_str()),
                    ("Content-Type", "application/json"),
                ],
                Some(b),
                CLAIM_TIMEOUT,
            )
            .await;
        match r {
            Err(e) => (Vec::new(), Err(e)),
            Ok(r) => match status_ok(r) {
                Ok(b) => (b, Ok(())),
                Err((b, e)) => (b, Err(e)),
            },
        }
    }
}

fn status_ok(r: Reply) -> Result<Vec<u8>, (Vec<u8>, Error)> {
    if (200..=299).contains(&r.status) {
        return Ok(r.body);
    }
    Err((
        r.body,
        HttpStatusError {
            status: r.status,
            retry_after: r.retry_after,
        }
        .into(),
    ))
}

impl ProfileLookup for Client {
    fn profile<'a>(&'a self, access_token: &'a str) -> BoxFuture<'a, Result<Identity, Error>> {
        Box::pin(Client::profile(self, access_token))
    }
}
