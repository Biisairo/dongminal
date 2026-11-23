//! 코드 탐색의 접합면 (Go `deps.go` 의 `LSPService`). httpapi 는 LSP 프로토콜도 언어 서버
//! 프로세스도 알지 않는다 (EDITOR_LSP_SRS D-4).

use std::collections::HashMap;
use std::sync::Arc;

use dm_webserver_domain_ext as ext;
use dm_webserver_domain_lsp::{FileEvent, OpenError, PathsError, Tunnel};
use futures_util::future::BoxFuture;

pub trait LspService: Send + Sync {
    /// 열린 통로에 열리지 않은 파일의 변경을 끼워 넣는다 (CODEMIRROR_MIGRATION_SRS FR-CMR-110).
    /// 통로의 줄에 넣을 뿐 기다리지 않는다.
    fn notify_files(&self, events: Vec<FileEvent>);
    /// 서버마다 한 줄의 관측과 읽지 못한 선언의 사유들이다 (FR-EXT-8). 서버가 보관한 경로 표로
    /// 해석한다.
    fn status(&self) -> (Vec<ext::Status>, Vec<String>);
    /// (루트, 서술자)의 언어 서버를 새로 띄워 통로로 낸다 (FR-CMR-101). 상한이면
    /// [`OpenError::Limit`] 다 (FR-CMR-102). 블로킹이다.
    fn open_tunnel(&self, root: &str, desc_id: &str) -> Result<Arc<dyn Tunnel>, OpenError>;
    /// 실행 파일 경로 표(팩/서버 → 절대경로)의 조회·전체 교체다.
    fn paths(&self) -> HashMap<String, String>;
    fn set_paths(
        &self,
        next: HashMap<String, String>,
    ) -> Result<HashMap<String, String>, PathsError>;
    /// **팩** 하나를 조달한다 (FR-EXT-31). 같은 것의 두 번째 요청은 거절된다 (FR-EXT-32).
    fn install<'a>(&'a self, ctx: &'a ext::Ctx, pack_id: &'a str) -> BoxFuture<'a, ext::Outcome>;
}
