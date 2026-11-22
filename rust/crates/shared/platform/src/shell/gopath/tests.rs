//! 표는 go1.27.2 `path/filepath/path_test.go` 의 것을 그대로 옮겼다.

use super::Conv::{self, Unix, Windows};

const CLEAN: &[(&str, &str)] = &[
    ("abc", "abc"),
    ("abc/def", "abc/def"),
    ("a/b/c", "a/b/c"),
    (".", "."),
    ("..", ".."),
    ("../..", "../.."),
    ("../../abc", "../../abc"),
    ("/abc", "/abc"),
    ("/", "/"),
    ("", "."),
    ("abc/", "abc"),
    ("abc/def/", "abc/def"),
    ("a/b/c/", "a/b/c"),
    ("./", "."),
    ("../", ".."),
    ("../../", "../.."),
    ("/abc/", "/abc"),
    ("abc//def//ghi", "abc/def/ghi"),
    ("abc//", "abc"),
    ("abc/./def", "abc/def"),
    ("/./abc/def", "/abc/def"),
    ("abc/.", "abc"),
    ("abc/def/ghi/../jkl", "abc/def/jkl"),
    ("abc/def/../ghi/../jkl", "abc/jkl"),
    ("abc/def/..", "abc"),
    ("abc/def/../..", "."),
    ("/abc/def/../..", "/"),
    ("abc/def/../../..", ".."),
    ("/abc/def/../../..", "/"),
    ("abc/def/../../../ghi/jkl/../../../mno", "../../mno"),
    ("/../abc", "/abc"),
    ("a/../b:/../../c", "../c"),
    ("abc/./../def", "def"),
    ("abc//./../def", "def"),
    ("abc/../../././../def", "../../def"),
];

const NONWIN_CLEAN: &[(&str, &str)] = &[("//abc", "/abc"), ("///abc", "/abc"), ("//abc//", "/abc")];

const WIN_CLEAN: &[(&str, &str)] = &[
    (r"c:", r"c:."),
    (r"c:\", r"c:\"),
    (r"c:\abc", r"c:\abc"),
    (r"c:abc\..\..\.\.\..\def", r"c:..\..\def"),
    (r"c:\abc\def\..\..", r"c:\"),
    (r"c:\..\abc", r"c:\abc"),
    (r"c:..\abc", r"c:..\abc"),
    (r"c:\b:\..\..\..\d", r"c:\d"),
    (r"\", r"\"),
    (r"/", r"\"),
    (r"\\i\..\c$", r"\c$"),
    (r"\\i\..\i\c$", r"\i\c$"),
    (r"\\i\..\I\c$", r"\I\c$"),
    (r"\\..\..\a", r"\a"),
    (r"//../../a", r"\a"),
    (r"\\host\share\foo\..\bar", r"\\host\share\bar"),
    (r"//host/share/foo/../baz", r"\\host\share\baz"),
    (r"\\host\share\foo\..\..\..\..\bar", r"\\host\share\bar"),
    (
        r"\\?\UNC\host\share\foo\..\..\..\..\bar",
        r"\\?\UNC\host\share\bar",
    ),
    (
        r"\??\UNC\host\share\foo\..\..\..\..\bar",
        r"\??\UNC\host\share\bar",
    ),
    (r"\\.\C:\a\..\..\..\..\bar", r"\\.\C:\bar"),
    (r"\\.\C:\\\\a", r"\\.\C:\a"),
    (r"\\a\b\..\c", r"\\a\b\c"),
    (r"\\a\b", r"\\a\b"),
    (r".\c:", r".\c:"),
    (r".\c:\foo", r".\c:\foo"),
    (r".\c:foo", r".\c:foo"),
    (r"//abc", r"\\abc"),
    (r"///abc", r"\\\abc"),
    (r"//abc//", r"\\abc\\"),
    (r"\\?\C:\", r"\\?\C:\"),
    (r"\\?\C:\a", r"\\?\C:\a"),
    (r"a/../c:", r".\c:"),
    (r"a\..\c:", r".\c:"),
    (r"a/../c:/a", r".\c:\a"),
    (r"a/../../c:", r"..\c:"),
    (r"foo:bar", r"foo:bar"),
    (r"/a/../??/a", r"\.\??\a"),
];

fn check_clean(c: Conv, tests: &[(String, String)]) {
    for (i, o) in tests {
        assert_eq!(c.clean(i), *o, "{c:?} clean({i:?})");
        assert_eq!(c.clean(o), *o, "{c:?} clean({o:?})");
    }
}

fn owned(t: &[(&str, &str)]) -> Vec<(String, String)> {
    t.iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

#[test]
fn clean_unix() {
    let mut t = owned(CLEAN);
    t.extend(owned(NONWIN_CLEAN));
    check_clean(Unix, &t);
}

#[test]
fn clean_windows() {
    let mut t: Vec<(String, String)> = CLEAN
        .iter()
        .map(|(a, b)| (a.to_string(), b.replace('/', "\\")))
        .collect();
    t.extend(owned(WIN_CLEAN));
    check_clean(Windows, &t);
}

const JOIN: &[(&[&str], &str)] = &[
    (&[], ""),
    (&[""], ""),
    (&["/"], "/"),
    (&["a"], "a"),
    (&["a", "b"], "a/b"),
    (&["a", ""], "a"),
    (&["", "b"], "b"),
    (&["/", "a"], "/a"),
    (&["/", "a/b"], "/a/b"),
    (&["/", ""], "/"),
    (&["/a", "b"], "/a/b"),
    (&["a", "/b"], "a/b"),
    (&["/a", "/b"], "/a/b"),
    (&["a/", "b"], "a/b"),
    (&["a/", ""], "a"),
    (&["", ""], ""),
    (&["/", "a", "b"], "/a/b"),
];

const NONWIN_JOIN: &[(&[&str], &str)] = &[(&["//", "a"], "/a")];

const WIN_JOIN: &[(&[&str], &str)] = &[
    (&["directory", "file"], r"directory\file"),
    (&[r"C:\Windows\", "System32"], r"C:\Windows\System32"),
    (&[r"C:\Windows\", ""], r"C:\Windows"),
    (&[r"C:\", "Windows"], r"C:\Windows"),
    (&["C:", "a"], "C:a"),
    (&["C:", r"a\b"], r"C:a\b"),
    (&["C:", "a", "b"], r"C:a\b"),
    (&["C:", "", "b"], "C:b"),
    (&["C:", "", "", "b"], "C:b"),
    (&["C:", ""], "C:."),
    (&["C:", "", ""], "C:."),
    (&["C:", r"\a"], r"C:\a"),
    (&["C:", "", r"\a"], r"C:\a"),
    (&["C:.", "a"], "C:a"),
    (&["C:a", "b"], r"C:a\b"),
    (&["C:a", "b", "d"], r"C:a\b\d"),
    (&[r"\\host\share", "foo"], r"\\host\share\foo"),
    (&[r"\\host\share\foo"], r"\\host\share\foo"),
    (&["//host/share", "foo/bar"], r"\\host\share\foo\bar"),
    (&[r"\"], r"\"),
    (&[r"\", ""], r"\"),
    (&[r"\", "a"], r"\a"),
    (&[r"\\", "a"], r"\\a"),
    (&[r"\", "a", "b"], r"\a\b"),
    (&[r"\\", "a", "b"], r"\\a\b"),
    (&[r"\", r"\\a\b", "c"], r"\a\b\c"),
    (&[r"\\a", "b", "c"], r"\\a\b\c"),
    (&[r"\\a\", "b", "c"], r"\\a\b\c"),
    (&["//", "a"], r"\\a"),
    (&[r"a:\b\c", r"x\..\y:\..\..\z"], r"a:\b\z"),
    (&[r"\", r"??\a"], r"\.\??\a"),
];

#[test]
fn join_unix() {
    for (e, o) in JOIN.iter().chain(NONWIN_JOIN) {
        assert_eq!(Unix.join(e), *o, "join({e:?})");
    }
}

#[test]
fn join_windows() {
    for (e, o) in JOIN {
        assert_eq!(Windows.join(e), o.replace('/', "\\"), "join({e:?})");
    }
    for (e, o) in WIN_JOIN {
        assert_eq!(Windows.join(e), *o, "join({e:?})");
    }
}

const BASE: &[(&str, &str)] = &[
    ("", "."),
    (".", "."),
    ("/.", "."),
    ("/", "/"),
    ("////", "/"),
    ("x/", "x"),
    ("abc", "abc"),
    ("abc/def", "def"),
    ("a/b/.x", ".x"),
    ("a/b/c.", "c."),
    ("a/b/c.x", "c.x"),
];

const WIN_BASE: &[(&str, &str)] = &[
    (r"c:\", r"\"),
    (r"c:.", "."),
    (r"c:\a\b", "b"),
    (r"c:a\b", "b"),
    (r"c:a\b\c", "c"),
    (r"\\host\share\", r"\"),
    (r"\\host\share\a", "a"),
    (r"\\host\share\a\b", "b"),
];

#[test]
fn base_both() {
    for (i, o) in BASE {
        assert_eq!(Unix.base(i), *o, "unix base({i:?})");
        assert_eq!(Windows.base(i), o.replace('/', "\\"), "windows base({i:?})");
    }
    for (i, o) in WIN_BASE {
        assert_eq!(Windows.base(i), *o, "windows base({i:?})");
    }
}

const WIN_IS_ABS: &[(&str, bool)] = &[
    (r"C:\", true),
    (r"c\", false),
    (r"c::", false),
    (r"c:", false),
    (r"/", false),
    (r"\", false),
    (r"\Windows", false),
    (r"c:a\b", false),
    (r"c:\a\b", true),
    (r"c:/a/b", true),
    (r"\\host\share", true),
    (r"\\host\share\", true),
    (r"\\host\share\foo", true),
    (r"//host/share/foo/bar", true),
    (r"\\..\..\a", false),
    (r"//../../a", false),
    (r"\\i\..\c$", false),
    (r"//?/../x", false),
    (r"//./../x", false),
    (r"\\?\a\b\c", true),
    (r"\??\a\b\c", true),
];

#[test]
fn is_abs_both() {
    for (p, want) in [
        ("", false),
        ("/", true),
        ("/usr/bin", true),
        ("..", false),
        ("a/b", false),
    ] {
        assert_eq!(Unix.is_abs(p), want, "unix is_abs({p:?})");
    }
    for (p, want) in WIN_IS_ABS {
        assert_eq!(Windows.is_abs(p), *want, "windows is_abs({p:?})");
    }
}

#[test]
fn split_list_both() {
    assert!(Unix.split_list("").is_empty());
    assert_eq!(Unix.split_list("a:b::c"), ["a", "b", "", "c"]);
    assert!(Windows.split_list("").is_empty());
    assert_eq!(Windows.split_list("a;b"), ["a", "b"]);
    assert_eq!(Windows.split_list(r#""a;b";c"#), ["a;b", "c"]);
    assert_eq!(Windows.split_list(";"), ["", ""]);
    assert_eq!(Windows.split_list(r#""a"b;c"#), ["ab", "c"]);
}
