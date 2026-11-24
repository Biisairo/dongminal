use std::fs;
use std::path::{Path, PathBuf};

use crate::{Error, atoi, fsx, raw_of, set_keys};

/// 서버가 지금 리슨하는 `host:port` 한 줄을 담는 주소 파일의 자리다 (HOT_REBIND_SRS FR-HRB-10).
/// 폴더째 샌드박스에 마운트하므로 전용 폴더에 두고, 폴더는 지우지 않는다 (D-HRB-9).
pub const ADDR_DIR: &str = "run";
pub const ADDR_FILE_NAME: &str = "server.addr";

/// 홈의 주소 파일 경로다.
pub fn addr_path(home: &Path) -> PathBuf {
    home.join(ADDR_DIR).join(ADDR_FILE_NAME)
}

/// 바인드를 `server.json` 에 쓴다 (FR-HRB-3). 빈 값은 그 키를 건드리지 않는다.
pub fn set_bind(home: &Path, host: &str, port: &str) -> Result<(), Error> {
    let mut kv = Vec::new();
    if !host.is_empty() {
        kv.push(("host", raw_of(host)));
    }
    if !port.is_empty() {
        kv.push(("port", raw_of(port)));
    }
    if kv.is_empty() {
        return Ok(());
    }
    set_keys(home, &kv)
}

/// 홈의 주소 파일을 읽는다 (FR-HRB-7·12). 없거나 틀리면 `None` 이다.
pub fn read_addr(home: &Path) -> Option<(String, String)> {
    if home.as_os_str().is_empty() {
        return None;
    }
    read_addr_file(&addr_path(home))
}

/// 경로로 주소 파일을 읽는다. 컨테이너 안의 마운트 자리가 이것을 쓴다 (FR-HRB-13).
pub fn read_addr_file(path: &Path) -> Option<(String, String)> {
    let data = fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&data);
    let (h, p) = split_host_port(text.trim())?;
    if h.is_empty() || !matches!(atoi(p), Some(1..=65535)) {
        return None;
    }
    Some((h.to_owned(), p.to_owned()))
}

/// Go `net.SplitHostPort` 의 판정. 실패 사유는 쓰지 않으므로 `None` 하나로 접는다.
fn split_host_port(hp: &str) -> Option<(&str, &str)> {
    let i = hp.rfind(':')?;
    let (host, j, k) = if hp.starts_with('[') {
        let end = hp.find(']')?;
        if end + 1 != i {
            return None;
        }
        (&hp[1..end], 1, end + 1)
    } else {
        let host = &hp[..i];
        if host.contains(':') {
            return None;
        }
        (host, 0, 0)
    };
    if hp[j..].contains('[') || hp[k..].contains(']') {
        return None;
    }
    Some((host, &hp[i + 1..]))
}

/// 주소 파일을 원자적으로 쓴다. 파일 0600, 폴더 0700 이다 (FR-HRB-10).
pub fn write_addr(home: &Path, addr: &str) -> Result<(), Error> {
    if home.as_os_str().is_empty() {
        return Err(Error::NoHome);
    }
    let path = addr_path(home);
    fsx::mkdir_all(&home.join(ADDR_DIR), 0o700)?;
    dm_shared_platform::write_file_atomic(&path, format!("{addr}\n").as_bytes(), 0o600)?;
    Ok(())
}

/// 주소 파일이 addr 일 때만 지운다. 폴더는 남긴다 (D-HRB-9).
pub fn remove_addr(home: &Path, addr: &str) {
    if home.as_os_str().is_empty() {
        return;
    }
    let path = addr_path(home);
    match fs::read(&path) {
        Ok(data) if String::from_utf8_lossy(&data).trim() == addr => {
            let _ = fs::remove_file(&path);
        }
        _ => {}
    }
}
