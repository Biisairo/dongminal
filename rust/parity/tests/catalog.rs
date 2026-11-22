//! 등록 시나리오 목록 자체의 검사: 검증 통과, 이름 중복 없음, 담당 이슈가 실제로 있다.

use std::collections::BTreeSet;
use std::path::Path;

use dm_parity::issues::load_status;
use dm_parity::scenarios;

#[test]
fn every_scenario_is_valid_unique_and_owned() {
    let all = scenarios::all();
    let issues =
        load_status(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../rust-port/issues")).unwrap();
    let mut names = BTreeSet::new();
    for s in &all {
        assert!(
            names.insert(s.name().to_string()),
            "이름 중복: {}",
            s.name()
        );
        assert!(s.validate().is_empty(), "{}: {:?}", s.name(), s.validate());
        let owner = s
            .owner_issue()
            .unwrap_or_else(|| panic!("{}: 담당 이슈가 없다", s.name()));
        assert!(
            issues.contains_key(owner),
            "{}: 이슈 {owner} 가 없다",
            s.name()
        );
    }
}
