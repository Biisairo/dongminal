//! 기대값은 go1.27.2 `url.ParseQuery`·`QueryUnescape`·`PathUnescape` 실측이다.

use super::*;

type Unescaped<'a> = Result<&'a [u8], &'a str>;

type Pairs<'a> = &'a [(&'a [u8], &'a [&'a [u8]])];

fn check(raw: &str, want: Pairs<'_>, want_err: Option<&str>) {
    let (v, err) = parse_query(raw);
    let mut got: Vec<(&[u8], Vec<&[u8]>)> = v
        .keys()
        .map(|k| {
            let vals = v
                .entries
                .iter()
                .find(|(kk, _)| kk == k)
                .map(|(_, vs)| vs.iter().map(Vec::as_slice).collect())
                .unwrap_or_default();
            (k, vals)
        })
        .collect();
    got.sort_by(|a, b| a.0.cmp(b.0));
    let want: Vec<(&[u8], Vec<&[u8]>)> = want.iter().map(|(k, vs)| (*k, vs.to_vec())).collect();
    assert_eq!(got, want, "pairs of {raw:?}");
    assert_eq!(
        err.map(|e| e.to_string()).as_deref(),
        want_err,
        "err of {raw:?}"
    );
}

const ESC_ZZ: &str = "invalid URL escape \"%zz\"";
const SEMI: &str = "invalid semicolon separator in query";

#[test]
fn parse_query_matches_go() {
    check("", &[], None);
    check("a=1", &[(b"a", &[b"1"])], None);
    check(
        "a=1&a=2&b=3",
        &[(b"a", &[b"1", b"2"]), (b"b", &[b"3"])],
        None,
    );
    check("a=1;b=2&c=3", &[(b"c", &[b"3"])], Some(SEMI));
    check("c=3&a;=1", &[(b"c", &[b"3"])], Some(SEMI));
    check("a=%zz&b=2", &[(b"b", &[b"2"])], Some(ESC_ZZ));
    check("a=%4", &[], Some("invalid URL escape \"%4\""));
    check("a=%41%42", &[(b"a", &[b"AB"])], None);
    check("a=x+y%2By", &[(b"a", &[b"x y+y"])], None);
    check("=v&a=1", &[(b"", &[b"v"]), (b"a", &[b"1"])], None);
    check("&&a=1&", &[(b"a", &[b"1"])], None);
    check("a", &[(b"a", &[b""])], None);
    check("a=&a=", &[(b"a", &[b"", b""])], None);
    check("%zz=1&a=ok", &[(b"a", &[b"ok"])], Some(ESC_ZZ));
    check("a=%FF%FE", &[(b"a", &[b"\xff\xfe"])], None);
    check("a=1&b=%zz;", &[(b"a", &[b"1"])], Some(SEMI));
    check("a=b=c", &[(b"a", &[b"b=c"])], None);
    check("+a+=+", &[(b" a ", &[b" "])], None);
    check("a=%%41", &[], Some("invalid URL escape \"%%4\""));
    check("a=1&a=%zz&a=3", &[(b"a", &[b"1", b"3"])], Some(ESC_ZZ));
    check("a=%e4%b8%80", &[(b"a", &["一".as_bytes()])], None);
}

#[test]
fn get_has() {
    let (v, _) = parse_query("a=1&a=2&e=&x=%FF");
    assert_eq!(v.get("a").as_deref(), Some("1"));
    assert_eq!(v.get_or_empty("none"), "");
    assert!(v.has("e") && !v.has("none"));
    assert_eq!(v.get("e").as_deref(), Some(""));
    assert_eq!(v.get_bytes("x"), Some(&b"\xff"[..]));
    assert_eq!(v.get("x").as_deref(), Some("\u{fffd}"));
    assert_eq!(v.get_all("a").map(<[_]>::len), Some(2));
    assert_eq!(v.len(), 3);
}

#[test]
fn param_limit() {
    let ok = "a=1&".repeat(9999) + "b=2";
    let (v, err) = parse_query(&ok);
    assert_eq!(
        (v.get_all("a").map(<[_]>::len), v.get("b").as_deref(), err),
        (Some(9999), Some("2"), None)
    );
    let over = "a=1&".repeat(10000) + "b=2";
    let (v, err) = parse_query(&over);
    assert!(v.is_empty());
    assert_eq!(
        err.map(|e| e.to_string()).as_deref(),
        Some("number of URL query parameters exceeded limit")
    );
}

#[test]
fn unescape_matches_go() {
    let cases: &[(&str, Unescaped<'_>, Unescaped<'_>)] = &[
        ("a+b%20c", Ok(b"a b c"), Ok(b"a+b c")),
        ("%zz", Err(ESC_ZZ), Err(ESC_ZZ)),
        (
            "%4",
            Err("invalid URL escape \"%4\""),
            Err("invalid URL escape \"%4\""),
        ),
        (
            "%",
            Err("invalid URL escape \"%\""),
            Err("invalid URL escape \"%\""),
        ),
        (
            "x%G1",
            Err("invalid URL escape \"%G1\""),
            Err("invalid URL escape \"%G1\""),
        ),
        ("%e4%b8%80", Ok("一".as_bytes()), Ok("一".as_bytes())),
        ("%FF", Ok(b"\xff"), Ok(b"\xff")),
    ];
    for (s, q, p) in cases {
        let got_q = query_unescape(s).map_err(|e| e.to_string());
        let got_p = path_unescape(s).map_err(|e| e.to_string());
        assert_eq!(
            got_q,
            q.map(<[u8]>::to_vec).map_err(str::to_owned),
            "query {s:?}"
        );
        assert_eq!(
            got_p,
            p.map(<[u8]>::to_vec).map_err(str::to_owned),
            "path {s:?}"
        );
    }
}

#[test]
fn escape_error_quotes_bytes() {
    assert_eq!(
        query_unescape(b"%\xff\xfe").map_err(|e| e.to_string()),
        Err("invalid URL escape \"%\\xff\\xfe\"".to_owned())
    );
}
