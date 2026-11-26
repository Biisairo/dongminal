//! `otterctl run <sub>` — 오케스트레이션 실행(Run) 기록 (RUN_ORCHESTRATION_SRS 외).

use std::collections::BTreeSet;
use std::time::Duration;

use otter_gocompat::json::{self, RawMessage};
use otter_gocompat::strconv;
use otter_shared_agentadapter::{self as agentadapter, Adapter, PromptInjection};
use otter_shared_apipath as apipath;
use otter_shared_runwait::HANDOFF_WAIT_DEFAULT;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::order::repo_issue_ref_matches;
use super::runhttp::{
    RunMember, RunWorktree, run_delete, run_get, run_get_within, run_post, run_post_within,
    run_result,
};
use super::status::write_raw_json;
use super::whoami::{encode_query, query_escape};
use crate::argparse::{ArgSpec, atoi};
use crate::budgets::{CLIENT_SLACK, CLOSE_BUDGET, PREAMBLE_BUDGET};
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::OTTERCTL_RUN_HELP;
use crate::http::{base_url, http_post_json_within, self_tool_id};

const VALS: &[&str] = &[
    "--run",
    "--member",
    "--role",
    "--agent",
    "--brief",
    "--model",
    "--at",
    "-l",
    "--objective",
    "--projection",
    "--isolation",
    "--window",
    "--outcome",
    "--summary",
    "--files",
    "--base",
    "--timeout-ms",
    "--tree",
    "--ref",
    "--issue",
    "--title",
    "--parent",
    "--goal",
    "--ctx",
    "--issue-dir",
    "--mode",
    "--chat-room",
    "--to",
];
const BOOLS: &[&str] = &[
    "--force",
    "--headless",
    "--keep-worktrees",
    "--keep-tools",
    "--json",
    "--text",
    "--branch",
    "--parallel",
    "--no-commit",
    "--self",
    "--coordinator",
];

/// `run` 의 모든 하위 명령이 같은 플래그 집합을 받는다.
#[derive(Default, Debug)]
pub(crate) struct RunFlags {
    pub run: String,
    pub member: String,
    pub role: String,
    pub agent: String,
    pub brief: String,
    pub model: String,
    pub at: String,
    pub objective: String,
    pub projection: String,
    pub isolation: String,
    pub window: String,
    pub outcome: String,
    pub summary: String,
    pub files: String,
    pub base: String,
    pub force: bool,
    pub keep_trees: bool,
    pub keep_tools: bool,
    pub text_out: bool,
    pub json_out: bool,
    pub headless: bool,
    pub timeout_ms: String,
    pub tree: String,
    pub issue_dir: String,
    pub mode: String,
    pub chat_room: String,
    pub branch: bool,
    pub ref_: String,
    pub issue: String,
    pub title: String,
    pub parent: String,
    pub goal: String,
    pub ctx: String,
    pub parallel: bool,
    pub no_commit: bool,
    pub self_: bool,
    pub to: String,
    pub coord: bool,
    /// 값 플래그가 주어졌는가 — 빈 값과 생략을 가른다.
    pub given: BTreeSet<String>,
}

impl RunFlags {
    fn set_val(&mut self, k: &str, v: &str) {
        self.given.insert(k.to_owned());
        let v = v.to_owned();
        match k {
            "--run" => self.run = v,
            "--member" => self.member = v,
            "--role" => self.role = v,
            "--agent" => self.agent = v,
            "--brief" => self.brief = v,
            "--model" => self.model = v,
            "--at" | "-l" => self.at = v,
            "--objective" => self.objective = v,
            "--projection" => self.projection = v,
            "--isolation" => self.isolation = v,
            "--window" => self.window = v,
            "--outcome" => self.outcome = v,
            "--summary" => self.summary = v,
            "--files" => self.files = v,
            "--base" => self.base = v,
            "--timeout-ms" => self.timeout_ms = v,
            "--tree" => self.tree = v,
            "--ref" => self.ref_ = v,
            "--issue" => self.issue = v,
            "--title" => self.title = v,
            "--parent" => self.parent = v,
            "--goal" => self.goal = v,
            "--ctx" => self.ctx = v,
            "--issue-dir" => self.issue_dir = v,
            "--mode" => self.mode = v,
            "--chat-room" => self.chat_room = v,
            _ => self.to = v,
        }
    }

    fn set_bool(&mut self, k: &str) {
        match k {
            "--force" => self.force = true,
            "--headless" => self.headless = true,
            "--keep-worktrees" => self.keep_trees = true,
            "--keep-tools" => self.keep_tools = true,
            "--json" => self.json_out = true,
            "--text" => self.text_out = true,
            "--branch" => self.branch = true,
            "--parallel" => self.parallel = true,
            "--no-commit" => self.no_commit = true,
            "--self" => self.self_ = true,
            _ => self.coord = true,
        }
    }

    fn given(&self, flag: &str) -> bool {
        self.given.contains(flag)
    }
}

pub(crate) fn parse_run_flags(
    ctx: &mut Ctx<'_>,
    sub: &str,
    args: &[String],
) -> (RunFlags, Option<i32>) {
    let mut f = RunFlags::default();
    let spec = ArgSpec {
        help: OTTERCTL_RUN_HELP,
        vals: VALS,
        bools: BOOLS,
        ..Default::default()
    };
    let stop = spec.run(
        ctx,
        &format!("run {sub}"),
        args,
        &mut Vec::new(),
        &mut |k, v| {
            match v {
                Some(v) => f.set_val(k, v),
                None => f.set_bool(k),
            }
            Ok(())
        },
    );
    (f, stop)
}

pub(crate) fn run_otterctl_run(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let Some(sub) = args.first() else {
        errf!(ctx, "{OTTERCTL_RUN_HELP}");
        return 2;
    };
    if sub == "-h" || sub == "--help" {
        outf!(ctx, "{OTTERCTL_RUN_HELP}");
        return 0;
    }
    let (f, stop) = parse_run_flags(ctx, sub, &args[1..]);
    if let Some(code) = stop {
        return code;
    }
    match sub.as_str() {
        "start" => sub_start(ctx, f),
        "member" => sub_member(ctx, f),
        "launch" => sub_launch(ctx, &f),
        "report" => sub_report(ctx, &f),
        "status" | "list" => sub_status(ctx, sub, &f),
        "close" => sub_close(ctx, &f),
        "delete" => sub_delete(ctx, &f),
        "graph" => sub_graph(ctx, &f),
        "attach" => sub_attach(ctx, &f),
        "detach" => sub_detach(ctx, &f),
        "succeed" => sub_succeed(ctx, f),
        "handoff" => sub_handoff(ctx, f),
        "team" => sub_team(ctx, &f),
        "tree" => sub_tree(ctx, &f),
        "assign" => sub_assign(ctx, &f),
        "coordinate" => sub_coordinate(ctx, &f),
        "recover" => sub_recover(ctx, &f),
        _ => {
            errf!(ctx, "run: 알 수 없는 서브커맨드: {sub}\n");
            errf!(ctx, "{OTTERCTL_RUN_HELP}");
            2
        }
    }
}

fn read_stdin_trimmed(ctx: &mut Ctx<'_>, cmd: &str) -> Result<String, i32> {
    let mut data = Vec::new();
    if let Err(e) = ctx.inp.read_to_end(&mut data) {
        errf!(
            ctx,
            "{cmd}: stdin 읽기 실패: {}\n",
            otter_gocompat::oserr::go_error_string(&e)
        );
        return Err(2);
    }
    let s = super::notify::go_string_bytes(&data);
    Ok(s.trim_end_matches('\n').to_owned())
}

fn getwd(ctx: &mut Ctx<'_>, cmd: &str) -> Result<String, i32> {
    match std::env::current_dir() {
        Ok(p) => Ok(p.to_string_lossy().into_owned()),
        Err(e) => {
            errf!(
                ctx,
                "{cmd}: 현재 디렉터리를 알 수 없다: {}\n",
                otter_gocompat::oserr::go_error_string(&e)
            );
            Err(1)
        }
    }
}

macro_rules! try_code {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(code) => return code,
        }
    };
}

fn decode<T: serde::de::DeserializeOwned>(
    ctx: &mut Ctx<'_>,
    raw: &[u8],
    what: &str,
) -> Result<T, i32> {
    json::unmarshal::<T>(raw).map_err(|e| {
        errf!(ctx, "otterctl: invalid {what}: {e}\n");
        1
    })
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.runOrphan")]
struct RunOrphan {
    #[serde(rename = "memberId")]
    member_id: String,
    role: String,
    #[serde(rename = "toolId")]
    tool_id: String,
}

otter_gocompat::go_type!(GoMembers = "[]runtimebin.runMember");
otter_gocompat::go_type!(GoOrphans = "[]runtimebin.runOrphan");
otter_gocompat::go_type!(GoWorktrees = "[]runtimebin.runWorktree");

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.runRecord")]
struct RunRecord {
    id: String,
    short: String,
    objective: String,
    projection: String,
    isolation: String,
    state: String,
    #[serde(rename = "windowId")]
    window_id: String,
    repo: String,
    base: String,
    worktree: Option<RunWorktree>,
    #[serde(deserialize_with = "json::with_go_type::<GoMembers, _, _>")]
    members: Vec<RunMember>,
    #[serde(deserialize_with = "json::with_go_type::<GoOrphans, _, _>")]
    orphans: Vec<RunOrphan>,
}

fn sub_start(ctx: &mut Ctx<'_>, mut f: RunFlags) -> i32 {
    if f.objective.trim().is_empty() {
        errf!(ctx, "run start: --objective 는 필수다\n");
        return 2;
    }
    if f.projection.is_empty() {
        f.projection = "dedicated-window".into();
    }
    if f.isolation.is_empty() {
        f.isolation = "none".into();
    }
    let mut body = Map::new();
    body.insert("objective".into(), Value::from(f.objective.as_str()));
    body.insert("projection".into(), Value::from(f.projection.as_str()));
    body.insert("isolation".into(), Value::from(f.isolation.as_str()));
    body.insert("toolId".into(), Value::from(self_tool_id(ctx.env)));
    if !f.window.is_empty() {
        body.insert("windowId".into(), Value::from(f.window.as_str()));
    }
    if f.branch && f.tree.is_empty() {
        errf!(ctx, "run start: --branch 는 --tree 와 함께 쓴다\n");
        return 2;
    }
    if !f.chat_room.is_empty() {
        if f.tree.is_empty() {
            errf!(ctx, "run start: --chat-room 는 --tree 와 함께 쓴다\n");
            return 2;
        }
        body.insert("chatRoom".into(), Value::from(f.chat_room.as_str()));
    }
    if !f.mode.is_empty() {
        if f.tree.is_empty() {
            errf!(ctx, "run start: --mode 는 --tree 와 함께 쓴다\n");
            return 2;
        }
        match f.mode.as_str() {
            "tree" => {}
            "coord" => {
                body.insert("mode".into(), Value::from("coord"));
            }
            m => {
                errf!(ctx, "run start: --mode 는 tree 또는 coord 다: {m}\n");
                return 2;
            }
        }
    }
    if !f.issue_dir.is_empty() {
        if f.tree.is_empty() {
            errf!(ctx, "run start: --issue-dir 는 --tree 와 함께 쓴다\n");
            return 2;
        }
        if !otter_shared_issuefile::is_local_tree_ref(&f.tree) {
            errf!(
                ctx,
                "run start: 로컬 트리의 --tree 는 <별칭>:<ID> 꼴이다: {}\n",
                f.tree
            );
            return 2;
        }
        let p = std::path::Path::new(&f.issue_dir);
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            std::path::PathBuf::from(try_code!(getwd(ctx, "run start"))).join(p)
        };
        if !abs.is_dir() {
            errf!(ctx, "run start: --issue-dir 폴더가 없다: {}\n", f.issue_dir);
            return 2;
        }
        body.insert("tree".into(), Value::from(f.tree.as_str()));
        body.insert(
            "issueDir".into(),
            Value::from(abs.to_string_lossy().as_ref()),
        );
        if f.branch {
            body.insert("treeBranch".into(), Value::Bool(true));
        }
    } else if !f.tree.is_empty() {
        if !repo_issue_ref_matches(&f.tree) {
            errf!(
                ctx,
                "run start: --tree 는 owner/repo#N 꼴이다: {}\n",
                f.tree
            );
            return 2;
        }
        body.insert("tree".into(), Value::from(f.tree.as_str()));
        if f.branch {
            body.insert("treeBranch".into(), Value::Bool(true));
        }
    }
    if f.isolation != "none" {
        let wd = try_code!(getwd(ctx, "run start"));
        body.insert("cwd".into(), Value::from(wd));
        if !f.base.is_empty() {
            if f.base.starts_with('-') {
                errf!(
                    ctx,
                    "run start: --base 는 - 로 시작할 수 없다: {}\n",
                    strconv::quote(&f.base)
                );
                return 2;
            }
            body.insert("base".into(), Value::from(f.base.as_str()));
        }
    } else if !f.base.is_empty() {
        errf!(
            ctx,
            "run start: --base 는 격리 Run 에만 쓴다 (--isolation per-run|per-member)\n"
        );
        return 2;
    }
    let raw = try_code!(run_post(ctx, apipath::RUNS, &Value::Object(body)));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    let rec: RunRecord = try_code!(decode(ctx, &raw, "run response"));
    outf!(
        ctx,
        "run={}  short={}  state={}  projection={}  isolation={}\n",
        rec.id,
        rec.short,
        rec.state,
        rec.projection,
        rec.isolation
    );
    0
}

fn sub_member(ctx: &mut Ctx<'_>, mut f: RunFlags) -> i32 {
    if f.run.is_empty() || f.role.is_empty() || f.agent.is_empty() {
        errf!(ctx, "run member: --run·--role·--agent 는 모두 필수다\n");
        return 2;
    }
    if f.headless != f.at.is_empty() {
        errf!(
            ctx,
            "run member: --at <탭 uuid> 와 --headless 중 정확히 하나가 필요하다\n  --at        그 탭의 도구를 멤버로 삼는다 (기본 — 사람이 지켜본다)\n  --headless  탭 없이 서버가 도구를 만든다 (분할이 모자라거나 볼 이유가 없을 때)\n"
        );
        return 2;
    }
    if f.brief == "-" {
        f.brief = try_code!(read_stdin_trimmed(ctx, "run member"));
    }
    if let Err(e) = agentadapter::get(&f.agent) {
        errf!(ctx, "run member: {e}\n");
        return 2;
    }
    let mut body = Map::new();
    body.insert("runId".into(), Value::from(f.run.as_str()));
    body.insert("role".into(), Value::from(f.role.as_str()));
    body.insert("agent".into(), Value::from(f.agent.as_str()));
    body.insert("id".into(), Value::from(f.at.as_str()));
    body.insert("brief".into(), Value::from(f.brief.as_str()));
    match assign_of(ctx, &f) {
        Err(()) => return 2,
        Ok(Some(a)) => {
            body.insert("assign".into(), Value::Object(a));
        }
        Ok(None) => {}
    }
    if f.headless {
        body.insert("headless".into(), Value::Bool(true));
        let wd = try_code!(getwd(ctx, "run member"));
        body.insert("cwd".into(), Value::from(wd));
    }
    let raw = try_code!(run_post(ctx, apipath::RUNS_MEMBERS, &Value::Object(body)));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    let m: RunMember = try_code!(decode(ctx, &raw, "member response"));
    let mut line = format!(
        "member={}  role={}  agent={}  toolId={}  tabId={}  state={}",
        m.id, m.role, m.agent, m.tool_id, m.tab_id, m.state
    );
    if m.headless {
        line += "  headless=true";
    }
    if let Some(wt) = m.worktree.as_ref().filter(|w| !w.path.is_empty()) {
        line += &format!("  worktree={}  branch={}", wt.path, wt.branch);
    }
    outf!(ctx, "{line}\n");
    0
}

fn sub_launch(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.member.is_empty() {
        errf!(
            ctx,
            "run launch: --member 는 필수다 (run member 가 낸 uuid)\n"
        );
        return 2;
    }
    let q = encode_query(&[("member", &f.member)]);
    let raw = try_code!(run_get_within(
        ctx,
        &format!("{}?{q}", apipath::RUNS_PREAMBLE),
        PREAMBLE_BUDGET
    ));
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Got {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "memberId")]
        member_id: String,
        role: String,
        agent: String,
        #[serde(rename = "tabId")]
        tab_id: String,
        preamble: String,
        #[serde(rename = "promptFile")]
        prompt_file: bool,
    }
    let got: Got = try_code!(decode(ctx, &raw, "preamble response"));
    let adapter = match agentadapter::get(&got.agent) {
        Ok(a) => a,
        Err(e) => {
            errf!(ctx, "run launch: {e}\n");
            return 1;
        }
    };
    if f.text_out {
        outf!(ctx, "{}", got.preamble);
        return 0;
    }
    let mut prompt = got.preamble.clone();
    if got.prompt_file {
        match write_prompt_file(ctx, &got.member_id, &got.preamble) {
            Ok(Some(path)) => prompt = format!("{PROMPT_FILE_LINE}{path}"),
            Ok(None) => {}
            Err(e) => {
                errf!(ctx, "run launch: 첫 지시 파일: {e}\n");
                return 1;
            }
        }
    }
    let line = match adapter.launch_line(&crate::agent_hooks_dir_in(ctx.env), &f.model, &prompt) {
        Ok(l) => l,
        Err(e) => {
            errf!(ctx, "run launch: {e}\n");
            return 1;
        }
    };
    for n in launch_notes(adapter, &got.member_id, &got.tab_id, &f.model) {
        errf!(ctx, "run launch: {n}\n");
    }
    if f.json_out {
        let blob = json!({
            "runId": got.run_id, "memberId": got.member_id, "role": got.role,
            "agent": adapter.id, "tabId": got.tab_id,
            "promptInjection": adapter.prompt_injection.as_str(),
            "launch": line,
            "preamble": got.preamble,
        });
        match json::marshal(&blob) {
            Ok(b) => write_raw_json(ctx, &b),
            Err(e) => {
                errf!(ctx, "otterctl: {e}\n");
                return 1;
            }
        }
        return 0;
    }
    outf!(ctx, "{line}\n");
    0
}

/// 첫 지시를 파일로 받는 멤버의 기동 프롬프트 한 줄이다. 뒤에 파일 경로가 붙는다 (ISSUE_TREE_CHAT_SRS FR-ITR-6).
const PROMPT_FILE_LINE: &str =
    "otterminal 이슈 트리의 첫 지시는 이 파일에 있다. 먼저 끝까지 읽고 그대로 시작한다: ";
/// 첫 지시 파일의 자리(홈 아래)와 권한이다.
const PROMPT_DIR: &str = "prompts";
const PROMPT_PERM: u32 = 0o600;

/// 프리앰블을 `<홈>/prompts/<member>.md` 로 쓴다. 홈을 모르면 None — 기동줄에 그대로 싣는다.
fn write_prompt_file(
    ctx: &Ctx<'_>,
    member_id: &str,
    preamble: &str,
) -> std::io::Result<Option<String>> {
    let home = ctx.env.get(otter_shared_otterenv::ENV_HOME);
    if home.is_empty() || member_id.is_empty() || member_id.contains(['/', '\\']) {
        return Ok(None);
    }
    let dir = std::path::Path::new(&home).join(PROMPT_DIR);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{member_id}.md"));
    otter_shared_platform::write_file_atomic(&path, preamble.as_bytes(), PROMPT_PERM)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn launch_notes(a: &Adapter, member_id: &str, tab_id: &str, model: &str) -> Vec<String> {
    let mut notes = Vec::new();
    if a.prompt_injection != PromptInjection::Argv {
        let at = if tab_id.is_empty() {
            "<탭 uuid>"
        } else {
            tab_id
        };
        notes.push(format!(
            "{} 는 기동줄에 프리앰블을 싣지 못한다 ({}). 뜬 뒤에 따로 붙여넣어라: otterctl wait --at {at} --for ready && otterctl run launch --member {member_id} --text | otterctl send-input --at {at} --execute -",
            a.id,
            a.prompt_injection.as_str()
        ));
    }
    if !model.is_empty() && a.model_flag.is_empty() {
        notes.push(format!(
            "{} 의 모델 플래그를 모른다 — --model {model} 를 생략했다",
            a.id
        ));
    }
    notes
}

fn sub_report(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.outcome != "succeeded" && f.outcome != "failed" {
        errf!(
            ctx,
            "run report: --outcome 은 succeeded 또는 failed 여야 한다: {}\n",
            strconv::quote(&f.outcome)
        );
        return 2;
    }
    if f.summary.trim().is_empty() {
        errf!(
            ctx,
            "run report: --summary 는 필수다 (무엇을 했는가 / 무엇을 발견했는가 / 무엇이 남았는가)\n"
        );
        return 2;
    }
    let mut body = Map::new();
    body.insert("outcome".into(), Value::from(f.outcome.as_str()));
    body.insert("summary".into(), Value::from(f.summary.as_str()));
    body.insert("toolId".into(), Value::from(self_tool_id(ctx.env)));
    if !f.run.is_empty() {
        body.insert("runId".into(), Value::from(f.run.as_str()));
    }
    if !f.member.is_empty() {
        body.insert("memberId".into(), Value::from(f.member.as_str()));
    }
    if !f.files.is_empty() {
        let parts: Vec<Value> = f
            .files
            .split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(Value::from)
            .collect();
        body.insert("files".into(), Value::Array(parts));
    }
    let raw = try_code!(run_post(ctx, apipath::RUNS_REPORT, &Value::Object(body)));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    let m: RunMember = json::unmarshal(&raw).unwrap_or_default();
    outf!(
        ctx,
        "reported  member={}  role={}  outcome={}  state={}\n",
        m.id,
        m.role,
        m.outcome,
        m.state
    );
    0
}

fn sub_status(ctx: &mut Ctx<'_>, sub: &str, f: &RunFlags) -> i32 {
    let mut path = apipath::RUNS.to_owned();
    if sub == "status" && !f.run.is_empty() {
        path += &format!("?{}", encode_query(&[("id", &f.run)]));
    }
    let raw = try_code!(run_get(ctx, &path));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    if path.contains("id=") {
        let rec: RunRecord = try_code!(decode(ctx, &raw, "run response"));
        print_run(ctx, &rec, true);
        return 0;
    }
    otter_gocompat::go_type!(GoRuns = "[]runtimebin.runRecord");
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct List {
        #[serde(deserialize_with = "json::with_go_type::<GoRuns, _, _>")]
        runs: Vec<RunRecord>,
    }
    let list: List = try_code!(decode(ctx, &raw, "run list"));
    if list.runs.is_empty() {
        outf!(ctx, "(Run 없음)\n");
        return 0;
    }
    for rec in &list.runs {
        print_run(ctx, rec, false);
    }
    0
}

fn sub_close(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.run.is_empty() {
        errf!(ctx, "run close: --run 은 필수다\n");
        return 2;
    }
    let r = http_post_json_within(
        &format!("{}{}", base_url(ctx.env), apipath::RUNS_CLOSE),
        &json!({"runId": f.run, "force": f.force, "keepWorktrees": f.keep_trees, "keepTools": f.keep_tools}),
        CLOSE_BUDGET,
    );
    if r.err.is_some() && r.timeout {
        errf!(
            ctx,
            "otterctl: run close 의 응답을 {} 안에 받지 못했다. 서버는 정리를 계속한다 — 결과는 `otterctl run status --run {}` 로 본다\n",
            otter_gocompat::time::format_std_duration(CLOSE_BUDGET),
            f.run
        );
        return 1;
    }
    let raw = try_code!(run_result(ctx, apipath::RUNS_CLOSE, r));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    let rec: CloseResponse = try_code!(decode(ctx, &raw, "close response"));
    print_close_report(ctx, &rec);
    0
}

fn sub_delete(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.run.is_empty() {
        errf!(ctx, "run delete: --run 은 필수다\n");
        return 2;
    }
    let raw = try_code!(run_delete(
        ctx,
        &format!("{}{}", apipath::RUNS_PREFIX, path_escape(&f.run))
    ));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Rec {
        id: String,
        short: String,
        state: String,
        #[serde(deserialize_with = "json::with_go_type::<GoWorktrees, _, _>")]
        worktrees: Vec<RunWorktree>,
        residue: i64,
    }
    let rec: Rec = try_code!(decode(ctx, &raw, "delete response"));
    outf!(
        ctx,
        "deleted  run={}  short={}  state={}\n",
        rec.id,
        rec.short,
        rec.state
    );
    if rec.residue > 0 {
        outf!(
            ctx,
            "잔여물 {}건 (지우지 않았다 — 레코드도 남는다):\n",
            rec.residue
        );
        for wt in rec.worktrees.iter().filter(|w| !w.removed) {
            outf!(ctx, "{}\n", residue_line(wt));
        }
    }
    0
}

fn residue_line(wt: &RunWorktree) -> String {
    let mut line = format!("  {}  branch={}  사유={}", wt.path, wt.branch, wt.residue);
    if !wt.detail.is_empty() {
        line += &format!("  ({})", wt.detail);
    }
    line
}

fn sub_graph(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.run.is_empty() {
        errf!(ctx, "run graph: --run 은 필수다\n");
        return 2;
    }
    let raw = try_code!(run_get(
        ctx,
        &format!("{}{}/graph", apipath::RUNS_PREFIX, path_escape(&f.run))
    ));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct GMember {
        id: String,
        role: String,
        agent: String,
        #[serde(rename = "toolId")]
        tool_id: String,
        #[serde(rename = "tabId")]
        tab_id: String,
        state: String,
        outcome: String,
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct GEdge {
        from: String,
        to: String,
        count: i64,
        #[serde(rename = "lastAt")]
        last_at: i64,
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct GEvent {
        at: i64,
        kind: String,
        #[serde(rename = "memberId")]
        member_id: String,
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Graph {
        #[serde(rename = "runId")]
        run_id: String,
        short: String,
        objective: String,
        state: String,
        isolation: String,
        members: Vec<GMember>,
        edges: Vec<GEdge>,
        timeline: Vec<GEvent>,
    }
    let g: Graph = try_code!(decode(ctx, &raw, "graph response"));
    outf!(
        ctx,
        "run={}  short={}  state={}  isolation={}  objective={}\n",
        g.run_id,
        g.short,
        g.state,
        g.isolation,
        g.objective
    );
    outf!(ctx, "멤버 {}:\n", g.members.len());
    for m in &g.members {
        let mut line = format!(
            "  {}  role={}  agent={}  state={}  toolId={}",
            m.id, m.role, m.agent, m.state, m.tool_id
        );
        if !m.tab_id.is_empty() {
            line += &format!("  tabId={}", m.tab_id);
        }
        if !m.outcome.is_empty() {
            line += &format!("  outcome={}", m.outcome);
        }
        outf!(ctx, "{line}\n");
    }
    outf!(ctx, "간선 {} (msg):\n", g.edges.len());
    for e in &g.edges {
        outf!(
            ctx,
            "  {} -> {}  count={}  last={}\n",
            e.from,
            e.to,
            e.count,
            graph_time(e.last_at)
        );
    }
    outf!(ctx, "타임라인 {}:\n", g.timeline.len());
    for ev in &g.timeline {
        let mut line = format!("  {}  {}", graph_time(ev.at), ev.kind);
        if !ev.member_id.is_empty() {
            line += &format!("  member={}", ev.member_id);
        }
        outf!(ctx, "{line}\n");
    }
    0
}

/// 밀리초 시각을 로컬 시간대의 `15:04:05` 로 쓴다. 0 이하면 `-`.
pub(crate) fn graph_time(ms: i64) -> String {
    if ms <= 0 {
        return "-".to_owned();
    }
    let sec = ms.div_euclid(1000);
    let local = sec + i64::from(otter_gocompat::time::local().offset_at(sec));
    let day = local.rem_euclid(86400);
    format!("{:02}:{:02}:{:02}", day / 3600, day / 60 % 60, day % 60)
}

fn sub_tree(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.ref_.is_empty() {
        errf!(ctx, "run tree: --ref <owner/repo#N> 은 필수다\n");
        return 2;
    }
    let raw = try_code!(run_get(
        ctx,
        &format!("{}?ref={}", apipath::RUNS_TREE, query_escape(&f.ref_))
    ));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Node {
        role: String,
        state: String,
        parent: String,
        leaf: bool,
        #[serde(rename = "toolId")]
        tool_id: String,
        #[serde(rename = "contextRatio")]
        context_ratio: f64,
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Got {
        tree: String,
        nodes: Vec<Node>,
    }
    let got: Got = try_code!(decode(ctx, &raw, "tree response"));
    let _ = got.tree;
    if got.nodes.is_empty() {
        outf!(ctx, "({}: 열린 노드 없음)\n", f.ref_);
        return 0;
    }
    let mut depth = std::collections::HashMap::<String, usize>::new();
    for n in &got.nodes {
        let d = if n.parent.is_empty() {
            0
        } else {
            depth.get(&n.parent).copied().unwrap_or(0) + 1
        };
        depth.insert(n.role.clone(), d);
        let mut line = format!("{}{}  state={}", "  ".repeat(d), n.role, n.state);
        if n.leaf {
            line += "  leaf";
        }
        if n.context_ratio > 0.0 {
            line += &format!(
                "  ctx={}%",
                strconv::format_float(n.context_ratio * 100.0, b'f', 0, 64)
            );
        }
        outf!(ctx, "{line}  toolId={}\n", n.tool_id);
    }
    0
}

fn sub_attach(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.member.is_empty() {
        errf!(
            ctx,
            "run attach: --member 는 필수다 (run member 가 낸 uuid)\n"
        );
        return 2;
    }
    let mut body = Map::new();
    body.insert("memberId".into(), Value::from(f.member.as_str()));
    if !f.at.is_empty() {
        body.insert("location".into(), Value::from(f.at.as_str()));
    }
    attach_post(ctx, apipath::RUNS_ATTACH, Value::Object(body), "부착")
}

fn sub_detach(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.member.is_empty() {
        errf!(
            ctx,
            "run detach: --member 는 필수다 (run member 가 낸 uuid)\n"
        );
        return 2;
    }
    if !f.at.is_empty() {
        errf!(ctx, "run detach: --at 은 run attach 와 함께만 쓴다\n");
        return 2;
    }
    attach_post(
        ctx,
        apipath::RUNS_DETACH,
        json!({"memberId": f.member}),
        "분리",
    )
}

/// 부착·분리의 공통 절반이다. 둘의 응답은 같은 멤버 뷰이고, 달라지는 것은 동사뿐이다.
fn attach_post(ctx: &mut Ctx<'_>, path: &str, body: Value, verb: &str) -> i32 {
    let raw = try_code!(run_post(ctx, path, &body));
    let m: RunMember = try_code!(decode(ctx, &raw, &format!("{path} response")));
    outf!(
        ctx,
        "{verb}  member={}  role={}  toolId={}  tabId={}  state={}\n",
        m.id,
        m.role,
        m.tool_id,
        m.tab_id,
        m.state
    );
    0
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.succeedResponse")]
struct SucceedResponse {
    member: RunMember,
    #[serde(rename = "prevMemberId")]
    prev_member_id: String,
    #[serde(rename = "prevState")]
    prev_state: String,
    #[serde(rename = "hasSummary")]
    has_summary: bool,
}

/// `succeed` 의 클라이언트 예산 — 인수인계 대기 상한 + 여유.
pub(crate) fn succeed_budget(timeout_ms: i64) -> Duration {
    let wait = if timeout_ms > 0 {
        Duration::from_millis(timeout_ms as u64)
    } else {
        HANDOFF_WAIT_DEFAULT
    };
    wait.saturating_add(CLIENT_SLACK)
}

fn sub_succeed(ctx: &mut Ctx<'_>, f: RunFlags) -> i32 {
    if f.self_ {
        return sub_succeed_self(ctx, f);
    }
    if f.member.is_empty() {
        errf!(
            ctx,
            "run succeed: --member 는 필수다 (승계당할 멤버의 uuid)\n"
        );
        return 2;
    }
    if f.at.is_empty() && !f.headless {
        errf!(
            ctx,
            "run succeed: --at <탭 uuid> 또는 --headless 중 하나가 필요하다 — 새 멤버가 들어앉을 자리다\n"
        );
        return 2;
    }
    if !f.at.is_empty() && f.headless {
        errf!(
            ctx,
            "run succeed: --at 과 --headless 는 함께 쓸 수 없다. 새 멤버는 탭에 앉거나 헤드리스이거나 둘 중 하나다\n"
        );
        return 2;
    }
    let mut body = Map::new();
    body.insert("memberId".into(), Value::from(f.member.as_str()));
    body.insert("at".into(), Value::from(f.at.as_str()));
    body.insert("headless".into(), Value::Bool(f.headless));
    body.insert("toolId".into(), Value::from(self_tool_id(ctx.env)));
    let mut timeout_ms = 0;
    if !f.timeout_ms.is_empty() {
        match atoi(&f.timeout_ms) {
            Some(ms) if ms >= 0 => {
                body.insert("timeoutMs".into(), Value::from(ms));
                timeout_ms = ms;
            }
            _ => {
                errf!(
                    ctx,
                    "run succeed: --timeout-ms 는 0 이상의 정수여야 한다: {}\n",
                    strconv::quote(&f.timeout_ms)
                );
                return 2;
            }
        }
    }
    let raw = try_code!(run_post_within(
        ctx,
        apipath::RUNS_SUCCEED,
        &Value::Object(body),
        succeed_budget(timeout_ms)
    ));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    let resp: SucceedResponse = try_code!(decode(ctx, &raw, "succeed response"));
    let m = &resp.member;
    let wt = m.worktree.as_ref().filter(|w| !w.path.is_empty());
    let mut line = format!(
        "succeeded  prev={} ({})  →  member={}  role={}  toolId={}  tabId={}",
        resp.prev_member_id, resp.prev_state, m.id, m.role, m.tool_id, m.tab_id
    );
    if let Some(wt) = wt {
        line += &format!("  worktree={}", wt.path);
    }
    outf!(ctx, "{line}\n");
    if resp.has_summary {
        outf!(ctx, "  인수인계 요약 있음 — 새 멤버의 프리앰블에 실렸다\n");
    } else {
        outf!(
            ctx,
            "  인수인계 요약 없음 — 이전 멤버가 답하지 않았다. 프리앰블에 그 사실이 적혀 있다\n"
        );
    }
    if wt.is_some() {
        outf!(
            ctx,
            "  작업 트리는 새로 만들지 않았다 — 이전 멤버의 트리를 그대로 쓴다\n"
        );
    }
    outf!(
        ctx,
        "  이전 멤버의 도구는 그대로 살아 있다 — 인수인계를 다 읽었으면 /exit → close-tab 으로 정리해라\n"
    );
    let mut launch = format!("otterctl run launch --member {}", m.id);
    if !f.model.is_empty() {
        launch += &format!(
            " --model {}",
            otter_shared_platform::current().shell.quote(&f.model)
        );
    }
    outf!(ctx, "  다음: {launch}\n");
    0
}

fn sub_handoff(ctx: &mut Ctx<'_>, mut f: RunFlags) -> i32 {
    if f.summary == "-" {
        f.summary = try_code!(read_stdin_trimmed(ctx, "run handoff"));
    }
    if f.summary.trim().is_empty() {
        errf!(
            ctx,
            "run handoff: --summary 는 필수다 (무엇을 했는가 / 어디까지 왔는가 / 다음에 무엇을 / 함정)\n"
        );
        return 2;
    }
    let mut body = Map::new();
    body.insert("summary".into(), Value::from(f.summary.as_str()));
    body.insert("toolId".into(), Value::from(self_tool_id(ctx.env)));
    if !f.member.is_empty() {
        body.insert("memberId".into(), Value::from(f.member.as_str()));
    }
    let raw = try_code!(run_post(ctx, apipath::RUNS_HANDOFF, &Value::Object(body)));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Resp {
        #[serde(rename = "memberId")]
        member_id: String,
        len: i64,
    }
    let resp: Resp = json::unmarshal(&raw).unwrap_or_default();
    outf!(
        ctx,
        "handoff  member={}  {}바이트를 남겼다 — 후임의 프리앰블에 실린다\n",
        resp.member_id,
        resp.len
    );
    0
}

/// 자기 승계 (ISSUE_TREE_OPS_SRS FR-ITB-1). 인수인계를 청하지도 기다리지도 않는다.
fn sub_succeed_self(ctx: &mut Ctx<'_>, mut f: RunFlags) -> i32 {
    if !f.member.is_empty() || f.headless {
        errf!(
            ctx,
            "run succeed: --self 는 --member·--headless 와 함께 쓰지 않는다 — 승계할 멤버는 발신 도구 자신이다\n"
        );
        return 2;
    }
    if f.at.is_empty() {
        errf!(
            ctx,
            "run succeed: --self 는 --at <새 탭 uuid> 가 필요하다\n"
        );
        return 2;
    }
    if f.summary == "-" {
        f.summary = try_code!(read_stdin_trimmed(ctx, "run succeed"));
    }
    if f.summary.trim().is_empty() {
        errf!(
            ctx,
            "run succeed: --self 는 --summary 가 필요하다 (무엇을 했는가 / 어디까지 왔는가 / 다음에 무엇을 / 함정)\n"
        );
        return 2;
    }
    let body =
        json!({"self": true, "at": f.at, "summary": f.summary, "toolId": self_tool_id(ctx.env)});
    let raw = try_code!(run_post(ctx, apipath::RUNS_SUCCEED, &body));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    let resp: SucceedResponse = try_code!(decode(ctx, &raw, "succeed response"));
    let m = &resp.member;
    outf!(
        ctx,
        "succeeded  prev={} ({})  →  member={}  role={}  toolId={}  tabId={}\n",
        resp.prev_member_id,
        resp.prev_state,
        m.id,
        m.role,
        m.tool_id,
        m.tab_id
    );
    outf!(
        ctx,
        "  다음: otterctl run launch --member {} | otterctl send-input --at {} --execute -\n",
        m.id,
        f.at
    );
    0
}

fn sub_team(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    let id = self_tool_id(ctx.env);
    let mut path = apipath::RUNS_TEAM.to_owned();
    if !id.is_empty() {
        path += &format!("?{}", encode_query(&[("toolId", &id)]));
    }
    let raw = try_code!(run_get(ctx, &path));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    #[derive(Default, Deserialize)]
    #[serde(default, rename = "runtimebin.teamMate")]
    struct TeamMate {
        role: String,
        #[serde(rename = "memberId")]
        member_id: String,
        to: String,
        state: String,
        headless: bool,
    }
    otter_gocompat::go_type!(GoTeam = "[]runtimebin.teamMate");
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Got {
        #[serde(deserialize_with = "json::with_go_type::<GoTeam, _, _>")]
        team: Vec<TeamMate>,
    }
    let got: Got = try_code!(decode(ctx, &raw, "team response"));
    if got.team.is_empty() {
        outf!(ctx, "(동료 없음)\n");
        return 0;
    }
    for p in &got.team {
        outf!(
            ctx,
            "role={}  member={}  to={}  state={}  headless={}\n",
            p.role,
            p.member_id,
            p.to,
            p.state,
            p.headless
        );
    }
    0
}

/// 트리 Run 멤버의 배정이다. `--issue` 가 없으면 배정 플래그를 받지 않는다.
fn assign_of(ctx: &mut Ctx<'_>, f: &RunFlags) -> Result<Option<Map<String, Value>>, ()> {
    if f.issue.is_empty() {
        for flag in ["--title", "--parent", "--goal", "--ctx"] {
            if f.given(flag) {
                errf!(ctx, "run member: {flag} 는 --issue 와 함께 쓴다\n");
                return Err(());
            }
        }
        if f.parallel || f.no_commit {
            errf!(
                ctx,
                "run member: --parallel·--no-commit 은 --issue 와 함께 쓴다\n"
            );
            return Err(());
        }
        return Ok(None);
    }
    let mut a = Map::new();
    a.insert("issue".into(), Value::from(f.issue.as_str()));
    for (k, v) in [
        ("title", &f.title),
        ("parent", &f.parent),
        ("goal", &f.goal),
    ] {
        if !v.is_empty() {
            a.insert(k.into(), Value::from(v.as_str()));
        }
    }
    if f.parallel {
        a.insert("parallel".into(), Value::Bool(true));
    }
    if f.no_commit {
        a.insert("noCommit".into(), Value::Bool(true));
    }
    if f.given("--ctx") {
        let n = ctx_pct_arg(ctx, &f.ctx, "run member")?;
        a.insert("ctxPct".into(), Value::from(n));
    }
    Ok(Some(a))
}

fn ctx_pct_arg(ctx: &mut Ctx<'_>, v: &str, cmd: &str) -> Result<i64, ()> {
    match atoi(v.trim()) {
        Some(n) if (1..=100).contains(&n) => Ok(n),
        _ => {
            errf!(
                ctx,
                "{cmd}: --ctx 는 1~100 의 정수다: {}\n",
                strconv::quote(v)
            );
            Err(())
        }
    }
}

fn sub_assign(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.member.is_empty() {
        errf!(ctx, "run assign: --member 는 필수다\n");
        return 2;
    }
    let mut body = Map::new();
    body.insert("memberId".into(), Value::from(f.member.as_str()));
    body.insert("toolId".into(), Value::from(self_tool_id(ctx.env)));
    if f.given("--title") {
        body.insert("title".into(), Value::from(f.title.as_str()));
    }
    if f.given("--goal") {
        body.insert("goal".into(), Value::from(f.goal.as_str()));
    }
    if f.parallel {
        body.insert("parallel".into(), Value::Bool(true));
    }
    if f.no_commit {
        body.insert("noCommit".into(), Value::Bool(true));
    }
    if f.given("--ctx") {
        let Ok(n) = ctx_pct_arg(ctx, &f.ctx, "run assign") else {
            return 2;
        };
        body.insert("ctxPct".into(), Value::from(n));
    }
    let raw = try_code!(run_post(ctx, apipath::RUNS_ASSIGN, &Value::Object(body)));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct M {
        id: String,
        assign: Option<RawMessage>,
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Resp {
        member: M,
    }
    let resp: Resp = json::unmarshal(&raw).unwrap_or_default();
    outf!(ctx, "assign  member={}  ", resp.member.id);
    if let Some(a) = &resp.member.assign {
        let _ = ctx.out.write_all(&a.0);
    }
    outf!(ctx, "\n");
    0
}

fn sub_coordinate(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.to.is_empty() {
        errf!(ctx, "run coordinate: --to <toolId> 는 필수다\n");
        return 2;
    }
    let body = json!({"to": f.to, "toolId": self_tool_id(ctx.env)});
    let raw = try_code!(run_post(ctx, apipath::RUNS_COORDINATE, &body));
    if f.json_out {
        write_raw_json(ctx, &raw);
        return 0;
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Resp {
        to: String,
        moved: Vec<String>,
    }
    let resp: Resp = try_code!(decode(ctx, &raw, "coordinate response"));
    if resp.moved.is_empty() {
        outf!(ctx, "(조율하는 열린 Run 없음)\n");
        return 0;
    }
    outf!(
        ctx,
        "조율 승계: {} 개 Run → {}\n",
        resp.moved.len(),
        resp.to
    );
    for id in &resp.moved {
        outf!(ctx, "  run={id}\n");
    }
    0
}

/// 데몬이 죽은 뒤 빈 셸에서 에이전트를 세션 id 로 재개한다 (RUN_RECOVERY_SRS). 요청 오류는 2,
/// 하나도 재개하지 못하면 1.
fn sub_recover(ctx: &mut Ctx<'_>, f: &RunFlags) -> i32 {
    if f.run.is_empty() {
        errf!(ctx, "run recover: --run 은 필수다\n");
        return 2;
    }
    if !f.member.is_empty() && f.coord {
        errf!(
            ctx,
            "run recover: --member 와 --coordinator 는 함께 줄 수 없다\n"
        );
        return 2;
    }
    if f.force && f.member.is_empty() && !f.coord {
        errf!(
            ctx,
            "run recover: --force 는 --member 나 --coordinator 와 함께일 때만 받는다\n"
        );
        return 2;
    }
    let mut body = Map::new();
    body.insert("runId".into(), Value::from(f.run.as_str()));
    if !f.member.is_empty() {
        body.insert("memberId".into(), Value::from(f.member.as_str()));
    }
    if f.coord {
        body.insert("coordinator".into(), Value::Bool(true));
    }
    if f.force {
        body.insert("force".into(), Value::Bool(true));
    }
    let Ok(raw) = run_post(ctx, apipath::RUNS_RECOVER, &Value::Object(body)) else {
        return 2;
    };
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Result_ {
        target: String,
        #[serde(rename = "memberId")]
        member_id: String,
        outcome: String,
        reason: String,
        #[serde(rename = "needsForce")]
        needs_force: bool,
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Resp {
        results: Vec<Result_>,
    }
    let resp: Resp = try_code!(decode(ctx, &raw, "recover response"));
    if f.json_out {
        write_raw_json(ctx, &raw);
    }
    let mut resumed = 0;
    for r in &resp.results {
        if r.outcome == "resumed" {
            resumed += 1;
        }
        if r.needs_force {
            errf!(
                ctx,
                "run recover: {} {} — 셸에 에이전트가 없는지 판정하지 못했다. 화면을 확인했으면 --force 로 다시 부른다\n",
                r.target,
                r.member_id
            );
        }
        if f.json_out {
            continue;
        }
        let mut who = r.target.clone();
        if !r.member_id.is_empty() {
            who += &format!(" {}", r.member_id);
        }
        outf!(ctx, "{who}  {}", r.outcome);
        if !r.reason.is_empty() {
            outf!(ctx, "  {}", r.reason);
        }
        outf!(ctx, "\n");
    }
    if resumed == 0 { 1 } else { 0 }
}

// ── 출력 ──────────────────────────────────────────────

impl RunMember {
    /// 컨텍스트 칸. 전부 서버측 추정이며, 수준이 비어 있으면 모른다는 뜻이다 (FR-CBG-5).
    fn context_cell(&self) -> String {
        if self.context_level.is_empty() {
            return "ctx=— (unknown)".to_owned();
        }
        let mut cell = format!(
            "ctx=~{}% ({})",
            (self.context_ratio * 100.0 + 0.5) as i64,
            self.context_level
        );
        if self.context_tokens > 0 && self.context_limit > 0.0 {
            cell += &format!(
                " [{}/{}]",
                token_short(self.context_tokens as f64),
                token_short(self.context_limit)
            );
        }
        if self.compact_count > 0 {
            cell += &format!(" compact={}", self.compact_count);
        }
        cell
    }
}

fn token_short(v: f64) -> String {
    if v >= 1e6 {
        return format!("{}M", strconv::format_float(v / 1e6, b'f', 1, 64));
    }
    if v >= 1e3 {
        return format!("{}k", strconv::format_float(v / 1e3, b'f', 0, 64));
    }
    strconv::format_float(v, b'f', 0, 64)
}

fn print_run(ctx: &mut Ctx<'_>, rec: &RunRecord, with_members: bool) {
    let _ = &rec.window_id;
    outf!(
        ctx,
        "run={}  short={}  state={}  projection={}  isolation={}  members={}  objective={}\n",
        rec.id,
        rec.short,
        rec.state,
        rec.projection,
        rec.isolation,
        rec.members.len(),
        rec.objective
    );
    if !with_members {
        return;
    }
    let alert = context_headline(&rec.members);
    if !alert.is_empty() {
        outf!(ctx, "  {alert}\n");
    }
    if !rec.repo.is_empty() {
        outf!(ctx, "  repo={}  base={}\n", rec.repo, rec.base);
    }
    if let Some(wt) = &rec.worktree {
        print_worktree(ctx, wt, "  공유 트리");
    }
    for m in &rec.members {
        let mut line = format!(
            "  role={}  state={}  agent={}  toolId={}  tabId={}",
            m.role, m.state, m.agent, m.tool_id, m.tab_id
        );
        if m.headless {
            line += "  headless=true";
        }
        if !m.outcome.is_empty() {
            line += &format!("  outcome={}", m.outcome);
        }
        line += &format!("  {}", m.context_cell());
        if !m.succeeded_from.is_empty() {
            line += &format!("  승계←{}", m.succeeded_from);
        }
        outf!(ctx, "{line}\n");
        if !m.summary.is_empty() {
            outf!(ctx, "    {}\n", m.summary);
        }
        if let Some(wt) = &m.worktree {
            print_worktree(ctx, wt, "    트리");
        }
    }
    print_orphans(ctx, &rec.orphans);
}

fn print_orphans(ctx: &mut Ctx<'_>, orphans: &[RunOrphan]) {
    if orphans.is_empty() {
        return;
    }
    outf!(
        ctx,
        "  고아 {}건 (헤드리스 도구가 살아 있다 — otterctl run close --run <uuid> --force 로 거둔다):\n",
        orphans.len()
    );
    for o in orphans {
        outf!(
            ctx,
            "    role={}  toolId={}  memberId={}\n",
            o.role,
            o.tool_id,
            o.member_id
        );
    }
}

fn print_worktree(ctx: &mut Ctx<'_>, wt: &RunWorktree, label: &str) {
    let mut line = format!("{label} {}  branch={}", wt.path, wt.branch);
    if !wt.base.is_empty() {
        line += &format!("  base={}", wt.base);
    }
    if !wt.residue.is_empty() {
        line += &format!("  잔여물={}", wt.residue);
    } else if wt.removed {
        line += "  (정리됨)";
    }
    outf!(ctx, "{line}\n");
}

fn context_headline(members: &[RunMember]) -> String {
    let (mut warn, mut critical) = (Vec::new(), Vec::new());
    for m in members {
        match m.context_level.as_str() {
            "warn" => warn.push(m.role.as_str()),
            "critical" => critical.push(m.role.as_str()),
            _ => {}
        }
    }
    if warn.is_empty() && critical.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    if !critical.is_empty() {
        parts.push(format!(
            "critical {}명({})",
            critical.len(),
            critical.join(", ")
        ));
    }
    if !warn.is_empty() {
        parts.push(format!("warn {}명({})", warn.len(), warn.join(", ")));
    }
    format!(
        "컨텍스트 주의(추정): {} — 승계는 otterctl run succeed",
        parts.join("  ")
    )
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CleanupItem {
    role: String,
    #[serde(rename = "toolId")]
    tool_id: String,
    #[serde(rename = "tabId")]
    tab_id: String,
    live: bool,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ClosedTab {
    role: String,
    #[serde(rename = "tabId")]
    tab_id: String,
    exited: bool,
    empty: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.closeResponse")]
struct CloseResponse {
    id: String,
    state: String,
    cleanup: Vec<CleanupItem>,
    #[serde(deserialize_with = "json::with_go_type::<GoWorktrees, _, _>")]
    worktrees: Vec<RunWorktree>,
    swept: bool,
    #[serde(
        rename = "keptTools",
        deserialize_with = "json::with_go_type::<GoOrphans, _, _>"
    )]
    kept_tools: Vec<RunOrphan>,
    #[serde(deserialize_with = "json::with_go_type::<GoOrphans, _, _>")]
    orphans: Vec<RunOrphan>,
    #[serde(rename = "closedTabs")]
    closed_tabs: Vec<ClosedTab>,
}

/// UX_BATCH6_SRS FR-RUN-6·9: 닫는 일은 서버가 이미 했다 — 무엇을 닫았는지 보고하고, 닫지
/// 못한 것만 남긴다.
fn print_close_report(ctx: &mut Ctx<'_>, rec: &CloseResponse) {
    if rec.swept {
        outf!(
            ctx,
            "run={}  state={}  (정리 전용 — 상태는 바꾸지 않았다)\n",
            rec.id,
            rec.state
        );
    } else {
        outf!(ctx, "run={}  state={}\n", rec.id, rec.state);
    }
    if !rec.closed_tabs.is_empty() {
        outf!(ctx, "탭 {}건 정리:\n", rec.closed_tabs.len());
        for c in &rec.closed_tabs {
            if c.empty {
                outf!(ctx, "  tabId={}  (빈 탭)\n", c.tab_id);
                continue;
            }
            let note = if c.exited {
                ""
            } else {
                "  (에이전트가 시한 안에 끝나지 않았다)"
            };
            outf!(ctx, "  role={}  tabId={}{note}\n", c.role, c.tab_id);
        }
    }
    let closed: BTreeSet<&str> = rec.closed_tabs.iter().map(|c| c.tab_id.as_str()).collect();
    let left: Vec<&CleanupItem> = rec
        .cleanup
        .iter()
        .filter(|c| !c.tab_id.is_empty() && !closed.contains(c.tab_id.as_str()))
        .collect();
    if !left.is_empty() {
        outf!(ctx, "남은 탭 (필요하면 otterctl close-tab --at <tabId>):\n");
        for c in left {
            outf!(
                ctx,
                "  role={}  toolId={}  tabId={}  live={}\n",
                c.role,
                c.tool_id,
                c.tab_id,
                c.live
            );
        }
    }
    if !rec.kept_tools.is_empty() {
        outf!(
            ctx,
            "헤드리스 도구 {}건 보존 (--keep-tools):\n",
            rec.kept_tools.len()
        );
        for o in &rec.kept_tools {
            outf!(
                ctx,
                "  role={}  toolId={}  memberId={}\n",
                o.role,
                o.tool_id,
                o.member_id
            );
        }
    }
    print_orphans(ctx, &rec.orphans);
    let residue: Vec<&RunWorktree> = rec.worktrees.iter().filter(|w| !w.removed).collect();
    if !residue.is_empty() {
        outf!(ctx, "잔여물 {}건 (지우지 않았다):\n", residue.len());
        for wt in residue {
            outf!(ctx, "{}\n", residue_line(wt));
        }
    }
}

/// Go `url.PathEscape`.
pub(crate) fn path_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'$'
            | b'&'
            | b'+'
            | b','
            | b':'
            | b';'
            | b'='
            | b'@' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
