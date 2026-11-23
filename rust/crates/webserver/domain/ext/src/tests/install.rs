use super::*;
use crate::fetch::Fetch;
use crate::install::{INSTALL_WAIT_DELAY, OUTPUT_TAIL};
use crate::locate::{cache_dir, is_executable, managed_exe, plugin_dir, runtime_dir};
use crate::manifest::{Target, current_target};
use crate::service::Service;

fn installer(root: &str, rec: Recorder, on_path: &[(&str, &str)]) -> (Arc<Recorder>, Installer) {
    let rec = Arc::new(rec);
    let i = test_installer(
        root,
        Arc::clone(&rec),
        on_path,
        Arc::new(failing_fetch("네트워크 없음")),
    );
    (rec, i)
}

fn bg() -> Ctx {
    Ctx::background()
}

#[tokio::test]
async fn toolchain_runs_host_tool() {
    let (_d, root) = tmp();
    let m = must_parse(GO_PACK);
    let (rec, i) = installer(
        &root,
        placing(managed_exe(&root, &m, &m.servers[0])),
        &[("go", "/usr/bin/go")],
    );
    let out = i.install(&bg(), &m, &[]).await;
    assert!(out.ok, "{out:?}");
    assert_eq!(out.detail, "완료");
    let calls = rec.calls();
    assert_eq!(calls.len(), 1);
    let c = &calls[0];
    assert_eq!(c.name, "go");
    assert_eq!(c.args[0], "install");
    assert!(
        c.args
            .iter()
            .all(|a| !a.contains(['|', ';', '&', '$', '`']))
    );
    let env = env_map(&c.env);
    assert!(under_root(&root, &env["GOMODCACHE"]) && under_root(&root, &env["GOCACHE"]));
}

#[tokio::test]
async fn toolchain_without_tool() {
    let (_d, root) = tmp();
    let (rec, i) = installer(&root, Recorder::default(), &[]);
    let out = i.install(&bg(), &must_parse(GO_PACK), &[]).await;
    assert!(!out.ok);
    assert_eq!(
        out.reason,
        "go 가 이 기계에 없어 gopls 를 받을 수 없습니다 — go 를 먼저 설치하세요"
    );
    assert!(rec.calls().is_empty(), "도구 없이 무언가를 실행했다");
}

#[tokio::test]
async fn toolchain_clears_build_cache() {
    let (_d, root) = tmp();
    let m = must_parse(GO_PACK);
    let exe = managed_exe(&root, &m, &m.servers[0]);
    let rec = Recorder::with(move |c| {
        let env = env_map(&c.env);
        for k in ["GOMODCACHE", "GOCACHE"] {
            std::fs::create_dir_all(&env[k]).ok()?;
            std::fs::write(filepath::join(&[env[k].as_str(), "big"]), [0u8; 1024]).ok()?;
        }
        put_exe(&exe).err().map(|e| e.to_string())
    });
    let (rec, i) = installer(&root, rec, &[("go", "/usr/bin/go")]);
    assert!(i.install(&bg(), &m, &[]).await.ok);
    let env = env_map(&rec.calls()[0].env);
    assert!(
        std::fs::metadata(&env["GOCACHE"]).is_err(),
        "GOCACHE 가 남았다 (FR-EXT-23)"
    );
    assert!(
        std::fs::metadata(filepath::join(&[env["GOMODCACHE"].as_str(), "big"])).is_ok(),
        "GOMODCACHE 를 지웠다"
    );
    assert!(is_executable(&managed_exe(&root, &m, &m.servers[0])));
}

#[tokio::test]
async fn success_requires_the_exe() {
    let (_d, root) = tmp();
    let (_, i) = installer(&root, Recorder::default(), &[("go", "/usr/bin/go")]);
    let out = i.install(&bg(), &must_parse(GO_PACK), &[]).await;
    assert!(!out.ok);
    assert_eq!(out.reason, "gopls 는 끝났는데 gopls 가 놓이지 않았습니다");
    assert_eq!(out.detail, "완료");
}

#[tokio::test]
async fn pack_needs_every_server() {
    let (_d, root) = tmp();
    let m = must_parse(PACK_JSON);
    let node = must_parse(&node_runtime());
    let (_, i) = installer(
        &root,
        placing(managed_exe(&root, &m, &m.servers[0])),
        &[("node", "/usr/bin/node"), ("npm", "/usr/bin/npm")],
    );
    let out = i.install(&bg(), &m, &[node]).await;
    assert!(!out.ok);
    assert!(out.reason.contains(&m.servers[1].exe), "{}", out.reason);
}

#[tokio::test]
async fn npm_uses_runtime_npm() {
    let (_d, root) = tmp();
    let m = must_parse(NPM_PACK);
    let node = must_parse(&node_runtime());
    if !super::locate::put_runtime(&root, &node) {
        return;
    }
    let (rec, i) = installer(
        &root,
        placing(managed_exe(&root, &m, &m.servers[0])),
        &[("npm", "/usr/bin/npm")],
    );
    let out = i.install(&bg(), &m, &[node]).await;
    assert!(out.ok, "{out:?}");
    let c = &rec.calls()[0];
    assert!(
        under_root(&root, &c.name),
        "우리 런타임이 아니라 {} 를 불렀다 (FR-EXT-12)",
        c.name
    );
    let joined = c.args.join(" ");
    assert!(joined.contains(&m.source.packages[0]) && joined.contains(&plugin_dir(&root, &m.id)));
    let path = &env_map(&c.env)["PATH"];
    assert!(under_root(
        &root,
        path.split(filepath::LIST_SEPARATOR).next().unwrap()
    ));
}

/// 이 타깃의 런타임 tar.gz 와, 그 해시를 박은 선언.
fn runtime_blob() -> Option<(Vec<u8>, Manifest, Target)> {
    let mut node = must_parse(&node_runtime());
    let tg = node.source.targets.get(&current_target())?.clone();
    let blob = make_tar_gz(&[
        exe_entry(&format!("pkg/{}", tg.provides["node"]), "#!/bin/sh\n"),
        exe_entry(&format!("pkg/{}", tg.provides["npm"]), "#!/bin/sh\n"),
    ]);
    let t = Target {
        sha256: sum(&blob),
        strip: 1,
        ..tg.clone()
    };
    node.source.targets.insert(current_target(), t);
    Some((blob, node, tg))
}

#[tokio::test]
async fn fetches_runtime_first() {
    let (_d, root) = tmp();
    let m = must_parse(NPM_PACK);
    let Some((blob, node, tg)) = runtime_blob() else {
        return;
    };
    let fetch = Arc::new(blob_fetch(blob));
    let i = test_installer(
        &root,
        Arc::new(placing(managed_exe(&root, &m, &m.servers[0]))),
        &[],
        fetch.clone(),
    );
    let out = i.install(&bg(), &m, std::slice::from_ref(&node)).await;
    assert!(out.ok, "{out:?}");
    assert_eq!(fetch.count(), 1);
    assert!(is_executable(&filepath::join(&[
        runtime_dir(&root, &node).as_str(),
        filepath::from_slash(&tg.provides["node"]).as_str()
    ])));
}

#[tokio::test]
async fn skips_runtime_when_host_has_it() {
    let (_d, root) = tmp();
    let m = must_parse(NPM_PACK);
    let fetch = Arc::new(blob_fetch(Vec::new()));
    let i = test_installer(
        &root,
        Arc::new(placing(managed_exe(&root, &m, &m.servers[0]))),
        &[("node", "/usr/bin/node"), ("npm", "/usr/bin/npm")],
        fetch.clone(),
    );
    assert!(
        i.install(&bg(), &m, &[must_parse(&node_runtime())])
            .await
            .ok
    );
    assert_eq!(
        fetch.count(),
        0,
        "호스트에 있는데 런타임을 받았다 (FR-EXT-7b)"
    );
}

fn archive_pack(blob: &[u8], strip: i64) -> Manifest {
    let x = exe_suffix();
    must_parse(&format!(
        r#"{{"id":"thing","kind":"server","source":{{"kind":"archive","targets":{{"{}":{{"url":"https://e.test/a.tar.gz","sha256":"{}","strip":{strip},"bin":"bin/thing{x}"}}}}}},
		"servers":[{{"id":"thing","exe":"thing","langs":["x"],"exts":[".x"]}}]}}"#,
        current_target(),
        sum(blob)
    ))
}

#[tokio::test]
async fn archive_server() {
    if current_target().is_empty() {
        return;
    }
    let (_d, root) = tmp();
    let blob = make_tar_gz(&[exe_entry(
        &format!("wrap/bin/thing{}", exe_suffix()),
        "#!/bin/sh\n",
    )]);
    let m = archive_pack(&blob, 1);
    let rec = Arc::new(Recorder::default());
    let i = test_installer(&root, Arc::clone(&rec), &[], Arc::new(blob_fetch(blob)));
    let out = i.install(&bg(), &m, &[]).await;
    assert!(out.ok, "{out:?}");
    assert!(rec.calls().is_empty(), "archive 조달이 명령을 실행했다");
    assert_eq!(
        out.exe,
        filepath::join(&[
            plugin_dir(&root, "thing").as_str(),
            "bin",
            &format!("thing{}", exe_suffix())
        ])
    );
}

/// 받는 동안 cache 에 임시 파일 하나만 있고, 끝나면 없다 (FR-ATF-24).
struct Peek {
    blob: Vec<u8>,
    cache: String,
    during: Mutex<usize>,
}

impl Fetch for Peek {
    fn fetch<'a>(
        &'a self,
        _: &'a Ctx,
        _: &'a str,
        w: &'a mut (dyn Write + Send),
    ) -> crate::fetch::BoxFuture<'a, io::Result<()>> {
        Box::pin(async move {
            *self.during.lock().unwrap() = std::fs::read_dir(&self.cache)
                .map(|d| d.count())
                .unwrap_or(0);
            w.write_all(&self.blob)
        })
    }
}

#[tokio::test]
async fn download_temp_under_cache() {
    if current_target().is_empty() {
        return;
    }
    let (_d, root) = tmp();
    let blob = make_tar_gz(&[exe_entry(
        &format!("bin/thing{}", exe_suffix()),
        "#!/bin/sh\n",
    )]);
    let m = archive_pack(&blob, 0);
    let peek = Arc::new(Peek {
        blob,
        cache: cache_dir(&root),
        during: Mutex::new(0),
    });
    let i = test_installer(&root, Arc::new(Recorder::default()), &[], peek.clone());
    assert!(i.install(&bg(), &m, &[]).await.ok);
    assert_eq!(*peek.during.lock().unwrap(), 1);
    assert_eq!(
        std::fs::read_dir(cache_dir(&root)).unwrap().count(),
        0,
        "임시 파일이 남았다"
    );
}

#[tokio::test]
async fn detail_tail_is_valid_utf8() {
    let (_d, root) = tmp();
    let long = "가".repeat(OUTPUT_TAIL);
    let rec = Recorder::with(|_| Some("exit 1".to_owned()));
    let (_, mut i) = installer(&root, rec, &[("go", "/usr/bin/go")]);
    struct Long(String);
    impl Exec for Long {
        fn exec<'a>(
            &'a self,
            _: &'a Ctx,
            _: &'a str,
            _: &'a [String],
            _: &'a [String],
            _: &'a str,
        ) -> crate::fetch::BoxFuture<'a, crate::install::ExecResult> {
            Box::pin(async move {
                crate::install::ExecResult {
                    out: self.0.clone().into_bytes(),
                    err: Some("exit 1".to_owned()),
                }
            })
        }
    }
    i.exec = Arc::new(Long(long));
    let out = i.install(&bg(), &must_parse(GO_PACK), &[]).await;
    assert!(!out.ok);
    assert!(out.detail.len() <= OUTPUT_TAIL && !out.detail.contains('\u{fffd}'));
}

/// 느리게 받는 Fetch — 두 조달이 겹치는 창을 만든다.
struct Slow(Vec<u8>, Mutex<usize>);

impl Fetch for Slow {
    fn fetch<'a>(
        &'a self,
        _: &'a Ctx,
        _: &'a str,
        w: &'a mut (dyn Write + Send),
    ) -> crate::fetch::BoxFuture<'a, io::Result<()>> {
        Box::pin(async move {
            *self.1.lock().unwrap() += 1;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            w.write_all(&self.0)
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn ensure_runtime_concurrent_fetches_once() {
    let (_d, root) = tmp();
    let Some((blob, node, _)) = runtime_blob() else {
        return;
    };
    let slow = Arc::new(Slow(blob, Mutex::new(0)));
    let i = test_installer(&root, Arc::new(Recorder::default()), &[], slow.clone());
    let rts = [node.clone()];
    let ctx = bg();
    let (a, b) = tokio::join!(
        i.ensure_runtime(&ctx, "node", &rts),
        i.ensure_runtime(&ctx, "node", &rts)
    );
    assert!(a.ok && b.ok, "{a:?} {b:?}");
    assert_eq!(*slow.1.lock().unwrap(), 1, "런타임을 여러 번 받았다");
}

#[test]
fn install_wait_delay_is_set() {
    assert_eq!(INSTALL_WAIT_DELAY, std::time::Duration::from_secs(5));
}

#[tokio::test]
async fn timeout_reason_uses_go_duration() {
    let (_d, root) = tmp();
    struct Sleepy;
    impl Exec for Sleepy {
        fn exec<'a>(
            &'a self,
            ctx: &'a Ctx,
            _: &'a str,
            _: &'a [String],
            _: &'a [String],
            _: &'a str,
        ) -> crate::fetch::BoxFuture<'a, crate::install::ExecResult> {
            Box::pin(async move {
                ctx.done().await;
                crate::install::ExecResult::default()
            })
        }
    }
    let (_, mut i) = installer(&root, Recorder::default(), &[("go", "/usr/bin/go")]);
    i.exec = Arc::new(Sleepy);
    i.timeout = std::time::Duration::from_millis(30);
    let out = i.install(&bg(), &must_parse(GO_PACK), &[]).await;
    assert_eq!(
        out.reason,
        "gopls 조달이 30ms 안에 끝나지 않아 중단했습니다"
    );
}

#[tokio::test]
async fn service_install_rejects_unknown_and_duplicate() {
    let (_d, root) = tmp();
    super::load::write_plugin(&root, "gopls", GO_PACK);
    let svc = Service::with(
        &root,
        map_look(&[]),
        Arc::new(failing_fetch("x")),
        Arc::new(Recorder::default()),
    );
    assert_eq!(
        svc.install(&bg(), "nope").await.reason,
        r#""nope" 는 아는 플러그인이 아닙니다"#
    );
    let out = svc.install(&bg(), "gopls").await;
    assert!(out.reason.starts_with("go 가 이 기계에 없어"), "{out:?}");
    let (sts, _) = svc.status(&HashMap::new());
    assert!(!sts[0].installing, "끝난 조달이 진행 중으로 남았다");
}
