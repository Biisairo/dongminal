use super::*;

// 어느 OS 에서나 절대경로여야 한다 (WINDOWS_TEST_PARITY_SRS §2.2).
#[test]
fn abs_is_absolute_on_every_os() {
    for seg in [
        &["work", "repo"][..],
        &["tmp", "repo"],
        &["r"],
        &["home", "u", "work"],
    ] {
        let got = abs(seg);
        assert!(got.is_absolute(), "abs({seg:?}) = {got:?}");
        let clean: PathBuf = got.components().collect();
        assert_eq!(got, clean, "정규형이 아니다");
    }
}

#[test]
fn abs_without_segments_is_root() {
    assert_eq!(abs(&[]), root());
    assert!(root().is_absolute());
}

#[test]
fn abs_joins_segments_in_order() {
    let got = abs(&["a", "b", "c"]);
    assert_eq!(got, root().join("a").join("b").join("c"));
    assert!(got.ends_with(Path::new("a").join("b").join("c")));
}

#[test]
fn abs_is_stable() {
    let (first, second) = (abs(&["x"]), abs(&["x"]));
    assert_eq!(first, second);
}

#[test]
fn json_quote_escapes_backslash_and_html() {
    assert_eq!(json_quote(r"C:\Users"), r#""C:\\Users""#);
    assert_eq!(json_inner(r"C:\Users"), r"C:\\Users");
    assert_eq!(json_quote("<&>"), r#""\u003c\u0026\u003e""#);
}

#[test]
fn tool_home_is_removed_on_drop() {
    let h = ToolHome::new();
    let p = h.path().to_path_buf();
    assert!(p.is_dir());
    assert_eq!(h.env().0, ENV_TOOL_HOME_NAME);
    drop(h);
    assert!(!p.exists());
}

const ENV_TOOL_HOME_NAME: &str = "DONGMINAL_TOOL_HOME";
