//! 시나리오 정의 API (SPEC FR-PAR-1~4).

use std::time::Duration;

use crate::normalize::Rule;

pub const DEFAULT_CLI_TIMEOUT: Duration = Duration::from_secs(30);
/// e2e 의 서버 기동 대기(`pingUntilUp` 90초)와 같다.
pub const DEFAULT_SERVE_TIMEOUT: Duration = Duration::from_secs(90);
pub const DEFAULT_HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// C-RSP-1: 격리 실행이 쓸 수 있는 가장 낮은 포트.
pub const MIN_PORT: u16 = 60147;

/// 서버에 요청을 보낼 수 있는 헬퍼. 격리 홈에 주소 파일이 없으면 기본 포트로 붙으므로
/// 같은 시나리오에서 격리 서버를 먼저 띄운 뒤에만 실행한다 (SPEC C-PAR-7).
const NETWORK_HELPERS: &[&str] = &["dmctl", "edit", "detach", "open-url"];
/// 진짜 프로그램을 실행하는 셈. 시나리오에 넣지 않는다 (C-PAR-7).
const FORBIDDEN_ARGV0: &[&str] = &["claude", "dongminald"];

pub const PH_HOME: &str = "{home}";
pub const PH_ROOT: &str = "{root}";
pub const PH_PORT: &str = "{port}";

#[derive(Debug, Clone)]
pub struct Cli {
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) argv0: Option<String>,
    pub(crate) timeout: Duration,
}

impl Cli {
    pub fn new<I, S>(args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            args: args.into_iter().map(Into::into).collect(),
            env: Vec::new(),
            stdin: None,
            argv0: None,
            timeout: DEFAULT_CLI_TIMEOUT,
        }
    }

    pub fn env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.to_string(), value.to_string()));
        self
    }

    pub fn stdin(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(data.into());
        self
    }

    /// argv[0] 의 basename 을 정한다(multi-call 헬퍼: `dmctl`, `edit` …).
    pub fn argv0(mut self, name: &str) -> Self {
        self.argv0 = Some(name.to_string());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[derive(Debug, Clone)]
pub struct Serve {
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) ready_path: String,
    pub(crate) timeout: Duration,
}

impl Serve {
    pub fn new<I, S>(args: I, ready_path: &str) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            args: args.into_iter().map(Into::into).collect(),
            env: Vec::new(),
            ready_path: ready_path.to_string(),
            timeout: DEFAULT_SERVE_TIMEOUT,
        }
    }

    pub fn env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.to_string(), value.to_string()));
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[derive(Debug, Clone)]
pub struct Http {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
    pub(crate) compare_headers: Vec<String>,
    pub(crate) timeout: Duration,
}

impl Http {
    pub fn new(method: &str, path: &str) -> Self {
        Self {
            method: method.to_string(),
            path: path.to_string(),
            headers: Vec::new(),
            body: Vec::new(),
            compare_headers: Vec::new(),
            timeout: DEFAULT_HTTP_TIMEOUT,
        }
    }

    pub fn get(path: &str) -> Self {
        Self::new("GET", path)
    }

    pub fn header(mut self, key: &str, value: &str) -> Self {
        self.headers.push((key.to_string(), value.to_string()));
        self
    }

    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }

    /// 기본 목록(SPEC FR-PAR-21)에 없는 응답 헤더를 비교 대상에 더한다.
    pub fn compare_header(mut self, name: &str) -> Self {
        self.compare_headers.push(name.to_string());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[derive(Debug, Clone)]
pub enum Step {
    Run(Cli),
    WriteHome { path: String, contents: Vec<u8> },
    Serve(Serve),
    Http(Http),
}

impl Step {
    pub(crate) fn label(&self) -> String {
        match self {
            Step::Run(c) => format!(
                "run {} {}",
                c.argv0.as_deref().unwrap_or("dongminal"),
                c.args.join(" ")
            )
            .trim_end()
            .to_string(),
            Step::WriteHome { path, .. } => format!("write_home {path}"),
            Step::Serve(s) => format!("serve {}", s.args.join(" ")),
            Step::Http(h) => format!("http {} {}", h.method, h.path),
        }
    }

    fn strings(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        match self {
            Step::Run(c) => {
                out.extend(c.args.iter().map(String::as_str));
                out.extend(c.env.iter().map(|(_, v)| v.as_str()));
            }
            Step::WriteHome { path, .. } => out.push(path),
            Step::Serve(s) => {
                out.extend(s.args.iter().map(String::as_str));
                out.extend(s.env.iter().map(|(_, v)| v.as_str()));
                out.push(&s.ready_path);
            }
            Step::Http(h) => {
                out.push(&h.path);
                out.extend(h.headers.iter().map(|(_, v)| v.as_str()));
            }
        }
        out
    }

    fn args(&self) -> &[String] {
        match self {
            Step::Run(c) => &c.args,
            Step::Serve(s) => &s.args,
            _ => &[],
        }
    }
}

#[derive(Debug, Clone)]
pub struct Scenario {
    pub(crate) name: String,
    pub(crate) steps: Vec<Step>,
    pub(crate) files: Vec<String>,
    pub(crate) tree: Option<Vec<String>>,
    pub(crate) rules: Vec<Rule>,
    pub(crate) owner: Option<String>,
}

impl Scenario {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            steps: Vec::new(),
            files: Vec::new(),
            tree: None,
            rules: Vec::new(),
            owner: None,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Rust 쪽 구현을 맡은 이슈 ID. 그 이슈가 `done` 이 아니면 차이는 보류다 (SPEC FR-PAR-42).
    pub fn owner(mut self, issue: &str) -> Self {
        self.owner = Some(issue.to_string());
        self
    }

    pub fn owner_issue(&self) -> Option<&str> {
        self.owner.as_deref()
    }

    /// 인자만 주는 CLI 단계.
    pub fn run<I, S>(self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.run_cli(Cli::new(args))
    }

    pub fn run_cli(mut self, cli: Cli) -> Self {
        self.steps.push(Step::Run(cli));
        self
    }

    pub fn write_home(mut self, path: &str, contents: impl Into<Vec<u8>>) -> Self {
        self.steps.push(Step::WriteHome {
            path: path.to_string(),
            contents: contents.into(),
        });
        self
    }

    pub fn serve(mut self, serve: Serve) -> Self {
        self.steps.push(Step::Serve(serve));
        self
    }

    pub fn http(mut self, http: Http) -> Self {
        self.steps.push(Step::Http(http));
        self
    }

    /// 끝난 뒤 DONGMINAL_HOME 아래 `path` 의 내용을 비교한다.
    pub fn home_file(mut self, path: &str) -> Self {
        self.files.push(path.to_string());
        self
    }

    /// 끝난 뒤 DONGMINAL_HOME 아래 경로 목록을 비교한다. `exclude` 접두어로 시작하는 경로는 뺀다.
    pub fn home_tree<I, S>(mut self, exclude: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.tree = Some(exclude.into_iter().map(Into::into).collect());
        self
    }

    pub fn normalize(mut self, rule: Rule) -> Self {
        self.rules.push(rule);
        self
    }

    pub(crate) fn needs_port(&self) -> bool {
        self.steps.iter().any(|s| {
            matches!(s, Step::Serve(_) | Step::Http(_))
                || s.strings().iter().any(|v| v.contains(PH_PORT))
        })
    }

    /// 실행 전에 잡아야 할 시나리오 오류 (규칙 오류, C-PAR-3 포트, 경로 탈출).
    pub fn validate(&self) -> Vec<String> {
        let mut errs: Vec<String> = self
            .rules
            .iter()
            .filter_map(|r| r.error().map(String::from))
            .collect();
        for (i, step) in self.steps.iter().enumerate() {
            let args = step.args();
            for (j, a) in args.iter().enumerate() {
                let value = if a == "--port" {
                    args.get(j + 1).map(String::as_str)
                } else {
                    a.strip_prefix("--port=")
                };
                if let Some(p) = value.and_then(|v| v.parse::<u32>().ok())
                    && p < u32::from(MIN_PORT)
                {
                    errs.push(format!(
                        "단계 {i}: 포트 {p} 는 운영 범위다. {PH_PORT} 를 쓴다"
                    ));
                }
            }
            if let Step::WriteHome { path, .. } = step
                && !is_relative_inside(path)
            {
                errs.push(format!(
                    "단계 {i}: write_home 경로 {path:?} 는 홈 안의 상대 경로여야 한다"
                ));
            }
            let served = self.steps[..i].iter().any(|s| matches!(s, Step::Serve(_)));
            if let Step::Run(Cli {
                argv0: Some(name), ..
            }) = step
            {
                if FORBIDDEN_ARGV0.contains(&name.as_str()) {
                    errs.push(format!("단계 {i}: argv0 {name} 는 시나리오에 넣지 않는다"));
                } else if NETWORK_HELPERS.contains(&name.as_str()) && !served {
                    errs.push(format!(
                        "단계 {i}: {name} 앞에 serve 단계가 없다 (격리 서버 없이 기본 포트로 붙을 수 있다)"
                    ));
                }
            }
            if matches!(step, Step::Http(_)) && !served {
                errs.push(format!("단계 {i}: http 앞에 serve 단계가 없다"));
            }
        }
        if self
            .steps
            .iter()
            .filter(|s| matches!(s, Step::Serve(_)))
            .count()
            > 1
        {
            errs.push("serve 단계는 시나리오마다 하나다 ({port} 가 하나다)".to_string());
        }
        for f in &self.files {
            if !is_relative_inside(f) {
                errs.push(format!(
                    "home_file 경로 {f:?} 는 홈 안의 상대 경로여야 한다"
                ));
            }
        }
        errs
    }
}

fn is_relative_inside(path: &str) -> bool {
    let p = std::path::Path::new(path);
    !path.is_empty()
        && p.is_relative()
        && p.components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_port_arguments_are_rejected() {
        let s = Scenario::new("x")
            .run(["start", "--port", "8080"])
            .run(["start", "--port=60146"]);
        assert_eq!(s.validate().len(), 2);
        assert!(
            Scenario::new("ok")
                .run(["start", "--port", "{port}"])
                .run(["start", "--port=60147"])
                .validate()
                .is_empty()
        );
    }

    #[test]
    fn invalid_rules_and_paths_are_rejected() {
        let s = Scenario::new("x")
            .normalize(Rule::regex("(", ""))
            .write_home("../escape", "x")
            .home_file("/abs");
        assert_eq!(s.validate().len(), 3);
    }

    #[test]
    fn http_needs_serve_and_only_one_serve() {
        assert_eq!(Scenario::new("x").http(Http::get("/")).validate().len(), 1);
        let s = Scenario::new("y")
            .serve(Serve::new(["a"], "/"))
            .serve(Serve::new(["b"], "/"));
        assert_eq!(s.validate().len(), 1);
    }

    #[test]
    fn network_helpers_need_serve_and_shims_are_forbidden() {
        let bare = Scenario::new("a").run_cli(Cli::new(["--help"]).argv0("dmctl"));
        assert_eq!(bare.validate().len(), 1);
        let served = Scenario::new("b")
            .serve(Serve::new(["start"], "/api/ping"))
            .run_cli(Cli::new(["--help"]).argv0("dmctl"))
            .run_cli(Cli::new(["x"]).argv0("download"));
        assert!(served.validate().is_empty());
        let shim = Scenario::new("c")
            .serve(Serve::new(["start"], "/"))
            .run_cli(Cli::new(["-v"]).argv0("claude"));
        assert_eq!(shim.validate().len(), 1);
    }

    #[test]
    fn needs_port_detection() {
        assert!(!Scenario::new("a").run(["version"]).needs_port());
        assert!(
            Scenario::new("b")
                .run(["health", "--port", "{port}"])
                .needs_port()
        );
        assert!(
            Scenario::new("c")
                .serve(Serve::new(["start"], "/api/ping"))
                .needs_port()
        );
    }

    #[test]
    fn step_labels() {
        assert_eq!(
            Step::Run(Cli::new(["version"])).label(),
            "run dongminal version"
        );
        assert_eq!(
            Step::Run(Cli::new(Vec::<String>::new()).argv0("dmctl")).label(),
            "run dmctl"
        );
        assert_eq!(
            Step::Http(Http::get("/api/ping")).label(),
            "http GET /api/ping"
        );
    }
}
