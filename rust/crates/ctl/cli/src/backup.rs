//! `dongminal backup`·`restore` — 홈을 zip 하나로 담고 되돌린다 (G4-3).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};

use dm_gocompat::oserr::{go_error_string, path_error};
use dm_gocompat::{filepath, path};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::env::Env;
use crate::homelayout::home_layout;
use crate::options::{Common, ParseError, invalid, unknown_flag};
use crate::start::mkdir_all;

/// 백업 zip 의 권한이다 — 소유자만 읽고 쓴다. 노드 개인키가 들어간다 (PEER_NETWORK_SRS).
const BACKUP_FILE_PERM: u32 = 0o600;

/// `dongminal backup` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackupOpts {
    pub common: Common,
    pub out: String,
}

/// `dongminal restore` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RestoreOpts {
    pub common: Common,
    pub zip: String,
    pub yes: bool,
}

pub fn parse_backup(args: &[String]) -> Result<BackupOpts, ParseError> {
    let mut o = BackupOpts::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-h" || a == "--help" {
            return Err(ParseError::Help);
        } else if a == "--out" || a.starts_with("--out=") {
            let (v, adv) = flag_value(args, i, "--out")?;
            o.out = v;
            i += adv;
        } else if !o.common.take(args, &mut i)? {
            return Err(unknown_flag("backup", a));
        }
        i += 1;
    }
    if o.out.is_empty() {
        return Err(invalid("backup: --out <파일.zip> 이 필요합니다"));
    }
    Ok(o)
}

pub fn parse_restore(args: &[String]) -> Result<RestoreOpts, ParseError> {
    let mut o = RestoreOpts::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-h" || a == "--help" {
            return Err(ParseError::Help);
        } else if a == "--yes" || a == "-y" {
            o.yes = true;
        } else if a.starts_with('-') {
            if !o.common.take(args, &mut i)? {
                return Err(unknown_flag("restore", a));
            }
        } else if o.zip.is_empty() {
            o.zip = a.to_owned();
        } else {
            return Err(invalid(format!("restore: 인자가 너무 많습니다: {a}")));
        }
        i += 1;
    }
    if o.zip.is_empty() {
        return Err(invalid("restore: 백업 파일(.zip)이 필요합니다"));
    }
    Ok(o)
}

/// `--name v` 와 `--name=v` 를 읽는다. 두 번째 값은 소비한 다음 인자 수다.
pub(crate) fn flag_value(
    args: &[String],
    i: usize,
    name: &str,
) -> Result<(String, usize), ParseError> {
    let a = args[i].as_str();
    if let Some(v) = a.strip_prefix(name).and_then(|r| r.strip_prefix('=')) {
        if v.is_empty() {
            return Err(invalid(format!("{name} 에 값이 없습니다")));
        }
        return Ok((v.to_owned(), 0));
    }
    if i + 1 >= args.len() {
        return Err(invalid(format!("{name} 에 값이 없습니다")));
    }
    Ok((args[i + 1].clone(), 1))
}

pub fn run_backup(o: &BackupOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_backup_in(o, &Env::process(), stdout, stderr)
}

/// 담을 것은 `home_layout` 이 소유한다. 소켓·pid·로그는 담지 않는다 — 다음 기동이 다시 만든다.
pub(crate) fn run_backup_in(
    o: &BackupOpts,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let home = match o.common.resolve_home_in(env) {
        Ok(h) => h,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let f = match open_owner_only(&o.out) {
        Ok(f) => f,
        Err(e) => {
            let _ = writeln!(
                stderr,
                "백업 파일을 만들 수 없습니다: {}",
                go_error_string(&path_error("open", &o.out, e))
            );
            return 1;
        }
    };
    // 이미 있던 파일을 덮어쓸 때도 권한을 좁힌다.
    if let Err(e) = chmod_owner_only(&f) {
        let _ = writeln!(
            stderr,
            "백업 파일 권한을 바꿀 수 없습니다: {}",
            go_error_string(&path_error("chmod", &o.out, e))
        );
        return 1;
    }
    let mut z = ZipWriter::new(f);

    let mut n = 0;
    for e in home_layout().into_iter().filter(|e| e.in_backup) {
        let src = filepath::join(&[home.as_str(), e.name]);
        let Ok(st) = fs::symlink_metadata(&src) else {
            continue; // 없는 것은 정상이다
        };
        let res = if st.is_dir() {
            add_dir(&mut z, &src, e.name)
        } else if st.file_type().is_file() {
            add_file(&mut z, &src, e.name).map(|()| 1)
        } else {
            // 소켓·심링크는 담지 않는다.
            continue;
        };
        match res {
            Ok(k) => n += k,
            Err(err) => {
                let _ = writeln!(stderr, "✗ {}: {err}", e.name);
                return 1;
            }
        }
    }
    if let Err(e) = z.finish() {
        let _ = writeln!(stderr, "백업을 닫지 못했습니다: {e}");
        return 1;
    }
    let _ = writeln!(stdout, "✅ 백업 {n}개 항목: {}", o.out);
    let _ = writeln!(
        stdout,
        "   담기지 않은 것: 로그·소켓·pid·런타임 헬퍼 — 다음 기동이 다시 만듭니다."
    );
    0
}

fn open_owner_only(p: &str) -> io::Result<File> {
    let mut o = OpenOptions::new();
    o.create(true).truncate(true).write(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, BACKUP_FILE_PERM);
    o.open(p)
}

fn chmod_owner_only(f: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(fs::Permissions::from_mode(BACKUP_FILE_PERM))
    }
    #[cfg(not(unix))]
    {
        let _ = (f, BACKUP_FILE_PERM);
        Ok(())
    }
}

fn add_file(z: &mut ZipWriter<File>, src: &str, name: &str) -> Result<(), String> {
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    z.start_file(name, opts).map_err(|e| e.to_string())?;
    let mut r = File::open(src).map_err(|e| go_error_string(&path_error("open", src, e)))?;
    io::copy(&mut r, z)
        .map(drop)
        .map_err(|e| go_error_string(&e))
}

/// Go `filepath.WalkDir` 처럼 이름 순으로 내려가며 일반 파일만 담는다.
fn add_dir(z: &mut ZipWriter<File>, root: &str, prefix: &str) -> Result<usize, String> {
    let mut n = 0;
    walk(z, root, prefix, &mut n)?;
    Ok(n)
}

fn walk(z: &mut ZipWriter<File>, dir: &str, prefix: &str, n: &mut usize) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| go_error_string(&path_error("open", dir, e)))?;
    let mut names: Vec<String> = rd
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        let p = filepath::join(&[dir, name.as_str()]);
        let zname = path::join(&[prefix, name.as_str()]);
        let Ok(st) = fs::symlink_metadata(&p) else {
            continue;
        };
        if st.is_dir() {
            walk(z, &p, &zname, n)?;
        } else if st.file_type().is_file() {
            add_file(z, &p, &zname)?;
            *n += 1;
        }
    }
    Ok(())
}

pub fn run_restore(o: &RestoreOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_restore_in(o, &Env::process(), stdout, stderr)
}

/// Go `zip.OpenReader` 의 오류 문구다.
fn open_zip(p: &str) -> Result<ZipArchive<File>, String> {
    let f = File::open(p).map_err(|e| go_error_string(&path_error("open", p, e)))?;
    ZipArchive::new(f).map_err(|e| match e {
        zip::result::ZipError::InvalidArchive(_) => "zip: not a valid zip file".to_owned(),
        zip::result::ZipError::Io(e) => go_error_string(&e),
        e => e.to_string(),
    })
}

/// **담긴 것만 되돌린다.** 담기지 않은 것은 건드리지 않는다 — 복원이 로그를 지우면 사고 직후의
/// 증거가 사라진다.
pub(crate) fn run_restore_in(
    o: &RestoreOpts,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let home = match o.common.resolve_home_in(env) {
        Ok(h) => h,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let mut r = match open_zip(&o.zip) {
        Ok(r) => r,
        Err(e) => {
            let _ = writeln!(stderr, "백업을 열 수 없습니다: {e}");
            return 1;
        }
    };
    let _ = writeln!(stdout, "홈: {home}\n백업: {} ({}개 항목)", o.zip, r.len());
    if !o.yes {
        // 되돌릴 길을 말하지 않는 확인은 확인이 아니다.
        let _ = writeln!(stderr, "\n지금 홈의 파일을 덮어씁니다. 되돌릴 수 없습니다.");
        let _ = writeln!(stderr, "진행하려면 --yes 를 함께 주세요.");
        let _ = writeln!(
            stderr,
            "먼저 지금 것을 담아 두려면: dongminal backup --out <파일.zip>"
        );
        return 1;
    }

    let (mut done, mut skipped) = (0, 0);
    for i in 0..r.len() {
        let mut f = match r.by_index(i) {
            Ok(f) => f,
            Err(e) => {
                let _ = writeln!(stderr, "✗ {e}");
                return 1;
            }
        };
        let name = String::from_utf8_lossy(f.name_raw()).into_owned();
        let Some(dst) = safe_join(&home, &name) else {
            // zip slip. 조용히 넘기지 않는다 — 건너뛴 사실을 말한다.
            let _ = writeln!(stderr, "건너뜀 (홈 밖을 가리킵니다): {name}");
            skipped += 1;
            continue;
        };
        if name.ends_with('/') {
            continue;
        }
        if let Err(e) = mkdir_all(&filepath::dir(&dst), 0o700) {
            let _ = writeln!(stderr, "✗ {name}: {}", go_error_string(&e));
            return 1;
        }
        let mut oo = OpenOptions::new();
        oo.create(true).truncate(true).write(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut oo, 0o600);
        let mut out = match oo.open(&dst) {
            Ok(o) => o,
            Err(e) => {
                let _ = writeln!(
                    stderr,
                    "✗ {name}: {}",
                    go_error_string(&path_error("open", &dst, e))
                );
                return 1;
            }
        };
        if let Err(e) = io::copy(&mut f, &mut out) {
            let _ = writeln!(stderr, "✗ {name}: {}", go_error_string(&e));
            return 1;
        }
        done += 1;
    }
    let _ = writeln!(stdout, "✅ {done}개를 되돌렸습니다.");
    if skipped > 0 {
        let _ = writeln!(stdout, "   {skipped}개는 건너뛰었습니다 (홈 밖을 가리킴).");
    }
    let _ = writeln!(stdout, "   돌고 있는 서버가 있으면 다시 띄워야 반영됩니다.");
    0
}

/// zip 항목 이름을 홈 아래 경로로 옮긴다. 밖으로 나가면 `None` 이다.
pub(crate) fn safe_join(home: &str, name: &str) -> Option<String> {
    if name.is_empty() || name.starts_with('/') || filepath::is_abs(name) {
        return None;
    }
    // `path::clean` 이 `../` 를 접는다. 접고도 남으면 밖으로 나가는 것이다.
    let clean = path::clean(name);
    if clean == ".." || clean.starts_with("../") {
        return None;
    }
    let dst = filepath::join(&[home, filepath::from_slash(&clean).as_str()]);
    let sep = std::path::MAIN_SEPARATOR;
    match filepath::rel(home, &dst) {
        Ok(rel) if rel != ".." && !rel.starts_with(&format!("..{sep}")) => Some(dst),
        _ => None,
    }
}
