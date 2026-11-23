use super::*;
use crate::error::Sentinel;
use crate::fetch::{EXTRACT_RATIO, MAX_ARCHIVE_BYTES, Opts, fetch_archive, fetch_archive_with};
use crate::locate::{cache_dir, is_executable};
use crate::manifest::{MANIFEST_NAME, Target};

fn target(blob: &[u8], strip: i64) -> Target {
    Target {
        url: "https://example.test/a.tar.gz".to_owned(),
        sha256: sum(blob),
        strip,
        ..Target::default()
    }
}

fn out(root: &str) -> String {
    filepath::join(&[root, "out"])
}

async fn fetch_to(blob: Vec<u8>, t: &Target, dest: &str) -> Result<(), crate::error::Error> {
    fetch_archive(
        &Ctx::background(),
        &blob_fetch(blob),
        t,
        dest,
        &filepath::dir(dest),
    )
    .await
}

/// 엔트리들을 tar.gz 로 받아 `<root>/out` 에 푼다.
async fn fetch_into(
    entries: &[TarEntry],
    strip: i64,
) -> (
    tempfile::TempDir,
    String,
    String,
    Result<(), crate::error::Error>,
) {
    let (d, root) = tmp();
    let blob = make_tar_gz(entries);
    let dest = out(&root);
    let r = fetch_to(blob.clone(), &target(&blob, strip), &dest).await;
    (d, root, dest, r)
}

fn exists(p: &str) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

#[tokio::test]
async fn extracts_and_strips() {
    let node = format!("node-v1/bin/node{}", exe_suffix());
    let (_d, _r, dest, r) = fetch_into(
        &[
            exe_entry(&node, "#!/bin/sh\n"),
            file("node-v1/README", "hi"),
        ],
        1,
    )
    .await;
    r.unwrap();
    assert_eq!(
        std::fs::read_to_string(filepath::join(&[dest.as_str(), "README"])).unwrap(),
        "hi"
    );
    let exe = filepath::join(&[dest.as_str(), "bin", &format!("node{}", exe_suffix())]);
    assert!(is_executable(&exe), "풀린 것이 실행 파일이 아니다: {exe}");
}

#[tokio::test]
async fn rejects_checksum_mismatch() {
    let (_d, root) = tmp();
    let blob = make_tar_gz(&[exe_entry("bin/node", "x")]);
    let dest = out(&root);
    let t = Target {
        sha256: HEX64.to_owned(),
        ..target(&blob, 0)
    };
    let e = fetch_to(blob.clone(), &t, &dest).await.unwrap_err();
    assert_eq!(
        e.to_string(),
        format!(
            "받은 것의 sha256 이 선언과 다릅니다 (선언 {HEX64}, 실제 {}) — 풀지 않았습니다",
            sum(&blob)
        )
    );
    assert!(!exists(&dest), "실패한 조달이 자리를 남겼다");
}

#[tokio::test]
async fn rejects_escaping_entries() {
    for (name, want) in [
        (
            "../escaped",
            r#"아카이브가 상위 경로를 담고 있습니다: "../escaped""#,
        ),
        (
            "/etc/passwd",
            r#"아카이브가 절대경로를 담고 있습니다: "/etc/passwd""#,
        ),
        (
            "a/../../escaped",
            r#"아카이브가 상위 경로를 담고 있습니다: "a/../../escaped""#,
        ),
    ] {
        let (_d, root, _, r) = fetch_into(&[file(name, "x")], 0).await;
        assert_eq!(r.unwrap_err().to_string(), want);
        assert!(
            !exists(&filepath::join(&[root.as_str(), "escaped"])),
            "격리 칸 밖에 파일이 쓰였다"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_escaping_links() {
    let (_d, _r, _, r) = fetch_into(&[link("inside", b'2', "../../outside")], 0).await;
    assert_eq!(
        r.unwrap_err().to_string(),
        r#"링크가 격리 칸 밖을 가리킵니다: "inside" → "../../outside""#
    );
}

#[tokio::test]
async fn zip() {
    let (_d, root) = tmp();
    let blob = make_zip(&[file("node-v1/node.exe", "MZ")]);
    let dest = out(&root);
    fetch_to(blob.clone(), &target(&blob, 1), &dest)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(filepath::join(&[dest.as_str(), "node.exe"])).unwrap(),
        "MZ"
    );
}

#[tokio::test]
async fn fetch_failure() {
    let (_d, root) = tmp();
    let dest = out(&root);
    let t = Target {
        sha256: HEX64.to_owned(),
        ..target(b"", 0)
    };
    let e = fetch_archive(
        &Ctx::background(),
        &failing_fetch("연결 실패"),
        &t,
        &dest,
        &root,
    )
    .await
    .unwrap_err();
    assert_eq!(
        e.to_string(),
        "https://example.test/a.tar.gz 를 받지 못했습니다: 연결 실패"
    );
    assert!(!exists(&dest));
}

#[tokio::test]
async fn replaces_previous() {
    let (_d, root) = tmp();
    let dest = out(&root);
    let old = make_tar_gz(&[file("old-file", "old")]);
    fetch_to(old.clone(), &target(&old, 0), &dest)
        .await
        .unwrap();
    let next = make_tar_gz(&[file("new-file", "new")]);
    fetch_to(next.clone(), &target(&next, 0), &dest)
        .await
        .unwrap();
    assert!(
        !exists(&filepath::join(&[dest.as_str(), "old-file"])),
        "옛 판의 파일이 남았다"
    );
    assert!(exists(&filepath::join(&[dest.as_str(), "new-file"])));
    let left: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, ["out"], "곁다리가 남았다");
}

#[tokio::test]
async fn raw() {
    let (_d, root) = tmp();
    let blob = b"\x7fELF raw binary".to_vec();
    let dest = out(&root);
    let bin = format!("marksman{}", exe_suffix());
    let t = Target {
        bin: bin.clone(),
        raw: true,
        ..target(&blob, 0)
    };
    fetch_to(blob.clone(), &t, &dest).await.unwrap();
    let exe = filepath::join(&[dest.as_str(), &bin]);
    assert_eq!(std::fs::read(&exe).unwrap(), blob);
    assert!(is_executable(&exe));
    assert!(!exists(&format!("{dest}.new")), "옆 자리가 남았다");
}

#[tokio::test]
async fn raw_rejects_checksum_mismatch() {
    let (_d, root) = tmp();
    let dest = out(&root);
    let t = Target {
        bin: "marksman".to_owned(),
        raw: true,
        sha256: HEX64.to_owned(),
        ..target(b"", 0)
    };
    assert!(fetch_to(b"x".to_vec(), &t, &dest).await.is_err());
    assert!(!exists(&dest) && !exists(&format!("{dest}.new")));
}

#[tokio::test]
async fn keeps_manifest() {
    for raw in [true, false] {
        let (_d, root) = tmp();
        let dest = filepath::join(&[root.as_str(), "pack"]);
        std::fs::create_dir_all(&dest).unwrap();
        let manifest = br#"{"id":"pack"}"#;
        std::fs::write(filepath::join(&[dest.as_str(), MANIFEST_NAME]), manifest).unwrap();
        let (blob, t) = if raw {
            let b = b"bin".to_vec();
            let t = Target {
                bin: "a".to_owned(),
                raw: true,
                ..target(&b, 0)
            };
            (b, t)
        } else {
            let b = make_tar_gz(&[exe_entry("a", "bin")]);
            let t = Target {
                bin: "a".to_owned(),
                ..target(&b, 0)
            };
            (b, t)
        };
        fetch_to(blob, &t, &dest).await.unwrap();
        assert_eq!(
            std::fs::read(filepath::join(&[dest.as_str(), MANIFEST_NAME])).unwrap(),
            manifest,
            "raw={raw}"
        );
    }
}

fn opts(max: i64) -> Opts {
    Opts {
        max_archive: max,
        ..Opts::default()
    }
}

/// 8 바이트씩 네 번 쓴다.
struct Chunks;

impl crate::fetch::Fetch for Chunks {
    fn fetch<'a>(
        &'a self,
        _: &'a Ctx,
        _: &'a str,
        w: &'a mut (dyn Write + Send),
    ) -> crate::fetch::BoxFuture<'a, io::Result<()>> {
        Box::pin(async move {
            for _ in 0..4 {
                w.write_all(&[0u8; 8])?;
            }
            Ok(())
        })
    }
}

#[tokio::test]
async fn rejects_oversize() {
    let (_d, root) = tmp();
    let dest = out(&root);
    let t = Target {
        sha256: HEX64.to_owned(),
        ..target(b"", 0)
    };
    let e = fetch_archive_with(&Ctx::background(), &Chunks, &t, &dest, &root, opts(16))
        .await
        .unwrap_err();
    assert!(e.is(Sentinel::ArchiveTooLarge), "{e}");
    assert!(!exists(&dest));
}

#[tokio::test]
async fn at_limit_passes() {
    let (_d, root) = tmp();
    let blob = make_tar_gz(&[file("README", "hi")]);
    let t = target(&blob, 0);
    fetch_archive_with(
        &Ctx::background(),
        &blob_fetch(blob.clone()),
        &t,
        &out(&root),
        &root,
        opts(blob.len() as i64),
    )
    .await
    .unwrap();
}

#[test]
fn max_archive_bytes_default() {
    assert_eq!(MAX_ARCHIVE_BYTES, 1 << 30);
    assert_eq!(Opts::default().max_archive, MAX_ARCHIVE_BYTES);
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_two_hop_link_escape() {
    let (_d, root, _, r) = fetch_into(
        &[
            dir_entry("c/"),
            link("b", b'2', "c/.."),
            link("a", b'2', "b/.."),
            file("a/evil", "x"),
        ],
        0,
    )
    .await;
    assert!(r.is_err(), "두 홉 링크 뒤의 파일이 통과했다 (FR-ATF-20)");
    assert!(!exists(&filepath::join(&[root.as_str(), "evil"])));
}

#[cfg(unix)]
#[tokio::test]
async fn file_does_not_follow_escaping_link() {
    let (_d, root, _, r) = fetch_into(
        &[
            dir_entry("c/"),
            link("b", b'2', "c/.."),
            link("f", b'2', "b/../victim"),
            file("f", "x"),
        ],
        0,
    )
    .await;
    assert!(
        !exists(&filepath::join(&[root.as_str(), "victim"])),
        "링크를 따라 칸 밖에 쓰였다 ({r:?})"
    );
}

#[tokio::test]
async fn hardlink_copies_stripped_target() {
    let (_d, _r, dest, r) = fetch_into(
        &[
            exe_entry("pkg/bin/real", "payload"),
            link("pkg/bin/alias", b'1', "pkg/bin/real"),
        ],
        1,
    )
    .await;
    r.unwrap();
    let alias = filepath::join(&[dest.as_str(), "bin", "alias"]);
    assert!(std::fs::symlink_metadata(&alias).unwrap().is_file());
    assert_eq!(std::fs::read_to_string(&alias).unwrap(), "payload");
}

#[tokio::test]
async fn hardlink_rejects_escaping_target() {
    let (_d, _r, _, r) = fetch_into(&[link("alias", b'1', "../outside")], 0).await;
    assert!(r.is_err());
}

#[tokio::test]
async fn extract_total_cap() {
    let max = 4096;
    let limit = (max * EXTRACT_RATIO) as usize;
    for zip in [false, true] {
        for (size, ok) in [(limit, true), (limit + 1, false)] {
            let entries = [
                file("a", &"0".repeat(size / 2)),
                file("b", &"0".repeat(size - size / 2)),
            ];
            let blob = if zip {
                make_zip(&entries)
            } else {
                make_tar_gz(&entries)
            };
            let (_d, root) = tmp();
            let dest = out(&root);
            let r = fetch_archive_with(
                &Ctx::background(),
                &blob_fetch(blob.clone()),
                &target(&blob, 0),
                &dest,
                &root,
                opts(max),
            )
            .await;
            if ok {
                r.unwrap();
            } else {
                assert!(r.unwrap_err().is(Sentinel::ExtractTooLarge), "zip={zip}");
                assert!(!exists(&dest), "zip={zip}: 실패한 조달이 자리를 남겼다");
            }
        }
    }
}

fn fail_staging(from: &str, to: &str) -> io::Result<()> {
    if from.ends_with(".new") {
        return Err(io::Error::other("주입한 실패"));
    }
    crate::goos::rename(from, to)
}

#[tokio::test]
async fn rename_failure_restores_old() {
    let (_d, root) = tmp();
    let dest = out(&root);
    let old = make_tar_gz(&[file("old-file", "old")]);
    fetch_archive(
        &Ctx::background(),
        &blob_fetch(old.clone()),
        &target(&old, 0),
        &dest,
        &cache_dir(&root),
    )
    .await
    .unwrap();
    let next = make_tar_gz(&[file("new-file", "new")]);
    let o = Opts {
        rename: fail_staging,
        ..Opts::default()
    };
    let e = fetch_archive_with(
        &Ctx::background(),
        &blob_fetch(next.clone()),
        &target(&next, 0),
        &dest,
        &cache_dir(&root),
        o,
    )
    .await
    .unwrap_err();
    assert_eq!(e.to_string(), "풀어 둔 것을 옮기지 못했습니다: 주입한 실패");
    assert_eq!(
        std::fs::read_to_string(filepath::join(&[dest.as_str(), "old-file"])).unwrap(),
        "old"
    );
    for ent in std::fs::read_dir(&root).unwrap() {
        let n = ent.unwrap().file_name().to_string_lossy().into_owned();
        assert!(n == "out" || n == "cache", "곁다리가 남았다: {n}");
    }
}

#[tokio::test]
async fn broken_archive_texts() {
    let (_d, root) = tmp();
    let blob = b"not gzip at all".to_vec();
    let e = fetch_to(blob.clone(), &target(&blob, 0), &out(&root))
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "아카이브를 열지 못했습니다: gzip: invalid header"
    );
}
