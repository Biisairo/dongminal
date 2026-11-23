//! OS 마다 갈리는 규칙 (FR-ELR-55·56·57).

/// macOS 는 대소문자를 가리지 않고, 디스크의 파일 이름이 NFD 다.
#[cfg(target_os = "macos")]
pub const FS_CASE_SENSITIVE: bool = false;
#[cfg(target_os = "macos")]
pub const FS_NFC: bool = true;
#[cfg(target_os = "linux")]
pub const FS_CASE_SENSITIVE: bool = true;
#[cfg(target_os = "linux")]
pub const FS_NFC: bool = false;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub const FS_CASE_SENSITIVE: bool = false;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub const FS_NFC: bool = false;

/// kqueue 백엔드에서 감시할 디렉터리의 항목 상한. kqueue 는 파일마다 fd 를 연다.
pub const KQUEUE_ENTRIES_MAX: usize = 4096;
const NETWORK_VOLUME_PREFIX: &str = "/Volumes/";

/// macOS 의 `/Volumes/` 아래는 네트워크 공유일 수 있어 감시하지 않는다 (VS Code `nodejsWatcherLib.ts`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn on_network_volume(p: &str) -> bool {
    cfg!(target_os = "macos") && p.starts_with(NETWORK_VOLUME_PREFIX)
}

/// 감시를 걸어도 되는 디렉터리인가 (FR-ELR-55).
/// - kqueue: 네트워크 볼륨이 아니고 항목이 상한 이하.
/// - inotify: 언제나 참.
/// - Windows: 언제나 거짓 — 감시 핸들이 디렉터리와 조상의 이름 변경·이동을 막는다 (D-8).
pub fn watchable(real: &str) -> bool {
    if cfg!(windows) {
        return false;
    }
    if !cfg!(any(
        target_os = "macos",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    )) {
        return true;
    }
    if on_network_volume(real) {
        return false;
    }
    match std::fs::read_dir(real) {
        Ok(rd) => rd.take(KQUEUE_ENTRIES_MAX + 1).count() <= KQUEUE_ENTRIES_MAX,
        Err(_) => false,
    }
}
