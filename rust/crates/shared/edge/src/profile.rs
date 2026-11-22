//! 이름 뒤의 번호 (PROFILE_NAME_SRS FR-PFN-4~6). 번호는 저장하지도 주고받지도 않는다 —
//! 각 노드가 지문에서 계산한다.

const TAG_HEX_LEN: usize = 8;
const TAG_MOD: u64 = 10000;

/// 지문 앞 8자리(16진수)를 u32 로 읽고 10000 으로 나눈 나머지를 네 자리로 낸다.
/// 지문이 틀렸으면 빈 값이다.
pub fn tag(fp: &str) -> String {
    let Some(head) = fp.get(..TAG_HEX_LEN) else {
        return String::new();
    };
    // Go strconv.ParseUint 는 부호(`+`)를 받지 않는다. from_str_radix 는 받으므로 먼저 거른다.
    if !head.bytes().all(|c| c.is_ascii_hexdigit()) {
        return String::new();
    }
    match u32::from_str_radix(head, 16) {
        Ok(v) => format!("{:04}", u64::from(v) % TAG_MOD),
        Err(_) => String::new(),
    }
}

/// `이름#번호` 다. 번호를 낼 수 없으면 이름만이다.
pub fn handle(name: &str, fp: &str) -> String {
    let t = tag(fp);
    if t.is_empty() { name.to_string() } else { format!("{name}#{t}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_cases() {
        let cases = [
            (format!("00001a2b{}", "0".repeat(56)), "6699"),
            ("0".repeat(64), "0000"),
            (format!("ffffffff{}", "a".repeat(56)), "7295"),
            (format!("0000270f{}", "b".repeat(56)), "9999"),
            (format!("00002710{}", "b".repeat(56)), "0000"),
            (format!("ABCDEF01{}", "c".repeat(56)), "0001"),
        ];
        for (fp, want) in cases {
            assert_eq!(tag(&fp), want, "{}", &fp[..8]);
        }
        for bad in [String::new(), "abc".into(), format!("zzzzzzzz{}", "0".repeat(56)), "+0001a2b".into()] {
            assert_eq!(tag(&bad), "", "{bad}");
        }
    }

    #[test]
    fn handle_cases() {
        let fp = format!("00001a2b{}", "0".repeat(56));
        assert_eq!(handle("동민", &fp), "동민#6699");
        assert_eq!(handle("동민", ""), "동민");
    }
}
