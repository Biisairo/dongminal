//! 컨테이너에 넣는 리눅스용 dmctl(헬퍼)의 캐시 (SANDBOX_SRS FR-SBX-14).

use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use dm_gocompat::filepath;

/// 헬퍼 이름과 컨테이너 안 자리다.
pub const HELPER_NAME: &str = "dmctl";
pub const HELPER_MOUNT_PATH: &str = "/usr/local/bin/dmctl";
const HELPER_CACHE_DIR: &str = "cache";
const DEV_VERSION: &str = "dev";
const RELEASE_REPO: &str = "Biisairo/dongminal";
const HELPER_FETCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub type StatFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;
/// (url, 목적지) → 실패 문구.
pub type FetchFn = Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;
/// (arch, 목적지) → 실패 문구.
pub type CrossBuildFn = Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;
pub type ListCacheFn = Arc<dyn Fn(&str) -> io::Result<Vec<String>> + Send + Sync>;
pub type RemoveFn = Arc<dyn Fn(&str) + Send + Sync>;

/// 헬퍼를 마련하는 데 쓰는 것들이다. 검사는 가짜로 바꾼다.
#[derive(Clone)]
pub struct HelperDeps {
    pub version: String,
    /// Go `GOARCH` 이름(`amd64`·`arm64`).
    pub arch: String,
    pub home: String,
    pub stat: StatFn,
    pub fetch: FetchFn,
    pub cross_build: CrossBuildFn,
    pub list_cache: Option<ListCacheFn>,
    pub remove: Option<RemoveFn>,
}

/// 판·아키텍처별 캐시 자리다.
pub fn helper_cache_path(home: &str, version: &str, arch: &str) -> String {
    let name = format!("{HELPER_NAME}-{version}-linux-{arch}");
    filepath::join(&[home, HELPER_CACHE_DIR, name.as_str()])
}

/// 헬퍼의 경로를 돌려준다. 캐시에 없으면 릴리스에서 받고, 개발 빌드면 소스에서 만든다.
pub fn ensure_helper(d: &HelperDeps) -> Result<String, crate::Error> {
    let dest = helper_cache_path(&d.home, &d.version, &d.arch);
    if (d.stat)(&dest) {
        return Ok(dest);
    }
    if d.version == DEV_VERSION {
        if let Err(e) = (d.cross_build)(&d.arch, &dest) {
            return Err(crate::Error::msg(format!(
                "리눅스용 {HELPER_NAME} 를 만들지 못했습니다(개발 빌드): {e}\n  직접 놓아두려면: GOOS=linux GOARCH={} go build -o {dest} ./cmd/dongminal",
                d.arch
            )));
        }
        return Ok(dest);
    }
    let url = release_asset_url(&d.version, &d.arch);
    if let Err(e) = (d.fetch)(&url, &dest) {
        return Err(crate::Error::msg(format!(
            "리눅스용 {HELPER_NAME} 를 받지 못했습니다({url}): {e}"
        )));
    }
    Ok(dest)
}

fn release_asset_url(version: &str, arch: &str) -> String {
    format!("https://github.com/{RELEASE_REPO}/releases/download/{version}/dongminal-linux-{arch}")
}

/// 지금 판이 아닌 헬퍼 캐시를 지운다.
pub fn prune_helper_cache(d: &HelperDeps) {
    let (Some(list), Some(remove)) = (&d.list_cache, &d.remove) else {
        return;
    };
    let cur = helper_cache_path(&d.home, &d.version, &d.arch);
    let Ok(files) = list(&filepath::join(&[d.home.as_str(), HELPER_CACHE_DIR])) else {
        return;
    };
    let prefix = format!("{HELPER_NAME}-");
    for f in files {
        if f == cur || !filepath::base(&f).starts_with(&prefix) {
            continue;
        }
        remove(&f);
    }
}

/// 이 빌드의 Go `GOARCH` 이름이다.
fn go_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        "arm" => "arm",
        other => other,
    }
}

/// 실제 파일 시스템·네트워크를 쓰는 의존이다.
pub fn default_helper_deps(home: &str, version: &str) -> HelperDeps {
    HelperDeps {
        version: version.into(),
        arch: go_arch().into(),
        home: home.into(),
        stat: Arc::new(|p| std::fs::metadata(p).is_ok()),
        fetch: Arc::new(fetch_helper),
        cross_build: Arc::new(cross_build_helper),
        list_cache: Some(Arc::new(list_cache_files)),
        remove: Some(Arc::new(|p| {
            let _ = std::fs::remove_file(p);
        })),
    }
}

fn os_err(e: io::Error) -> String {
    dm_gocompat::oserr::go_error_string(&e)
}

fn mkdir_parent(dest: &str) -> Result<(), String> {
    let dir = filepath::dir(dest);
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o755);
    b.create(&dir)
        .map_err(|e| os_err(dm_gocompat::oserr::path_error("mkdir", &dir, e)))
}

/// 릴리스 자산을 받아 임시 파일을 거쳐 dest 로 옮긴다(0755).
fn fetch_helper(url: &str, dest: &str) -> Result<(), String> {
    mkdir_parent(dest)?;
    let (url, dest) = (url.to_string(), dest.to_string());
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(os_err)?;
        rt.block_on(fetch_async(&url, &dest))
    })
    .join()
    .unwrap_or_else(|_| Err("fetch panicked".into()))
}

async fn fetch_async(url: &str, dest: &str) -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let transport = |e: reqwest::Error| {
        dm_gocompat::neturl_err::UrlError::from_reqwest("GET", url, &e).to_string()
    };
    let client = reqwest::Client::builder()
        .timeout(HELPER_FETCH_TIMEOUT)
        .build()
        .map_err(transport)?;
    let res = client.get(url).send().await.map_err(transport)?;
    if res.status() != reqwest::StatusCode::OK {
        let st = res.status();
        return Err(format!(
            "응답 {} {}",
            st.as_u16(),
            st.canonical_reason().unwrap_or("")
        ));
    }
    let body = res.bytes().await.map_err(transport)?;
    let dir = filepath::dir(dest);
    let tmp = Path::new(&dir).join(format!(".dmctl-{}", std::process::id()));
    let tmp_s = tmp.to_string_lossy().into_owned();
    let write = || -> Result<(), String> {
        std::fs::write(&tmp, &body)
            .map_err(|e| os_err(dm_gocompat::oserr::path_error("write", &tmp_s, e)))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| os_err(dm_gocompat::oserr::path_error("chmod", &tmp_s, e)))?;
        }
        std::fs::rename(&tmp, dest)
            .map_err(|e| os_err(dm_gocompat::oserr::link_error("rename", &tmp_s, dest, e)))
    };
    let r = write();
    let _ = std::fs::remove_file(&tmp);
    r
}

/// 개발 빌드: 소스 트리에서 리눅스용 바이너리를 만든다(cargo).
fn cross_build_helper(arch: &str, dest: &str) -> Result<(), String> {
    let root = source_root()?;
    mkdir_parent(dest)?;
    let triple = match arch {
        "amd64" => "x86_64-unknown-linux-gnu",
        "arm64" => "aarch64-unknown-linux-gnu",
        other => return Err(format!("지원하지 않는 아키텍처입니다: {other}")),
    };
    let args: Vec<String> = ["build", "--release", "-p", "dongminal", "--target", triple]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let r = std::process::Command::new(&cargo)
        .args(&args)
        .current_dir(&root)
        .output();
    match r {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            let mut out = o.stdout;
            out.extend_from_slice(&o.stderr);
            return Err(format!(
                "{}: {}",
                crate::exit_text(&o.status),
                String::from_utf8_lossy(&out)
            ));
        }
        Err(e) => return Err(format!("fork/exec {cargo}: {}", os_err(e))),
    }
    let built = Path::new(&root)
        .join("target")
        .join(triple)
        .join("release")
        .join("dongminal");
    std::fs::copy(&built, dest).map(|_| ()).map_err(os_err)
}

/// 이 crate 의 위치에서 위로 Cargo 워크스페이스 루트(`Cargo.lock` 이 있는 곳)를 찾는다.
fn source_root() -> Result<String, String> {
    let start = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut dir = start;
    loop {
        if dir.join("Cargo.lock").exists() {
            return Ok(dir.to_string_lossy().into_owned());
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => {
                return Err(format!(
                    "소스 트리를 찾을 수 없습니다({} 에서 위로 Cargo.lock 없음)",
                    start.display()
                ));
            }
        }
    }
}

fn list_cache_files(dir: &str) -> io::Result<Vec<String>> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        if !e.file_type()?.is_dir() {
            out.push(filepath::join(&[dir, &e.file_name().to_string_lossy()]));
        }
    }
    out.sort();
    Ok(out)
}
