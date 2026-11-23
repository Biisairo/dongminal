//! Go `ext` 시험을 옮긴 것과 Rust 쪽 관측 시험. 네트워크에 나가지 않는다.

mod builtin;
mod env;
mod fetch;
mod guard;
mod install;
mod load;
mod locate;
mod manifest;
mod wire;

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use dm_gocompat::filepath;
use sha2::{Digest, Sha256};

use crate::ctx::Ctx;
use crate::fetch::{BoxFuture, Fetch};
use crate::install::{Exec, ExecResult, Installer};
use crate::locate::{Locator, LookPath};
use crate::manifest::{Manifest, parse_manifest};

pub(crate) const HEX64: &str = "0000000000000000000000000000000000000000000000000000000000000000";

pub(crate) const PACK_JSON: &str = r#"{
  "id": "vscode-langservers-extracted",
  "kind": "server",
  "needs": ["node"],
  "source": { "kind":"npm","packages":["vscode-langservers-extracted@4.10.0"] },
  "servers": [
    {"id":"html","langs":["html"],"exts":[".html",".htm"],"exe":"vscode-html-language-server","args":["--stdio"]},
    {"id":"css","langs":["css"],"exts":[".css"],"exe":"vscode-css-language-server","args":["--stdio"]}
  ]
}"#;

pub(crate) const NPM_PACK: &str = r#"{
  "id":"yaml","kind":"server","needs":["node"],
  "source":{"kind":"npm","packages":["yaml-language-server@1.24.0"]},
  "servers":[{"id":"yaml","langs":["yaml"],"exts":[".yaml",".yml"],"exe":"yaml-language-server","args":["--stdio"]}]
}"#;

pub(crate) const GO_PACK: &str = r#"{
  "id":"gopls","kind":"server",
  "source":{"kind":"toolchain","tool":"go","args":["install","golang.org/x/tools/gopls@latest"],"bin":"bin"},
  "servers":[{"id":"gopls","langs":["go"],"exts":[".go"],"exe":"gopls"}]
}"#;

pub(crate) fn node_runtime() -> String {
    let t = |url: &str, node: &str, npm: &str| {
        format!(
            r#"{{"url":"{url}","sha256":"{HEX64}","strip":1,"provides":{{"node":"{node}","npm":"{npm}"}}}}"#
        )
    };
    let posix = t("https://nodejs.org/dist/x.tar.gz", "bin/node", "bin/npm");
    let win = t(
        "https://nodejs.org/dist/x.zip",
        "node.exe",
        "node_modules/npm/bin/npm-cli.js",
    );
    format!(
        r#"{{"id":"node","kind":"runtime","version":"v24.20.0","source":{{"kind":"archive","targets":{{
          "darwin-arm64":{posix},"darwin-x64":{posix},"linux-x64":{posix},"linux-arm64":{posix},"win32-x64":{win}}}}}}}"#
    )
}

pub(crate) fn must_parse(js: &str) -> Manifest {
    parse_manifest(js.as_bytes()).unwrap_or_else(|e| panic!("매니페스트가 거절됐다: {e}"))
}

pub(crate) fn tmp() -> (tempfile::TempDir, String) {
    let d = tempfile::tempdir().unwrap();
    // Go t.TempDir() 처럼 실경로로 쓴다 — macOS 의 /var 는 /private/var 의 링크다.
    let p = filepath::eval_symlinks(&d.path().to_string_lossy()).unwrap();
    (d, p)
}

pub(crate) fn exe_suffix() -> &'static str {
    dm_shared_platform::current().paths.exe_suffix()
}

pub(crate) fn must_exec(p: &str) {
    put_exe(p).unwrap();
}

pub(crate) fn put_exe(p: &str) -> io::Result<()> {
    std::fs::create_dir_all(filepath::dir(p))?;
    std::fs::write(p, b"#!/bin/sh\n")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

pub(crate) fn map_look(on_path: &[(&str, &str)]) -> LookPath {
    let m: HashMap<String, String> = on_path
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    Arc::new(move |name| m.get(name).cloned())
}

pub(crate) fn test_locator(
    root: &str,
    on_path: &[(&str, &str)],
    overrides: &[(&str, &str)],
    runtimes: Vec<Manifest>,
) -> Locator {
    Locator {
        root: root.to_owned(),
        look_path: map_look(on_path),
        overrides: overrides
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        runtimes,
        target: String::new(),
    }
}

pub(crate) fn env_map(pairs: &[String]) -> HashMap<String, String> {
    pairs
        .iter()
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
}

pub(crate) fn under_root(root: &str, p: &str) -> bool {
    match filepath::rel(root, p) {
        Ok(rel) => rel != ".." && !rel.starts_with(&format!("..{}", filepath::SEPARATOR)),
        Err(_) => false,
    }
}

pub(crate) fn sum(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// tar 엔트리 하나. 이름·링크는 검사 없이 그대로 적는다(빠져나가는 이름을 재려고).
#[derive(Clone, Default)]
pub(crate) struct TarEntry {
    pub name: String,
    pub body: String,
    pub mode: u32,
    /// `b'0'` 보통 파일(기본), `b'5'` 디렉터리, `b'2'` 심링크, `b'1'` 하드링크.
    pub typ: u8,
    pub link: String,
}

pub(crate) fn file(name: &str, body: &str) -> TarEntry {
    TarEntry {
        name: name.to_owned(),
        body: body.to_owned(),
        ..TarEntry::default()
    }
}

pub(crate) fn exe_entry(name: &str, body: &str) -> TarEntry {
    TarEntry {
        mode: 0o755,
        ..file(name, body)
    }
}

pub(crate) fn link(name: &str, typ: u8, target: &str) -> TarEntry {
    TarEntry {
        name: name.to_owned(),
        typ,
        link: target.to_owned(),
        ..TarEntry::default()
    }
}

pub(crate) fn dir_entry(name: &str) -> TarEntry {
    TarEntry {
        name: name.to_owned(),
        typ: b'5',
        ..TarEntry::default()
    }
}

pub(crate) fn make_tar_gz(entries: &[TarEntry]) -> Vec<u8> {
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut b = tar::Builder::new(gz);
    for e in entries {
        let typ = if e.typ == 0 { b'0' } else { e.typ };
        let mode = if e.mode == 0 { 0o644 } else { e.mode };
        let mut h = tar::Header::new_ustar();
        {
            let raw = h.as_old_mut();
            raw.name.fill(0);
            raw.name[..e.name.len()].copy_from_slice(e.name.as_bytes());
            raw.linkname.fill(0);
            raw.linkname[..e.link.len()].copy_from_slice(e.link.as_bytes());
        }
        h.set_mode(mode);
        h.set_entry_type(tar::EntryType::new(typ));
        let body = if typ == b'0' { e.body.as_bytes() } else { b"" };
        h.set_size(body.len() as u64);
        h.set_cksum();
        b.append(&h, body).unwrap();
    }
    b.into_inner().unwrap().finish().unwrap()
}

pub(crate) fn make_zip(entries: &[TarEntry]) -> Vec<u8> {
    let mut zw = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
    for e in entries {
        zw.start_file(
            e.name.as_str(),
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zw.write_all(e.body.as_bytes()).unwrap();
    }
    zw.finish().unwrap().into_inner()
}

/// 정해진 바이트를 내거나 정해진 오류를 낸다. 받은 횟수를 센다.
pub(crate) struct BlobFetch {
    pub blob: Vec<u8>,
    pub err: Option<String>,
    pub count: Mutex<usize>,
}

pub(crate) fn blob_fetch(blob: Vec<u8>) -> BlobFetch {
    BlobFetch {
        blob,
        err: None,
        count: Mutex::new(0),
    }
}

pub(crate) fn failing_fetch(err: &str) -> BlobFetch {
    BlobFetch {
        err: Some(err.to_owned()),
        ..blob_fetch(Vec::new())
    }
}

impl BlobFetch {
    pub(crate) fn count(&self) -> usize {
        *self.count.lock().unwrap()
    }
}

impl Fetch for BlobFetch {
    fn fetch<'a>(
        &'a self,
        _: &'a Ctx,
        _: &'a str,
        w: &'a mut (dyn Write + Send),
    ) -> BoxFuture<'a, io::Result<()>> {
        Box::pin(async move {
            *self.count.lock().unwrap() += 1;
            if let Some(e) = &self.err {
                return Err(io::Error::other(e.clone()));
            }
            w.write_all(&self.blob)
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Call {
    pub name: String,
    pub args: Vec<String>,
    pub env: Vec<String>,
}

type OnExec = Box<dyn Fn(&Call) -> Option<String> + Send + Sync>;

/// 부른 명령을 적어 둔다. on_exec 가 오류 문구를 내면 그 명령은 실패한다.
#[derive(Default)]
pub(crate) struct Recorder {
    pub calls: Mutex<Vec<Call>>,
    pub on_exec: Option<OnExec>,
}

impl Recorder {
    pub(crate) fn with(f: impl Fn(&Call) -> Option<String> + Send + Sync + 'static) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            on_exec: Some(Box::new(f)),
        }
    }

    pub(crate) fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

/// 놓기만 하는 Exec: 부르면 그 자리에 실행 파일을 둔다.
pub(crate) fn placing(p: String) -> Recorder {
    Recorder::with(move |_| put_exe(&p).err().map(|e| e.to_string()))
}

impl Exec for Recorder {
    fn exec<'a>(
        &'a self,
        _: &'a Ctx,
        name: &'a str,
        args: &'a [String],
        env: &'a [String],
        _: &'a str,
    ) -> BoxFuture<'a, ExecResult> {
        Box::pin(async move {
            let c = Call {
                name: name.to_owned(),
                args: args.to_vec(),
                env: env.to_vec(),
            };
            self.calls.lock().unwrap().push(c.clone());
            if let Some(f) = &self.on_exec
                && let Some(e) = f(&c)
            {
                return ExecResult {
                    out: "실패 출력".as_bytes().to_vec(),
                    err: Some(e),
                };
            }
            ExecResult {
                out: "완료".as_bytes().to_vec(),
                err: None,
            }
        })
    }
}

pub(crate) fn test_installer(
    root: &str,
    rec: Arc<Recorder>,
    on_path: &[(&str, &str)],
    fetch: Arc<dyn Fetch>,
) -> Installer {
    Installer {
        fetch,
        exec: rec,
        look_path: map_look(on_path),
        ..Installer::new(root)
    }
}
