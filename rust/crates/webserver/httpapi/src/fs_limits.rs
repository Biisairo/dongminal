//! 탐색기(/api/fs/*)·파일 종단의 상한 표 (Go `fs_limits.go`, REFACTOR3_GO_STRUCT_SRS FR-RGS-5).

/// FS_LIST_MAX (FR-EDT-65).
pub(crate) const FS_LIST_MAX: usize = 10000;
/// 업로드 본문의 상한 (FR-FTR-5, D-6).
pub(crate) const FS_UPLOAD_MAX_BYTES: i64 = 512 << 20;

/// 서버 하나의 상한이다 (Go `serverLimits`). const 가 아닌 것은 시험이 낮춰 잡기 위해서다.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ServerLimits {
    pub(crate) fs_list: usize,
    pub(crate) upload_max_bytes: i64,
    /// `/api/file/{read,raw}` 가 내보내고 `/api/file/write` 가 받는 한 파일의 상한이다 (FR-FAB-8 ·
    /// FR-OPT-15-1). Go 는 패키지 변수 `fileReadMaxBytes` 이고 시험이 낮춘다.
    pub(crate) file_read_max: i64,
}

impl Default for ServerLimits {
    fn default() -> Self {
        ServerLimits {
            fs_list: FS_LIST_MAX,
            upload_max_bytes: FS_UPLOAD_MAX_BYTES,
            file_read_max: dm_shared_editorlimit::FILE_MAX_BYTES,
        }
    }
}
