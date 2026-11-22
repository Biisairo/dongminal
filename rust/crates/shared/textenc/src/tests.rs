use super::*;

fn cp949(s: &str) -> Vec<u8> {
    let (b, _, bad) = EUC_KR.encode(s);
    assert!(!bad);
    b.into_owned()
}

fn bytes(r: Result<Encoded, EncodeError>) -> Vec<u8> {
    match r {
        Ok(Encoded::Bytes(b)) => b,
        other => panic!("bytes 가 아니다: {other:?}"),
    }
}

fn unmappable(r: Result<Encoded, EncodeError>) -> Option<Unmappable> {
    match r {
        Ok(Encoded::Unmappable(u)) => Some(u),
        Ok(Encoded::Bytes(_)) => None,
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn detect_order() {
    let mut utf8_bom = BOM_UTF8.to_vec();
    utf8_bom.extend("가a".as_bytes());
    // (이름, 입력, 인코딩, BOM, 글, 디코드 가능)
    type Case = (
        &'static str,
        Vec<u8>,
        &'static str,
        bool,
        &'static str,
        bool,
    );
    let cases: Vec<Case> = vec![
        ("utf8-bom", utf8_bom, UTF8, true, "가a", true),
        (
            "utf16le-bom",
            vec![0xFF, 0xFE, b'a', 0, 0x00, 0xAC],
            UTF16LE,
            true,
            "a가",
            true,
        ),
        (
            "utf16be-bom",
            vec![0xFE, 0xFF, 0, b'a', 0xAC, 0x00],
            UTF16BE,
            true,
            "a가",
            true,
        ),
        (
            "utf8",
            "한글 text".as_bytes().to_vec(),
            UTF8,
            false,
            "한글 text",
            true,
        ),
        (
            "cp949",
            cp949("한글 텍스트"),
            CP949,
            false,
            "한글 텍스트",
            true,
        ),
        (
            "undecodable",
            vec![0xFF, 0xFF, 0x80, 0x00],
            UTF8,
            false,
            "",
            false,
        ),
    ];
    for (name, input, enc, bom, text, ok) in cases {
        let d = detect(&input);
        assert!(
            d.enc == enc && d.bom == bom && d.decodable == ok && (!ok || d.text == text),
            "{name}: {d:?}"
        );
    }
    let d = detect(&[0xFF, 0xFE, 0, 0, b'a', 0, 0, 0]);
    assert_ne!(d.enc, UTF16LE, "UTF-32LE 를 UTF-16LE 로 봤다: {d:?}");
}

#[test]
fn detect_undecodable_text_collapses_invalid_runs() {
    let d = detect(&[b'a', 0xFF, 0xFF, 0x80, b'b', 0xFE]);
    assert_eq!(d.text, "a\u{fffd}b\u{fffd}");
    assert!(!d.decodable);
}

#[test]
fn decode_as_strict() {
    let d = decode_as(&cp949("안녕"), CP949).expect("cp949");
    assert_eq!(d.text, "안녕");
    assert!(
        decode_as("안녕".as_bytes(), CP949).is_none(),
        "UTF-8 바이트를 CP949 로 엄격 디코드했다"
    );
    for b in WIN1252_UNDEFINED {
        assert!(decode_as(&[b'a', b], WIN1252).is_none(), "미정의 0x{b:X}");
    }
    let d = decode_as(&[b'c', 0xE9], WIN1252).expect("1252");
    assert_eq!(d.text, "cé");
    let d = decode_as(&[0xEF, 0xBB, 0xBF, b'x'], UTF8).expect("utf-8 BOM");
    assert!(d.bom && d.text == "x");
    assert!(
        decode_as(b"x", "koi8-r").is_none(),
        "모르는 인코딩을 받았다"
    );
}

#[test]
fn decode_as_rejects_replacement_char_in_source() {
    // Go 는 디코드 결과에 U+FFFD 가 있으면 실패로 본다 — 원문의 U+FFFD 도 마찬가지다.
    assert!(decode_as(&[0xFD, 0xFF], UTF16LE).is_none());
    assert!(
        decode_as(&[0x61, 0x00, 0x00], UTF16LE).is_none(),
        "홀수 길이"
    );
    assert!(
        decode_as(&[0x00, 0xD8, 0x61, 0x00], UTF16LE).is_none(),
        "외톨이 대리"
    );
}

#[test]
fn encode_round_trip_and_bom() {
    for (enc, bom) in [
        (UTF8, false),
        (UTF8, true),
        (UTF16LE, true),
        (UTF16BE, true),
        (CP949, false),
    ] {
        let out = bytes(encode("한글 abc\r\n끝", enc, bom));
        let d = decode_as(&out, enc).unwrap_or_else(|| panic!("{enc} 왕복"));
        assert_eq!(d.text, "한글 abc\r\n끝");
        assert_eq!(d.bom, bom || enc == UTF16LE || enc == UTF16BE, "{enc}");
    }
    assert_eq!(bytes(encode("a", UTF8, false)), b"a");
    assert_eq!(bytes(encode("a", UTF16BE, false)), [0xFE, 0xFF, 0, b'a']);
}

#[test]
fn encode_unknown_is_error() {
    assert_eq!(encode("a", "koi8-r", false), Err(EncodeError));
    assert_eq!(EncodeError.to_string(), "encoding: invalid UTF-8");
}

#[test]
fn encode_unmappable_first_position() {
    let u = unmappable(encode("ok\n𝄞a😀", CP949, false)).expect("unmappable");
    assert_eq!((u.line, u.col, u.ch.as_str()), (2, 1, "𝄞"));
    assert!(
        unmappable(encode("ab\ncd€x", WIN1252, false)).is_none(),
        "€ 를 거절했다"
    );
    let u = unmappable(encode("a😀가", SHIFT_JIS_ID, false)).expect("sjis");
    assert_eq!((u.line, u.col), (1, 2));
    let u = unmappable(encode("😀😀\n가𝄞", WIN1252, false)).expect("1252");
    assert_eq!((u.line, u.col, u.ch.as_str()), (1, 1, "😀"));
    let u = unmappable(encode("ab😀", CP949, false)).expect("cp949");
    assert_eq!((u.line, u.col), (1, 3));
    let u = unmappable(encode("😀x\u{0101}", WIN1252, false));
    assert_eq!(u.map(|u| u.col), Some(1));
    let u = unmappable(encode("x😀\u{0101}", WIN1252, false)).expect("1252");
    assert_eq!(u.col, 2);
}

#[test]
fn has_utf16_bom_cases() {
    assert!(has_utf16_bom(&[0xFF, 0xFE, b'a', 0]) && has_utf16_bom(&[0xFE, 0xFF, 0, b'a']));
    assert!(!has_utf16_bom(&[0xFF, 0xFE, 0, 0]) && !has_utf16_bom(b"ab"));
}

#[test]
fn valid_ids() {
    for id in [UTF8, UTF16LE, UTF16BE, CP949, SHIFT_JIS_ID, WIN1252] {
        assert!(valid(id), "{id}");
    }
    assert!(!valid("koi8-r") && !valid("UTF-8"));
    assert_eq!(
        REOPEN_CHOICES,
        ["utf-8", "cp949", "shift_jis", "windows-1252"]
    );
}

/// x/text 와 encoding_rs 가 갈리는 자리 — 기준선과 전수 대조한 값이다.
#[test]
fn xtext_encoder_quirks() {
    // NEC 선정 IBM 확장은 ED/EE 행으로 간다 (WHATWG 는 FA/FB).
    assert_eq!(bytes(encode("\u{2170}", SHIFT_JIS_ID, false)), [0xEE, 0xEF]);
    assert_eq!(
        bytes(encode("a\u{51ec}b", SHIFT_JIS_ID, false)),
        [b'a', 0xED, 0x66, b'b']
    );
    // x/text 가 거절하는 글자.
    for c in ["\u{80}", "\u{a5}", "\u{203e}", "\u{2212}"] {
        assert!(
            unmappable(encode(c, SHIFT_JIS_ID, false)).is_some(),
            "{c:?}"
        );
    }
    for c in ["\u{81}", "\u{8d}", "\u{8f}", "\u{90}", "\u{9d}"] {
        assert!(unmappable(encode(c, WIN1252, false)).is_some(), "{c:?}");
    }
    // 그래서 엄격 디코드도 갈린다: ED40 은 왕복하고 FA40 은 왕복하지 않는다.
    assert_eq!(
        decode_as(&[0xED, 0x40], SHIFT_JIS_ID).map(|d| d.text),
        Some("\u{7e8a}".to_owned())
    );
    assert!(decode_as(&[0xFA, 0x40], SHIFT_JIS_ID).is_none());
    assert!(decode_as(&[0x80], SHIFT_JIS_ID).is_none());
}
