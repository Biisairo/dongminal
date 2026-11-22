use super::parse::parse_document;

// testdata/go_decode_syntax.txt: go1.27.2 json.Unmarshal(입력, &any) 의 오류 문구(base64 입력 \t base64 문구).
#[test]
fn syntax_errors_match_go() {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let data = include_str!("../../testdata/go_decode_syntax.txt");
    let mut fails = Vec::new();
    let mut n = 0;
    for line in data.lines() {
        let (input, want) = line.split_once('\t').expect("tab");
        let input = b64.decode(input).expect("b64");
        let want = String::from_utf8(b64.decode(want).expect("b64")).expect("utf8");
        let got = match parse_document(&input) {
            Ok(_) => "ok".to_owned(),
            Err(e) => e.msg,
        };
        if got != want {
            fails.push(format!(
                "{:?}\n   got  {got}\n   want {want}",
                String::from_utf8_lossy(&input[..input.len().min(60)])
            ));
        }
        n += 1;
    }
    assert!(
        fails.is_empty(),
        "{} / {n} mismatches:\n{}",
        fails.len(),
        fails[..fails.len().min(30)].join("\n")
    );
}
