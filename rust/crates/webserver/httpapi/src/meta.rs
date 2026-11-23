//! `GET /api/meta` (Go `entity_name.go` 의 `apiMeta`) — 서버가 쓰는 상한을 클라이언트에 알린다.
//! 클라이언트가 같은 상수를 따로 들지 않게 한다.

use dm_shared_httpresp::Response;
use serde::Serialize;

use crate::Server;
use crate::entity_name::ENTITY_NAME_MAX;
use crate::files_stamp::FILE_STAMPS_MAX;
use crate::fs_stamp::FS_STAMP_MAX;
use crate::fs_watch::FS_WATCH_DIRS_MAX;
use crate::httperr::write_json;
use crate::req::Req;

#[derive(Serialize)]
struct Meta {
    encodings: [&'static str; 4],
    #[serde(rename = "entityNameMax")]
    entity_name_max: usize,
    #[serde(rename = "fileStampsMax")]
    file_stamps_max: usize,
    #[serde(rename = "fsStampMax")]
    fs_stamp_max: usize,
    #[serde(rename = "fsWatchDirsMax")]
    fs_watch_dirs_max: usize,
}

impl Server {
    pub(crate) async fn api_meta(&self, _r: &mut Req) -> Response {
        write_json(&Meta {
            encodings: dm_shared_textenc::REOPEN_CHOICES,
            entity_name_max: ENTITY_NAME_MAX,
            file_stamps_max: FILE_STAMPS_MAX,
            fs_stamp_max: FS_STAMP_MAX,
            fs_watch_dirs_max: FS_WATCH_DIRS_MAX,
        })
    }
}
