//! 겹의 스탬프 (Go `handlers_fs_stamp.go` 의 일부). `/api/fs/stamp*` 종단은 5.5.7 이 옮긴다.

use std::fs::Metadata;

use crate::files_stamp::mod_nano;

/// Go `fsStampOf`: 한 겹의 스탬프다. 문자열인 이유는 JSON 의 수가 나노초의 정밀도를 잃기
/// 때문이다. `apiFSList` 와 폴링이 같은 함수를 지난다 (FR-FSL-10).
pub(crate) fn fs_stamp_of(st: &Metadata) -> String {
    mod_nano(st).to_string()
}
