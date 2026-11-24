//! 테스트 전용: testdata 의 Go 기준값(`이름\tbase64`) 을 읽는다.

use std::collections::HashMap;

pub(crate) fn golden(file: &str) -> HashMap<String, Vec<u8>> {
    use base64::Engine as _;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join(file);
    let data = std::fs::read_to_string(path).expect("golden file");
    data.lines()
        .map(|line| {
            let (name, b64) = line.rsplit_once('\t').expect("tab");
            let value = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .expect("base64");
            (name.to_owned(), value)
        })
        .collect()
}

pub(crate) fn golden_str(g: &HashMap<String, Vec<u8>>, name: &str) -> String {
    String::from_utf8(
        g.get(name)
            .unwrap_or_else(|| panic!("no golden {name}"))
            .clone(),
    )
    .expect("utf8")
}
