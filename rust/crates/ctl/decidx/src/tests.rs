use super::*;
use std::path::PathBuf;

fn write_srs(dir: &Path, name: &str, body: &str) {
    std::fs::write(dir.join(name), body).unwrap();
}

fn ids(es: &[Entry]) -> Vec<&str> {
    es.iter().map(|e| e.id.as_str()).collect()
}

fn has<'a>(es: &'a [Entry], id: &str) -> Option<&'a Entry> {
    es.iter().find(|e| e.id == id)
}

// TC-DSY-1
#[test]
fn collect_reads_list_form() {
    let d = tempfile::tempdir().unwrap();
    write_srs(
        d.path(),
        "A_SRS.md",
        "# A\n\n## 4. 결정\n\n- **D-AAA-1 첫 결정이다.** 근거가 이어진다.\n- **D-AAA-2 둘째 결정이다.**\n",
    );
    let got = collect(d.path()).unwrap();
    assert_eq!(got.len(), 2, "{:?}", ids(&got));
    assert_eq!(
        has(&got, "D-AAA-1").map(|e| e.title.as_str()),
        Some("첫 결정이다.")
    );
}

// TC-DSY-3
#[test]
fn collect_accepts_every_bullet() {
    let d = tempfile::tempdir().unwrap();
    write_srs(
        d.path(),
        "B_SRS.md",
        "# B\n\n- **D-BBB-1 대시.**\n* **D-BBB-2 별표.**\n+ **D-BBB-3 더하기.**\n",
    );
    let got = collect(d.path()).unwrap();
    assert_eq!(got.len(), 3, "{:?}", ids(&got));
}

// TC-DSY-3
#[test]
fn collect_ignores_non_decisions() {
    let d = tempfile::tempdir().unwrap();
    write_srs(
        d.path(),
        "C_SRS.md",
        "# C\n\n- **D-Day 는 결정이 아니다.**\n- **DECIDE-1 도 아니다.**\n- **참고** 굵은 글씨일 뿐이다.\n- **D-CCC-1 이것만 결정이다.**\n",
    );
    let got = collect(d.path()).unwrap();
    assert_eq!(ids(&got), ["D-CCC-1"]);
}

// TC-DSY-2
#[test]
fn collect_table_and_struck_unchanged() {
    let d = tempfile::tempdir().unwrap();
    write_srs(
        d.path(),
        "D_SRS.md",
        "# D\n\n| ID | 결정 | 근거 |\n|---|---|---|\n| **D-DDD-1** | 표 행의 결정 | 그 근거 |\n| ~~**D-DDD-2**~~ | 철회된 결정 | 그 근거 |\n| **D-DDD-3** | 철회된 결정의 원문 | 그 근거 |\n\n~~**D-DDD-3**~~ 는 철회했다.\n",
    );
    let got = collect(d.path()).unwrap();
    let one = has(&got, "D-DDD-1").expect("D-DDD-1");
    assert_eq!(
        (one.title.as_str(), one.why.as_str(), one.status.as_str()),
        ("표 행의 결정", "그 근거", "채택")
    );
    assert!(
        has(&got, "D-DDD-2").is_none(),
        "취소선만 있는 행이 항목이 됐다: {:?}",
        ids(&got)
    );
    assert_eq!(
        has(&got, "D-DDD-3").map(|e| e.status.as_str()),
        Some("철회")
    );
}

#[test]
fn collect_marks_truncated_list_title() {
    let d = tempfile::tempdir().unwrap();
    write_srs(
        d.path(),
        "E_SRS.md",
        "# E\n\n- **D-EEE-1 이 결정은 다음 줄로 이어지고\n  여기서 끝난다.**\n",
    );
    let got = collect(d.path()).unwrap();
    let e = has(&got, "D-EEE-1").expect("D-EEE-1");
    assert!(e.title.ends_with('…'), "{:?}", e.title);
}

#[test]
fn collect_missing_dir_is_empty() {
    let d = tempfile::tempdir().unwrap();
    assert!(collect(&d.path().join("nope")).unwrap().is_empty());
}

#[test]
fn id_order_is_numeric() {
    let mut v = vec!["D-X-10", "D-X-2", "D-X-1", "D-8b", "D-A"];
    v.sort_by(|a, b| id_cmp(a, b));
    assert_eq!(v, ["D-8b", "D-A", "D-X-1", "D-X-2", "D-X-10"]);
}

#[test]
fn cell_escapes_and_cuts() {
    assert_eq!(cell("a|b\nc"), r"a\|b c");
    let long = "가".repeat(141);
    assert_eq!(cell(&long), format!("{}…", "가".repeat(140)));
    assert_eq!(cell(&"가".repeat(140)), "가".repeat(140));
}

/// 저장소의 생성물 `docs/internal/decisions.md` 는 Go 기준선의 `gen-decisions` 가 만든 것이다.
/// 같은 원천에서 Rust 가 만든 문서가 그것과 **바이트 단위로** 같아야 한다.
#[test]
fn render_matches_go_generated_index() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let dir = root.join("docs/internal");
    let want = std::fs::read_to_string(dir.join("decisions.md")).expect("decisions.md");
    let got = render(&collect(&dir).unwrap());
    if got != want {
        let (g, w): (Vec<&str>, Vec<&str>) = (got.lines().collect(), want.lines().collect());
        let i = g
            .iter()
            .zip(&w)
            .position(|(a, b)| a != b)
            .unwrap_or(g.len().min(w.len()));
        panic!(
            "줄 {} 에서 갈린다\n rust: {:?}\n   go: {:?}",
            i + 1,
            g.get(i),
            w.get(i)
        );
    }
}
