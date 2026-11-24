//! Go `action_test.go` 이식.

use std::collections::BTreeMap;

use super::*;

fn json(a: &Answer) -> String {
    String::from_utf8(otter_gocompat::json::marshal(a).unwrap()).unwrap()
}

#[test]
fn answer_json_shape() {
    assert_eq!(json(&allow()), r#"{"ok":true}"#);
    assert_eq!(
        json(&deny(409, apierr::CODE_NOTHING_TO_STASH, None)),
        r#"{"ok":false,"why":"nothing_to_stash"}"#
    );
    let args = BTreeMap::from([("count".to_owned(), serde_json::json!(2))]);
    assert_eq!(
        json(&deny(409, apierr::CODE_UNTRACKED_ONLY, Some(args))),
        r#"{"ok":false,"why":"untracked_only","args":{"count":2}}"#
    );
}

#[test]
fn deny_keeps_status() {
    assert_eq!(deny(400, apierr::CODE_BAD_REQUEST, None).status, 400);
    assert_eq!(allow().status, 0);
    assert_eq!(
        first([allow(), deny(409, "a", None), deny(400, "b", None)]).why,
        "a"
    );
    assert!(first([allow(), allow()]).ok);
}

#[test]
fn catalog_may_give() {
    let c = catalog();
    assert!(may_give(&c, GIT_STASH_CREATE, apierr::CODE_UNTRACKED_ONLY));
    assert!(!may_give(&c, GIT_STASH_CREATE, apierr::CODE_NO_HEAD));
    assert!(!may_give(
        &c,
        "no.such.action",
        apierr::CODE_NOTHING_TO_STASH
    ));
    assert_eq!(c.len(), 51);
    assert_eq!(
        c[FS_DELETE],
        vec![
            apierr::CODE_EDITOR_ROOT_PROTECTED,
            apierr::CODE_HOME_PROTECTED,
            apierr::CODE_FILESYSTEM_ROOT_PROTECTED,
            apierr::CODE_NOT_FOUND,
            apierr::CODE_PERMISSION,
            apierr::CODE_IO,
            apierr::CODE_TOO_MANY_ENTRIES,
        ]
    );
    assert!(c[RUN_DELETE].is_empty());
}

#[test]
fn catalog_reasons_are_wire_codes() {
    let mut known = apierr::all_codes();
    known.extend(apierr::RUNS.codes());
    for (id, whys) in catalog() {
        for w in whys {
            assert!(
                known.contains(&w),
                "{id} 의 사유 {w} 가 apierr 코드가 아니다"
            );
        }
    }
}

#[test]
fn missing_phrases_cases() {
    let cat = BTreeMap::from([("x.do", vec!["busy_now", "too_big"])]);
    let full = "'why.loading': 'a', 'why.busy_now': 'b', 'why.too_big': 'c',";
    for (ko, en, want) in [
        (full, full, vec![]),
        (
            full,
            "'why.loading': 'a', 'why.busy_now': 'b',",
            vec!["en: why.too_big"],
        ),
        (
            "'why.busy_now': 'b', 'why.too_big': 'c',",
            full,
            vec!["ko: why.loading"],
        ),
        (
            "'why.loading_x': 'a', 'why.busy_now': 'b', 'why.too_big': 'c',",
            full,
            vec!["ko: why.loading"],
        ),
    ] {
        let src = BTreeMap::from([
            ("ko".to_owned(), ko.to_owned()),
            ("en".to_owned(), en.to_owned()),
        ]);
        assert_eq!(missing_phrases(&cat, &src), want);
    }
}
