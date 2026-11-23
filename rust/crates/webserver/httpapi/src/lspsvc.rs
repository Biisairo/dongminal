//! 코드 탐색의 접합면 (Go `deps.go` 의 `LSPService`). httpapi 는 LSP 프로토콜도 언어 서버
//! 프로세스도 알지 않는다 (EDITOR_LSP_SRS D-4). 5.5.6 이 쓰는 메서드만 있다 — `/api/lsp/*`
//! 를 옮기는 하위 이슈(5.5.9)가 나머지를 더한다.

use dm_webserver_domain_lsp::FileEvent;

pub trait LspService: Send + Sync {
    /// 열린 통로에 열리지 않은 파일의 변경을 끼워 넣는다 (CODEMIRROR_MIGRATION_SRS FR-CMR-110).
    /// 통로의 줄에 넣을 뿐 기다리지 않는다.
    fn notify_files(&self, events: Vec<FileEvent>);
}
