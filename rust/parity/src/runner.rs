//! 쪽 실행, 정리, 비교 (SPEC 2.2·2.5).

use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::http;
use crate::normalize::{SideVars, normalize};
use crate::scenario::{Cli, Http, MIN_PORT, PH_HOME, PH_PORT, PH_ROOT, Scenario, Serve, Step};

pub const ENV_PORT_BASE: &str = "DM_PARITY_PORT_BASE";
pub const DEFAULT_PORT_BASE: u16 = 60400;
/// 포트를 고를 때 넘겨 볼 최대 개수.
const PORT_SEARCH_SPAN: u16 = 200;
const PORT_PROBE_TIMEOUT: Duration = Duration::from_millis(200);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// 정리할 때 TERM 뒤 사라지기를 기다리는 상한.
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(5);
/// Go 기준선 `dmenv.PanedPIDFile`.
const DAEMON_PID_FILE: &str = "paned.pid";
/// Go 기준선 `platform.SocketFileName`.
const DAEMON_SOCK_FILE: &str = "paned.sock";
/// 유닉스 소켓 경로 한도(macOS `sun_path` 104바이트, 끝 NUL 제외).
const MAX_SOCKET_PATH: usize = 103;
const ROOT_NAME_TRIES: u32 = 64;
const HOME_DIR: &str = "dmhome";
/// 운영 바이너리 (RUST_PORT_SRS C-RSP-1, `rust/scripts/prod-pids.sh`).
const PROD_BINARY: &str = "/Users/dykim/personal/dongminal/dongminal";
const PROD_HOME_DIR: &str = ".dongminal";
/// 자식 환경에서 지우는 접두어 (C-PAR-1).
const SCRUBBED_ENV_PREFIXES: &[&str] = &["DONGMINAL_", "DM_E2E_"];

pub const OBS_STDOUT: &str = "stdout";
pub const OBS_STDERR: &str = "stderr";
pub const OBS_EXIT: &str = "exit";
pub const OBS_ERROR: &str = "error";
pub const OBS_READY: &str = "ready";
pub const OBS_STATUS: &str = "status";
pub const OBS_BODY: &str = "body";
pub const OBS_TREE: &str = "home-tree";
const ABSENT: &str = "<absent>";
const HOME_STEP_LABEL: &str = "home";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Go,
    Rust,
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Side::Go => "go",
            Side::Rust => "rust",
        })
    }
}

#[derive(Debug, Clone)]
pub struct Options {
    pub port_base: u16,
    /// 쪽 뿌리를 지우지 않는다.
    pub keep: bool,
    /// 쪽 뿌리를 만들 디렉터리.
    pub work_dir: PathBuf,
}

impl Options {
    /// 환경(`DM_PARITY_PORT_BASE`, `DM_HERMETIC_ROOT`, 임시 디렉터리)에서 만든다.
    pub fn from_env() -> Result<Self, String> {
        let port_base = match std::env::var(ENV_PORT_BASE) {
            Ok(v) => v
                .parse::<u16>()
                .map_err(|_| format!("{ENV_PORT_BASE}={v:?} 는 포트가 아니다"))?,
            Err(_) => DEFAULT_PORT_BASE,
        };
        let work_dir = std::env::var_os("DM_HERMETIC_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let o = Self {
            port_base,
            keep: false,
            work_dir,
        };
        o.check()?;
        Ok(o)
    }

    pub fn check(&self) -> Result<(), String> {
        if self.port_base < MIN_PORT {
            return Err(format!(
                "포트 시작 값 {} 는 운영 범위다. {MIN_PORT} 이상을 쓴다",
                self.port_base
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct Observation {
    pub step: usize,
    pub step_label: String,
    pub name: String,
    pub value: Vec<u8>,
}

#[derive(Debug)]
pub struct SideRun {
    pub side: Side,
    pub vars: SideVars,
    pub observations: Vec<Observation>,
    pub root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diff {
    pub step: usize,
    pub step_label: String,
    pub name: String,
    /// 처음 다른 줄 (1부터).
    pub line: usize,
    pub go_line: Option<String>,
    pub rust_line: Option<String>,
    pub go_len: Option<usize>,
    pub rust_len: Option<usize>,
}

impl fmt::Display for Diff {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let len = |l: Option<usize>| l.map_or_else(|| "없음".to_string(), |n| format!("{n}B"));
        writeln!(
            f,
            "  단계 {} [{}] {}: {}번째 줄이 다르다 (go {}, rust {})",
            self.step,
            self.step_label,
            self.name,
            self.line,
            len(self.go_len),
            len(self.rust_len)
        )?;
        let line = |l: &Option<String>| {
            l.as_deref()
                .map_or_else(|| "(없음)".to_string(), |s| format!("{s:?}"))
        };
        writeln!(f, "    go:   {}", line(&self.go_line))?;
        write!(f, "    rust: {}", line(&self.rust_line))
    }
}

#[derive(Debug)]
pub struct Report {
    pub scenario: String,
    /// 시나리오 자체의 오류 (실행하지 않았다).
    pub errors: Vec<String>,
    pub diffs: Vec<Diff>,
    pub roots: Vec<PathBuf>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.errors.is_empty() && self.diffs.is_empty()
    }
}

/// 쪽 바이너리 검사 (C-PAR-5).
pub fn check_binary(bin: &Path) -> Result<PathBuf, String> {
    let canon = fs::canonicalize(bin)
        .map_err(|e| format!("바이너리 {} 를 찾을 수 없다: {e}", bin.display()))?;
    if canon == Path::new(PROD_BINARY)
        || canon
            .components()
            .any(|c| c == Component::Normal(PROD_HOME_DIR.as_ref()))
    {
        return Err(format!("운영 바이너리는 쓰지 않는다: {}", canon.display()));
    }
    if !canon.is_file() {
        return Err(format!("{} 는 파일이 아니다", canon.display()));
    }
    Ok(canon)
}

/// 시나리오 하나를 두 쪽에서 돌리고 비교한다.
pub fn run_scenario(scenario: &Scenario, go_bin: &Path, rust_bin: &Path, opts: &Options) -> Report {
    let mut report = Report {
        scenario: scenario.name.clone(),
        errors: scenario.validate(),
        diffs: Vec::new(),
        roots: Vec::new(),
    };
    if let Err(e) = opts.check() {
        report.errors.push(e);
    }
    let bins = match (check_binary(go_bin), check_binary(rust_bin)) {
        (Ok(g), Ok(r)) => Some((g, r)),
        (g, r) => {
            report.errors.extend(g.err());
            report.errors.extend(r.err());
            None
        }
    };
    let Some((go_bin, rust_bin)) = bins.filter(|_| report.errors.is_empty()) else {
        return report;
    };
    let mut next_port = opts.port_base;
    let mut runs = Vec::new();
    for (side, bin) in [(Side::Go, &go_bin), (Side::Rust, &rust_bin)] {
        match run_side(scenario, side, bin, opts, &mut next_port) {
            Ok(run) => runs.push(run),
            Err(e) => report.errors.push(format!("{side}: {e}")),
        }
    }
    report.roots = runs.iter().map(|r| r.root.clone()).collect();
    if let [go, rust] = runs.as_slice() {
        report.diffs = compare(scenario, go, rust);
    }
    if !opts.keep {
        for r in &runs {
            let _ = fs::remove_dir_all(&r.root);
        }
    }
    report
}

/// 한 쪽을 돌린다. 오류는 쪽 뿌리를 만들지 못한 것 같은 설정 오류뿐이고,
/// 실행 중 오류는 관측값(`error`)으로 남는다 (FR-PAR-32).
pub fn run_side(
    scenario: &Scenario,
    side: Side,
    bin: &Path,
    opts: &Options,
    next_port: &mut u16,
) -> Result<SideRun, String> {
    let root = make_root(&opts.work_dir, side)?;
    let user_home = root.join("home");
    let home = root.join(HOME_DIR);
    for d in [&user_home, &home, &root.join("bin")] {
        fs::create_dir_all(d).map_err(|e| format!("{} 생성 실패: {e}", d.display()))?;
    }
    let port = if scenario.needs_port() {
        match pick_port(next_port) {
            Ok(p) => Some(p),
            Err(e) => {
                let _ = fs::remove_dir_all(&root);
                return Err(e);
            }
        }
    } else {
        None
    };
    let vars = SideVars {
        home: path_str(&home),
        user_home: path_str(&user_home),
        root: path_str(&root),
        bin: path_str(bin),
        port,
    };
    let mut ctx = SideCtx {
        bin: bin.to_path_buf(),
        vars,
        servers: Vec::new(),
        obs: Vec::new(),
        seq: 0,
    };
    for (i, step) in scenario.steps.iter().enumerate() {
        let label = step.label();
        match step {
            Step::Run(cli) => ctx.run_cli(i, &label, cli),
            Step::WriteHome { path, contents } => ctx.write_home(i, &label, path, contents),
            Step::Serve(s) => ctx.serve(i, &label, s),
            Step::Http(h) => ctx.http(i, &label, h),
        }
    }
    ctx.teardown();
    let n = scenario.steps.len();
    for f in &scenario.files {
        let value = fs::read(home.join(f)).unwrap_or_else(|_| ABSENT.as_bytes().to_vec());
        ctx.push(n, HOME_STEP_LABEL, &format!("file:{f}"), value);
    }
    if let Some(exclude) = &scenario.tree {
        let mut paths = Vec::new();
        walk(&home, "", &mut paths);
        paths.retain(|p| !exclude.iter().any(|e| p.starts_with(e.as_str())));
        paths.sort();
        ctx.push(n, HOME_STEP_LABEL, OBS_TREE, paths.join("\n").into_bytes());
    }
    Ok(SideRun {
        side,
        vars: ctx.vars,
        observations: ctx.obs,
        root,
    })
}

/// 정규화한 관측값을 (단계, 이름) 순서로 맞댄다 (FR-PAR-30·31).
pub fn compare(scenario: &Scenario, go: &SideRun, rust: &SideRun) -> Vec<Diff> {
    let norm =
        |run: &SideRun, o: &Observation| normalize(&o.name, &o.value, &run.vars, &scenario.rules);
    let mut diffs = Vec::new();
    let mut rust_used = vec![false; rust.observations.len()];
    for g in &go.observations {
        let found = rust
            .observations
            .iter()
            .enumerate()
            .find(|(j, r)| !rust_used[*j] && r.step == g.step && r.name == g.name);
        let gv = norm(go, g);
        match found {
            Some((j, r)) => {
                rust_used[j] = true;
                let rv = norm(rust, r);
                if gv != rv {
                    diffs.push(diff_of(g, Some(&gv), Some(&rv)));
                }
            }
            None => diffs.push(diff_of(g, Some(&gv), None)),
        }
    }
    for (j, r) in rust.observations.iter().enumerate() {
        if !rust_used[j] {
            diffs.push(diff_of(r, None, Some(&norm(rust, r))));
        }
    }
    diffs.sort_by_key(|d| d.step);
    diffs
}

fn diff_of(o: &Observation, go: Option<&[u8]>, rust: Option<&[u8]>) -> Diff {
    let lines = |v: Option<&[u8]>| -> Option<Vec<String>> {
        v.map(|b| {
            String::from_utf8_lossy(b)
                .split('\n')
                .map(String::from)
                .collect()
        })
    };
    let (gl, rl) = (lines(go), lines(rust));
    let idx = match (&gl, &rl) {
        (Some(a), Some(b)) => (0..a.len().max(b.len()))
            .find(|&i| a.get(i) != b.get(i))
            .unwrap_or(0),
        _ => 0,
    };
    let at = |l: &Option<Vec<String>>| l.as_ref().and_then(|v| v.get(idx).cloned());
    Diff {
        step: o.step,
        step_label: o.step_label.clone(),
        name: o.name.clone(),
        line: idx + 1,
        go_line: at(&gl),
        rust_line: at(&rl),
        go_len: go.map(<[u8]>::len),
        rust_len: rust.map(<[u8]>::len),
    }
}

struct SideCtx {
    bin: PathBuf,
    vars: SideVars,
    servers: Vec<Child>,
    obs: Vec<Observation>,
    seq: usize,
}

impl SideCtx {
    fn push(&mut self, step: usize, label: &str, name: &str, value: Vec<u8>) {
        self.obs.push(Observation {
            step,
            step_label: label.to_string(),
            name: name.to_string(),
            value,
        });
    }

    fn subst(&self, s: &str) -> String {
        let mut out = s
            .replace(PH_HOME, &self.vars.home)
            .replace(PH_ROOT, &self.vars.root);
        if let Some(p) = self.vars.port {
            out = out.replace(PH_PORT, &p.to_string());
        }
        out
    }

    fn command(&self, program: &Path, args: &[String], env: &[(String, String)]) -> Command {
        let mut cmd = Command::new(program);
        cmd.args(args.iter().map(|a| self.subst(a)));
        for (k, _) in std::env::vars_os() {
            let k = k.to_string_lossy();
            if SCRUBBED_ENV_PREFIXES.iter().any(|p| k.starts_with(p)) {
                cmd.env_remove(k.as_ref());
            }
        }
        cmd.env("HOME", &self.vars.user_home)
            .env("DONGMINAL_HOME", &self.vars.home)
            .env("DONGMINAL_NO_UPDATE_CHECK", "1");
        for (k, v) in env {
            cmd.env(k, self.subst(v));
        }
        cmd.current_dir(&self.vars.root);
        cmd
    }

    fn capture_files(&mut self) -> Result<(PathBuf, PathBuf, fs::File, fs::File), String> {
        self.seq += 1;
        let root = Path::new(&self.vars.root);
        let out = root.join(format!(".parity-{}.stdout", self.seq));
        let err = root.join(format!(".parity-{}.stderr", self.seq));
        let fo = fs::File::create(&out).map_err(|e| e.to_string())?;
        let fe = fs::File::create(&err).map_err(|e| e.to_string())?;
        Ok((out, err, fo, fe))
    }

    fn program_for(&self, argv0: Option<&str>) -> Result<PathBuf, String> {
        let Some(name) = argv0 else {
            return Ok(self.bin.clone());
        };
        let link = Path::new(&self.vars.root)
            .join("bin")
            .join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        if !link.exists() {
            link_binary(&self.bin, &link).map_err(|e| format!("argv0 {name} 링크 실패: {e}"))?;
        }
        Ok(link)
    }

    fn run_cli(&mut self, i: usize, label: &str, cli: &Cli) {
        match self.exec_cli(cli) {
            Ok((stdout, stderr, status)) => {
                self.push(i, label, OBS_STDOUT, stdout);
                self.push(i, label, OBS_STDERR, stderr);
                self.push(i, label, OBS_EXIT, status.into_bytes());
            }
            Err(e) => self.push(i, label, OBS_ERROR, e.into_bytes()),
        }
    }

    fn exec_cli(&mut self, cli: &Cli) -> Result<(Vec<u8>, Vec<u8>, String), String> {
        let program = self.program_for(cli.argv0.as_deref())?;
        let (out_path, err_path, fo, fe) = self.capture_files()?;
        let mut cmd = self.command(&program, &cli.args, &cli.env);
        cmd.stdout(fo).stderr(fe).stdin(if cli.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        let mut child = cmd.spawn().map_err(|e| format!("실행 실패: {e}"))?;
        if let (Some(data), Some(mut pipe)) = (&cli.stdin, child.stdin.take()) {
            use std::io::Write;
            let _ = pipe.write_all(data);
        }
        let status = wait_timeout(&mut child, cli.timeout).map_err(|e| e.to_string())?;
        let Some(status) = status else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("제한 시간 {}초 초과", cli.timeout.as_secs()));
        };
        let stdout = fs::read(&out_path).unwrap_or_default();
        let stderr = fs::read(&err_path).unwrap_or_default();
        Ok((stdout, stderr, exit_text(status)))
    }

    fn write_home(&mut self, i: usize, label: &str, path: &str, contents: &[u8]) {
        let target = Path::new(&self.vars.home).join(path);
        let data = self.subst(&String::from_utf8_lossy(contents));
        let res = target
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|_| fs::write(&target, data));
        if let Err(e) = res {
            self.push(i, label, OBS_ERROR, format!("쓰기 실패: {e}").into_bytes());
        }
    }

    fn serve(&mut self, i: usize, label: &str, s: &Serve) {
        let result = self.start_server(s);
        let value = match result {
            Ok(()) => "ok".to_string(),
            Err(e) => e,
        };
        self.push(i, label, OBS_READY, value.into_bytes());
    }

    fn start_server(&mut self, s: &Serve) -> Result<(), String> {
        let port = self.vars.port.ok_or("포트가 없다")?;
        let (_, _, fo, fe) = self.capture_files()?;
        let mut cmd = self.command(&self.bin, &s.args, &s.env);
        cmd.stdout(fo).stderr(fe).stdin(Stdio::null());
        let child = cmd.spawn().map_err(|e| format!("실행 실패: {e}"))?;
        self.servers.push(child);
        let path = self.subst(&s.ready_path);
        let deadline = Instant::now() + s.timeout;
        loop {
            if let Some(child) = self.servers.last_mut()
                && let Ok(Some(st)) = child.try_wait()
            {
                return Err(format!("준비 전에 끝났다: {}", exit_text(st)));
            }
            if http::request(port, "GET", &path, &[], b"", READY_POLL_INTERVAL * 10).is_ok() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "제한 시간 {}초 안에 준비되지 않았다",
                    s.timeout.as_secs()
                ));
            }
            std::thread::sleep(READY_POLL_INTERVAL);
        }
    }

    fn http(&mut self, i: usize, label: &str, h: &Http) {
        let Some(port) = self.vars.port else {
            self.push(i, label, OBS_ERROR, "포트가 없다".as_bytes().to_vec());
            return;
        };
        let headers: Vec<(String, String)> = h
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), self.subst(v)))
            .collect();
        match http::request(
            port,
            &h.method,
            &self.subst(&h.path),
            &headers,
            &h.body,
            h.timeout,
        ) {
            Ok(resp) => {
                self.push(i, label, OBS_STATUS, resp.status.clone().into_bytes());
                for (name, value) in resp.compared_headers(&h.compare_headers) {
                    self.push(i, label, &name, value);
                }
                self.push(i, label, OBS_BODY, resp.body);
            }
            Err(e) => self.push(i, label, OBS_ERROR, e.into_bytes()),
        }
    }

    /// C-PAR-4: 내가 띄운 자식과, 이 쪽 홈의 pid 파일이 가리키는 이 쪽 바이너리만 끈다.
    fn teardown(&mut self) {
        for mut child in self.servers.drain(..) {
            stop_child(&mut child);
        }
        let pid_file = Path::new(&self.vars.home).join(DAEMON_PID_FILE);
        let pid = fs::read_to_string(&pid_file)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok());
        if let Some(pid) = pid.filter(|&p| p > 1)
            && process_runs_binary(pid, &self.bin)
        {
            stop_pid(pid);
        }
    }
}

/// 쪽 뿌리는 짧은 이름으로 만든다. 홈 아래 유닉스 소켓(`paned.sock`) 경로가
/// OS 한도(macOS 104바이트)를 넘으면 데몬이 바인드하지 못한다.
fn make_root(work_dir: &Path, side: Side) -> Result<PathBuf, String> {
    let tag = match side {
        Side::Go => 'g',
        Side::Rust => 'r',
    };
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    for n in 0..ROOT_NAME_TRIES {
        let root = work_dir.join(format!("p{tag}{:06x}", (seed.wrapping_add(n)) & 0xff_ffff));
        match fs::create_dir(&root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{} 생성 실패: {e}", root.display())),
        }
        let root = fs::canonicalize(&root).map_err(|e| e.to_string())?;
        let sock = root.join(HOME_DIR).join(DAEMON_SOCK_FILE);
        if sock.as_os_str().len() > MAX_SOCKET_PATH {
            let _ = fs::remove_dir_all(&root);
            return Err(format!(
                "쪽 뿌리 경로가 길어 데몬 소켓({}바이트)이 한도 {MAX_SOCKET_PATH} 를 넘는다. 짧은 DM_HERMETIC_ROOT 를 쓴다: {}",
                sock.as_os_str().len(),
                sock.display()
            ));
        }
        return Ok(root);
    }
    Err(format!(
        "{} 아래에 쪽 뿌리를 만들지 못했다",
        work_dir.display()
    ))
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// 이 프로세스가 이미 내준 포트. 비어 보여도 다시 내주지 않는다 — 앞서 내준 서버가
/// 아직 바인드하기 전일 수 있고, Go `start` 는 포트를 쥔 프로세스를 종료한다.
static HANDED_OUT: Mutex<BTreeSet<u16>> = Mutex::new(BTreeSet::new());

/// C-PAR-2: `next` 부터 비어 있는 포트를 고르고 `next` 를 그 다음으로 옮긴다.
pub fn pick_port(next: &mut u16) -> Result<u16, String> {
    let start = *next;
    for _ in 0..PORT_SEARCH_SPAN {
        let p = *next;
        if p < MIN_PORT {
            return Err(format!("포트 {p} 는 운영 범위다"));
        }
        *next = next.checked_add(1).ok_or("포트 범위를 넘었다")?;
        let mut handed = HANDED_OUT.lock().map_err(|_| "포트 예약 잠금 오류")?;
        if !handed.contains(&p) && port_free(p) {
            handed.insert(p);
            return Ok(p);
        }
    }
    Err(format!(
        "{start} 부터 {PORT_SEARCH_SPAN}개 안에 빈 포트가 없다"
    ))
}

fn port_free(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    if TcpStream::connect_timeout(&addr, PORT_PROBE_TIMEOUT).is_ok() {
        return false;
    }
    TcpListener::bind(addr).is_ok() && TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok()
}

fn wait_timeout(child: &mut Child, timeout: Duration) -> std::io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(st) = child.try_wait()? {
            return Ok(Some(st));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn exit_text(status: ExitStatus) -> String {
    if let Some(code) = status.code() {
        return code.to_string();
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return format!("signal {sig}");
        }
    }
    "unknown".to_string()
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
        if is_dir {
            out.push(format!("{rel}/"));
            walk(&e.path(), &rel, out);
        } else {
            out.push(rel);
        }
    }
}

#[cfg(unix)]
fn link_binary(bin: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(bin, link)
}

#[cfg(not(unix))]
fn link_binary(bin: &Path, link: &Path) -> std::io::Result<()> {
    fs::copy(bin, link).map(|_| ())
}

#[cfg(unix)]
fn signal(pid: u32, sig: &str) -> bool {
    Command::new("kill")
        .args([sig, &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(unix)]
fn stop_child(child: &mut Child) {
    signal(child.id(), "-TERM");
    if !matches!(wait_timeout(child, STOP_GRACE), Ok(Some(_))) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(not(unix))]
fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn stop_pid(pid: u32) {
    if !signal(pid, "-TERM") {
        return;
    }
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline {
        if !signal(pid, "-0") {
            return;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    signal(pid, "-KILL");
}

#[cfg(not(unix))]
fn stop_pid(_pid: u32) {}

/// pid 의 실행 파일이 `bin` 인지 본다. 모르면 거짓이다(끄지 않는다).
#[cfg(unix)]
fn process_runs_binary(pid: u32, bin: &Path) -> bool {
    let Ok(want) = fs::canonicalize(bin) else {
        return false;
    };
    let exe = fs::read_link(format!("/proc/{pid}/exe")).ok().or_else(|| {
        let out = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .ok()?;
        let s = String::from_utf8(out.stdout).ok()?;
        let s = s.trim();
        (!s.is_empty()).then(|| PathBuf::from(s))
    });
    exe.and_then(|p| fs::canonicalize(p).ok())
        .is_some_and(|p| p == want)
}

#[cfg(not(unix))]
fn process_runs_binary(_pid: u32, _bin: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(step: usize, name: &str, v: &str) -> Observation {
        Observation {
            step,
            step_label: format!("s{step}"),
            name: name.into(),
            value: v.as_bytes().to_vec(),
        }
    }

    fn run(side: Side, o: Vec<Observation>) -> SideRun {
        SideRun {
            side,
            vars: SideVars::default(),
            observations: o,
            root: PathBuf::new(),
        }
    }

    #[test]
    fn equal_observations_have_no_diff() {
        let s = Scenario::new("x");
        let a = run(
            Side::Go,
            vec![obs(0, "stdout", "a\nb"), obs(0, "exit", "0")],
        );
        let b = run(
            Side::Rust,
            vec![obs(0, "stdout", "a\nb"), obs(0, "exit", "0")],
        );
        assert!(compare(&s, &a, &b).is_empty());
    }

    #[test]
    fn diff_reports_first_different_line() {
        let s = Scenario::new("x");
        let a = run(Side::Go, vec![obs(0, "stdout", "a\nb\nc")]);
        let b = run(Side::Rust, vec![obs(0, "stdout", "a\nB\nc")]);
        let d = compare(&s, &a, &b);
        assert_eq!(d.len(), 1);
        assert_eq!(
            (
                d[0].line,
                d[0].go_line.as_deref(),
                d[0].rust_line.as_deref()
            ),
            (2, Some("b"), Some("B"))
        );
        let text = d[0].to_string();
        assert!(
            text.contains("단계 0 [s0] stdout: 2번째 줄이 다르다 (go 5B, rust 5B)"),
            "{text}"
        );
        assert!(
            text.contains("go:   \"b\"") && text.contains("rust: \"B\""),
            "{text}"
        );
    }

    #[test]
    fn one_sided_observations_are_diffs() {
        let s = Scenario::new("x");
        let a = run(Side::Go, vec![obs(0, "header:x", "1")]);
        let b = run(Side::Rust, vec![obs(1, "error", "boom")]);
        let d = compare(&s, &a, &b);
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].go_len, d[0].rust_len), (Some(1), None));
        assert_eq!((d[1].go_len, d[1].rust_len), (None, Some(4)));
    }

    #[test]
    fn scenario_rules_apply_before_compare() {
        let s = Scenario::new("x").normalize(crate::Rule::rfc3339());
        let a = run(Side::Go, vec![obs(0, "stdout", "t=2026-01-01T00:00:00Z")]);
        let b = run(
            Side::Rust,
            vec![obs(0, "stdout", "t=2027-02-02T01:01:01.5+09:00")],
        );
        assert!(compare(&s, &a, &b).is_empty());
    }

    #[test]
    fn port_base_below_minimum_is_rejected() {
        let o = Options {
            port_base: 60146,
            keep: false,
            work_dir: std::env::temp_dir(),
        };
        assert!(o.check().is_err());
        let mut next = 60146;
        assert!(pick_port(&mut next).is_err());
    }

    #[test]
    fn pick_port_skips_held_port() {
        let (p, _held) = (64000..65000)
            .find_map(|p| {
                TcpListener::bind((Ipv4Addr::LOCALHOST, p))
                    .ok()
                    .map(|l| (p, l))
            })
            .unwrap();
        let mut next = p;
        let got = pick_port(&mut next).unwrap();
        assert_ne!(got, p);
        assert!(next > got);
    }

    #[test]
    fn pick_port_never_hands_out_same_port_twice() {
        let mut a = 64500;
        let mut b = 64500;
        let first = pick_port(&mut a).unwrap();
        let second = pick_port(&mut b).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn prod_binary_is_rejected() {
        assert!(check_binary(Path::new("/nonexistent/dongminal")).is_err());
        let dir = tempfile::tempdir().unwrap();
        let inside = dir.path().join(PROD_HOME_DIR).join("bin");
        fs::create_dir_all(&inside).unwrap();
        let f = inside.join("dmctl");
        fs::write(&f, "").unwrap();
        assert!(check_binary(&f).unwrap_err().contains("운영"));
    }
}
