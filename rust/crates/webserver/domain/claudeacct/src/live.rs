//! Claude Code 가 읽는 자격증명 저장소 (FR-CAC-4~6).

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use dm_shared_platform::Secrets;

use crate::creds::Credential;
use crate::error::{Error, Sentinel};
use crate::paths::ClaudePaths;
use crate::{DIR_MODE, FILE_MODE, fsutil};

const LIVE_READ_TRIES: usize = 2;
const LIVE_RETRY_DELAY: Duration = Duration::from_millis(300);

#[derive(Clone)]
pub struct LiveStore {
    pub paths: ClaudePaths,
    pub sec: Arc<dyn Secrets>,
    /// 0 이면 300ms.
    pub retry_delay: Duration,
}

impl LiveStore {
    /// ① 키체인 ② `.credentials.json` 순으로 읽는다. 둘 다 없으면 `Ok(None)` 이다.
    pub fn read(&self) -> Result<Option<Credential>, Error> {
        let mut kc_err: Option<Error> = None;
        if self.sec.available() {
            for i in 0..LIVE_READ_TRIES {
                match self
                    .sec
                    .get(&self.paths.keychain_service, &self.sec.account())
                {
                    Ok(Some(v)) => return Credential::parse(v.as_bytes()).map(Some),
                    Ok(None) => {
                        kc_err = None;
                        break;
                    }
                    Err(e) => {
                        kc_err = Some(e.into());
                        if i + 1 < LIVE_READ_TRIES {
                            thread::sleep(self.retry_delay());
                        }
                    }
                }
            }
        }
        let b = match fsutil::read_file(&self.paths.credentials) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return match kc_err {
                    Some(k) => Err(Error::with_detail(Sentinel::KeychainUnavailable, k)),
                    None => Ok(None),
                };
            }
            Err(e) => return Err(e.into()),
        };
        Credential::parse(&b).map(Some)
    }

    fn retry_delay(&self) -> Duration {
        if self.retry_delay.is_zero() {
            LIVE_RETRY_DELAY
        } else {
            self.retry_delay
        }
    }

    /// 키체인에 쓰고, `.credentials.json` 이 이미 있으면 같은 바이트로 다시 써서 실행 중인 세션이
    /// 다시 읽게 한다. 키체인 쓰기가 실패하면 파일에 쓰고 키체인 항목을 지운다 (FR-CAC-6).
    pub fn write(&self, c: &Credential) -> Result<(), Error> {
        let b = c.marshal()?;
        let s = String::from_utf8_lossy(&b);
        if self.sec.available() {
            let svc = &self.paths.keychain_service;
            if self.sec.set(svc, &self.sec.account(), &s).is_ok() {
                if fs::metadata(&self.paths.credentials).is_ok() {
                    dm_shared_platform::write_file_atomic(&self.paths.credentials, &b, FILE_MODE)?;
                }
                return Ok(());
            }
            write_secret_file(&self.paths.credentials, &b)?;
            return Ok(self.sec.delete(svc, &self.sec.account())?);
        }
        write_secret_file(&self.paths.credentials, &b)
    }
}

/// 0700 폴더 안에 0600 파일을 원자적으로 쓴다 (FR-CAC-1·2).
pub(crate) fn write_secret_file(path: &Path, b: &[u8]) -> Result<(), Error> {
    fsutil::mkdir_all(
        &path.parent().map(Path::to_path_buf).unwrap_or_default(),
        DIR_MODE,
    )?;
    Ok(dm_shared_platform::write_file_atomic(path, b, FILE_MODE)?)
}
