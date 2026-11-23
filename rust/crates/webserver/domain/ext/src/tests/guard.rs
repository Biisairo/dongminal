//! FR-EXT-1: 서버 목록은 매니페스트의 것이다. 프로덕션 소스의 문자열에 서버 이름이 나타나면 위반이다.

const BANNED: &[&str] = &[
    "gopls",
    "pyright",
    "typescript-language-server",
    "yaml-language-server",
    "vscode-langservers-extracted",
    "svg-language-server",
    "nodejs.org",
    "npmjs.org",
    "golang.org/x/tools",
];

/// 줄에서 `"…"` 리터럴들을 뽑는다. 주석(`//`)은 문자열 밖에서만 끊는다.
fn literals(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur: Option<String> = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (&mut cur, c) {
            (None, '/') if chars.peek() == Some(&'/') => break,
            (None, '"') => cur = Some(String::new()),
            (Some(s), '\\') => {
                if let Some(n) = chars.next() {
                    s.push(n);
                }
            }
            (Some(_), '"') => out.extend(cur.take()),
            (Some(s), c) => s.push(c),
            (None, _) => {}
        }
    }
    out
}

#[test]
fn no_server_names_in_code() {
    let src = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
    let mut lits = 0;
    for ent in std::fs::read_dir(src).unwrap() {
        let p = ent.unwrap().path();
        if p.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let body = std::fs::read_to_string(&p).unwrap();
        for (i, line) in body.lines().enumerate() {
            for lit in literals(line) {
                lits += 1;
                for b in BANNED {
                    assert!(
                        !lit.contains(b),
                        "{}:{} 의 리터럴 {lit:?} 에 {b:?} 가 있다 — 목록은 매니페스트의 것이다",
                        p.display(),
                        i + 1
                    );
                }
            }
        }
    }
    assert!(lits > 0, "검사할 문자열 리터럴을 하나도 읽지 못했다");
}
