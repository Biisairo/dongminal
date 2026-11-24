//! 10.5b: 프로그램을 맨 이름으로 띄우면 std 가 PATH 를 직접 훑어 Go 의 ErrDot 거절을 건너뛴다.
//! 맨 이름 리터럴은 `otter_shared_platform::command_path` 를 거쳐야 한다.

use std::path::Path;

fn scan(dir: &Path, re: &regex::Regex, out: &mut Vec<String>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            // gittest 는 시험 지원 crate 다.
            if name != "tests" && name != "target" && name != "gittest" {
                scan(&p, re, out);
            }
            continue;
        }
        if !name.ends_with(".rs") || name == "tests.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&p).unwrap();
        let body = text.split("#[cfg(test)]").next().unwrap_or("");
        for m in re.find_iter(body) {
            out.push(format!("{}: {}", p.display(), m.as_str()));
        }
    }
}

#[test]
fn no_bare_program_literals() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let re = regex::Regex::new(r#"Command::new\("[^"/\\]+"\)"#).unwrap();
    let mut hits = Vec::new();
    scan(&crates, &re, &mut hits);
    assert!(hits.is_empty(), "{hits:#?}");
}
