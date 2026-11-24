use std::fs;
use std::io;
use std::path::Path;

use super::*;

fn never_alive(_: i32) -> bool {
    false
}

fn real_link(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

fn legacy(user: &Path) -> std::path::PathBuf {
    user.join(LEGACY_HOME_DIR)
}

fn new_home(user: &Path) -> std::path::PathBuf {
    user.join(otter_shared_otterenv::DEFAULT_HOME_DIR)
}

// FR-MIG-1·2: 옛 홈만 있으면 이름을 바꾸고 옛 자리에 링크를 남긴다.
#[test]
fn migrates_and_links() {
    let u = tempfile::tempdir().unwrap();
    fs::create_dir(legacy(u.path())).unwrap();
    fs::write(legacy(u.path()).join("settings.json"), b"{}").unwrap();

    let got = migrate_with(u.path(), &never_alive, &real_link).unwrap();

    assert_eq!(got, LegacyHome::Migrated);
    assert_eq!(
        fs::read(new_home(u.path()).join("settings.json")).unwrap(),
        b"{}"
    );
    let meta = fs::symlink_metadata(legacy(u.path())).unwrap();
    assert!(meta.file_type().is_symlink());
    assert_eq!(fs::read_link(legacy(u.path())).unwrap(), new_home(u.path()));
    // 옛 절대 경로가 계속 통한다 (D-5).
    assert_eq!(
        fs::read(legacy(u.path()).join("settings.json")).unwrap(),
        b"{}"
    );
}

// FR-MIG-4: 새 홈이 이미 있으면 옛 홈을 건드리지 않는다.
#[test]
fn new_home_exists_leaves_legacy() {
    let u = tempfile::tempdir().unwrap();
    fs::create_dir(legacy(u.path())).unwrap();
    fs::write(legacy(u.path()).join("a"), b"old").unwrap();
    fs::create_dir(new_home(u.path())).unwrap();

    let got = migrate_with(u.path(), &never_alive, &real_link).unwrap();

    assert_eq!(got, LegacyHome::NewExists);
    assert!(fs::symlink_metadata(legacy(u.path())).unwrap().is_dir());
    assert_eq!(fs::read(legacy(u.path()).join("a")).unwrap(), b"old");
    assert!(!new_home(u.path()).join("a").exists());
}

// FR-MIG-5: 옛 홈이 링크면 아무것도 하지 않는다.
#[test]
fn legacy_link_is_noop() {
    let u = tempfile::tempdir().unwrap();
    let elsewhere = u.path().join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    real_link(&elsewhere, &legacy(u.path())).unwrap();

    let got = migrate_with(u.path(), &never_alive, &real_link).unwrap();

    assert_eq!(got, LegacyHome::LegacyIsLink);
    assert!(!new_home(u.path()).exists());
}

// FR-MIG-5: 옛 홈이 없으면 아무것도 하지 않는다.
#[test]
fn no_legacy_is_noop() {
    let u = tempfile::tempdir().unwrap();

    let got = migrate_with(u.path(), &never_alive, &real_link).unwrap();

    assert_eq!(got, LegacyHome::NoLegacy);
    assert!(!new_home(u.path()).exists());
}

// FR-MIG-3: 옛 판의 데몬이 살아 있으면 옮기지 않고 오류다.
#[test]
fn refuses_while_legacy_daemon_alive() {
    let u = tempfile::tempdir().unwrap();
    fs::create_dir(legacy(u.path())).unwrap();
    fs::write(
        legacy(u.path()).join(otter_shared_otterenv::PANED_PID_FILE),
        b"4242\n",
    )
    .unwrap();
    let alive = |pid: i32| pid == 4242;

    let err = migrate_with(u.path(), &alive, &real_link).unwrap_err();

    assert!(err.contains("4242"), "{err}");
    assert!(err.contains(&*legacy(u.path()).to_string_lossy()), "{err}");
    assert!(fs::symlink_metadata(legacy(u.path())).unwrap().is_dir());
    assert!(!new_home(u.path()).exists());
}

// FR-MIG-3: 죽은 pid 가 남아 있는 것은 실행 중이 아니다.
#[test]
fn stale_pid_file_does_not_block() {
    let u = tempfile::tempdir().unwrap();
    fs::create_dir(legacy(u.path())).unwrap();
    fs::write(
        legacy(u.path()).join(otter_shared_otterenv::PANED_PID_FILE),
        b"4242\n",
    )
    .unwrap();

    let got = migrate_with(u.path(), &never_alive, &real_link).unwrap();

    assert_eq!(got, LegacyHome::Migrated);
}

// FR-MIG-6: rename 이 실패하면 아무것도 바뀌지 않은 채 오류다.
#[test]
fn rename_failure_changes_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let u = tempfile::tempdir().unwrap();
    let user = u.path().join("user");
    fs::create_dir(&user).unwrap();
    fs::create_dir(legacy(&user)).unwrap();
    fs::set_permissions(&user, fs::Permissions::from_mode(0o555)).unwrap();
    // root 는 권한을 무시하므로 이 경우를 만들 수 없다.
    let writable = fs::write(user.join("probe"), b"").is_ok();

    let got = migrate_with(&user, &never_alive, &real_link);

    fs::set_permissions(&user, fs::Permissions::from_mode(0o755)).unwrap();
    if writable {
        return;
    }
    assert!(got.is_err());
    assert!(fs::symlink_metadata(legacy(&user)).unwrap().is_dir());
    assert!(!new_home(&user).exists());
}

// FR-MIG-6: 링크만 실패하면 새 홈으로 계속한다.
#[test]
fn link_failure_keeps_new_home() {
    let u = tempfile::tempdir().unwrap();
    fs::create_dir(legacy(u.path())).unwrap();
    let failing = |_: &Path, _: &Path| -> io::Result<()> { Err(io::Error::other("no link")) };

    let got = migrate_with(u.path(), &never_alive, &failing).unwrap();

    match got {
        LegacyHome::MigratedNoLink(msg) => assert!(msg.contains("no link"), "{msg}"),
        other => panic!("{other:?}"),
    }
    assert!(new_home(u.path()).is_dir());
    assert!(fs::symlink_metadata(legacy(u.path())).is_err());
}

// FR-MIG-7: 사용자에게 알릴 결과만 문구가 있다.
#[test]
fn notice_only_for_changes() {
    assert!(LegacyHome::NoLegacy.notice(Path::new("/u")).is_none());
    assert!(LegacyHome::NewExists.notice(Path::new("/u")).is_none());
    assert!(LegacyHome::LegacyIsLink.notice(Path::new("/u")).is_none());
    let m = LegacyHome::Migrated.notice(Path::new("/u")).unwrap();
    assert!(m.contains(".otterminal"), "{m}");
    let n = LegacyHome::MigratedNoLink("x".into())
        .notice(Path::new("/u"))
        .unwrap();
    assert!(n.contains('x'), "{n}");
}
