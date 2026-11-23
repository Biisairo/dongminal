//! Go `mime/type_unix_test.go` 와 `initMimeUnix` 의 읽기 순서·우선순위다. 호스트 파일 대신 임시 파일을 읽는다.

use std::path::{Path, PathBuf};

use crate::mimetable::{MimeTable, init_mime_unix};

/// Go `mime/testdata/test.types`.
const TEST_TYPES: &str = "# Copyright 2010 The Go Authors. All rights reserved.\n\
# Use of this source code is governed by a BSD-style\n\
# license that can be found in the LICENSE file.\n\
\n\
\n\
 # mime package test\n\
application/test\tt1\t# Simple test\n\
text/test\t\tt2\t# Text test\n";

/// Go `mime/testdata/test.types.globs2`.
const TEST_GLOBS2: &str = "# Copyright 2021 The Go Authors. All rights reserved.\n\
# Use of this source code is governed by a BSD-style\n\
# license that can be found in the LICENSE file.\n\
\n\
\n\
# mime package test for globs2\n\
50:document/test:*.t3\n\
50:example/test:*.t4\n\
50:text/plain:*,v\n\
50:application/x-trash:*~\n\
30:example/do-not-use:*.t4\n\
10:example/glob-question-mark:*.foo?ar\n\
10:example/glob-asterisk:*.foo*r\n\
10:example/glob-range:*.foo[1-3]\n";

fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    p
}

/// Go `TestTypeByExtensionUNIX`.
#[test]
fn type_by_extension_unix_go_vectors() {
    let dir = tempfile::tempdir().unwrap();
    let mut t = MimeTable::builtin();
    assert!(t.load_globs_file(&write(dir.path(), "globs2", TEST_GLOBS2)));
    t.load_mime_file(&write(dir.path(), "test.types", TEST_TYPES));
    for (ext, want) in [
        (".T1", "application/test"),
        (".t2", "text/test; charset=utf-8"),
        (".t3", "document/test"),
        (".t4", "example/test"),
        (".png", "image/png"),
        (",v", ""),
        ("~", ""),
        (".foo?ar", ""),
        (".foo*r", ""),
        (".foo[1-3]", ""),
    ] {
        assert_eq!(t.lookup(ext), want, "{ext}");
    }
}

#[test]
fn mime_types_format() {
    let dir = tempfile::tempdir().unwrap();
    let body = "# 주석 줄\r\n\
image/x-png png\r\n\
text/x-a a1 A2 # b3\n\
text/x-b; charset=latin1 b1\n\
text/x-c;charset= c1\n\
text/x-d;charset=latin1 d2\n\
text/x-r;Z=\"b/c\" r1\n\
TEXT/X-Q;Z=\"b/c\" q1\n\
application/x-one\n\
bad/// d1\n\
application/x-mixed Mx\n";
    let f = write(dir.path(), "mime.types", body);
    let t = init_mime_unix(&[], &[&f]);
    // mime.types 는 내장 표를 덮어쓴다.
    assert_eq!(t.lookup(".png"), "image/x-png");
    // text/ 에 charset 이 없으면 utf-8 을 붙인다(FormatMediaType 꼴).
    assert_eq!(t.lookup(".a1"), "text/x-a; charset=utf-8");
    assert_eq!(t.lookup(".A2"), "text/x-a; charset=utf-8");
    assert_eq!(t.lookup(".a2"), "text/x-a; charset=utf-8");
    // `#` 로 시작하는 필드부터는 버린다.
    assert_eq!(t.lookup(".b3"), "");
    // 필드 나누기는 공백이라 `text/x-b;` 가 형식이고 `charset=latin1` 은 확장자가 된다.
    assert_eq!(t.lookup(".b1"), "text/x-b; charset=utf-8");
    assert_eq!(t.lookup(".charset=latin1"), "text/x-b; charset=utf-8");
    // `text/` 는 대소문자를 가린다. charset 을 붙일 때는 FormatMediaType 꼴(정렬·인용)로 다시 쓴다.
    assert_eq!(t.lookup(".q1"), "TEXT/X-Q;Z=\"b/c\"");
    assert_eq!(t.lookup(".r1"), "text/x-r; charset=utf-8; z=\"b/c\"");
    // charset 이 있으면 적힌 그대로 둔다.
    assert_eq!(t.lookup(".d2"), "text/x-d;charset=latin1");
    // 빈 매개변수 값은 풀리지 않아 버린다.
    assert_eq!(t.lookup(".c1"), "");
    // 확장자가 없는 줄, 풀리지 않는 형식은 버린다.
    assert_eq!(t.lookup(".d1"), "");
    // 대소문자 그대로 먼저, 그다음 소문자로 찾는다.
    assert_eq!(t.lookup(".Mx"), "application/x-mixed");
    assert_eq!(t.lookup(".MX"), "application/x-mixed");
    assert_eq!(t.lookup(".mx"), "application/x-mixed");
}

/// 뒤의 mime.types 가 앞의 것을 덮어쓴다. 없는 파일은 건너뛴다.
#[test]
fn mime_types_later_file_wins() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.types", "application/x-first zz\n");
    let b = write(dir.path(), "b.types", "application/x-second zz\n");
    let missing = dir.path().join("none.types");
    let t = init_mime_unix(&[&missing], &[&a, &missing, &b]);
    assert_eq!(t.lookup(".zz"), "application/x-second");
}

/// globs2 를 하나라도 열면 거기서 멈춘다 — 다음 globs2 와 mime.types 를 읽지 않는다.
#[test]
fn globs2_stops_search() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("none.globs2");
    let g1 = write(
        dir.path(),
        "g1",
        "50:application/x-g1:*.gg\n\
         40:application/x-later:*.gg\n\
         50:text/html:*.html\n\
         50:application/x-upper:*.HTML\n\
         50:text/x-t:*.tt\n\
         #50:application/x-c:*.cc\n\
         50:application/x-n:foo.nn\n\
         :application/x-w:*.ww\n",
    );
    let g2 = write(dir.path(), "g2", "50:application/x-g2:*.g2\n");
    let types = write(dir.path(), "t.types", "application/x-types gg tx\n");
    let t = init_mime_unix(&[&missing, &g1, &g2], &[&types]);
    // 같은 확장자는 먼저 본 것이 이긴다.
    assert_eq!(t.lookup(".gg"), "application/x-g1");
    // 내장 표에 이미 있는 (대소문자 그대로의) 확장자는 덮어쓰지 않는다.
    assert_eq!(t.lookup(".html"), "text/html; charset=utf-8");
    // 대문자 확장자는 새 키라 소문자 표의 자리를 덮어쓴다 (Go 그대로).
    assert_eq!(t.lookup(".HTML"), "application/x-upper");
    assert_eq!(t.lookup(".Html"), "application/x-upper");
    assert_eq!(t.lookup(".tt"), "text/x-t; charset=utf-8");
    assert_eq!(t.lookup(".cc"), "");
    assert_eq!(t.lookup(".nn"), "");
    assert_eq!(t.lookup(".ww"), "");
    assert_eq!(t.lookup(".g2"), "");
    assert_eq!(t.lookup(".tx"), "");
}

/// 빈 globs2 도 찾은 것이다.
#[test]
fn empty_globs2_still_stops() {
    let dir = tempfile::tempdir().unwrap();
    let g = write(dir.path(), "g", "");
    let types = write(dir.path(), "t.types", "application/x-types tx\n");
    let t = init_mime_unix(&[&g], &[&types]);
    assert_eq!(t.lookup(".tx"), "");
}

/// 호스트 파일이 하나도 없으면 내장 표만이다.
#[test]
fn no_host_files_builtin_only() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    let t = init_mime_unix(&[&a], &[&b]);
    assert_eq!(t.lookup(".png"), "image/png");
    assert_eq!(t.lookup(".PNG"), "image/png");
    assert_eq!(t.lookup(".js"), "text/javascript; charset=utf-8");
    assert_eq!(t.lookup(".woff"), "");
    assert_eq!(t.lookup(""), "");
}
