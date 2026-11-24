//! 이름 변경 전의 옛 이름 (OTTERMINAL_RENAME_SRS). 코드의 옛 이름은 이 파일에만 둔다 (FR-REN-11).

/// 옛 판의 기본 홈. 처음 실행할 때 새 홈으로 옮긴다 (FR-MIG-1).
pub const LEGACY_HOME_DIR: &str = ".dongminal";

/// 옛 제어 명령. 옛 홈의 `bin` 에서 지운다 (FR-MIG-9).
pub const LEGACY_CONTROL_HELPER: &str = "dmctl";

/// 옛 이름 → 새 이름. 긴 이름이 먼저다.
const RENAMES: &[(&str, &str)] = &[
    ("DONGMINAL", "OTTERMINAL"),
    ("Dongminal", "Otterminal"),
    ("dongminal", "otterminal"),
    ("DMCTL", "OTTERCTL"),
    ("Dmctl", "Otterctl"),
    ("dmctl", "otterctl"),
];

/// 옛 이름으로 기록된 Go 기준 자료를 새 이름으로 읽는다 (FR-REN-10).
pub fn current_names(s: &str) -> String {
    RENAMES
        .iter()
        .fold(s.to_owned(), |acc, (old, new)| acc.replace(old, new))
}

/// 새 이름 → 옛 이름. 길이·해시만 기록된 Go 기준 자료와 견줄 때 쓴다 (FR-REN-10).
pub fn legacy_names(s: &str) -> String {
    RENAMES
        .iter()
        .fold(s.to_owned(), |acc, (old, new)| acc.replace(new, old))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_case() {
        assert_eq!(
            current_names("dongminal Dongminal DONGMINAL_HOME dongminald dmctl DMCTL_X Dmctl"),
            "otterminal Otterminal OTTERMINAL_HOME otterminald otterctl OTTERCTL_X Otterctl"
        );
    }

    #[test]
    fn round_trips() {
        let s = "otterminal OTTERMINAL_HOME otterctl";
        assert_eq!(current_names(&legacy_names(s)), s);
        assert_eq!(legacy_names(s), "dongminal DONGMINAL_HOME dmctl");
    }

    #[test]
    fn leaves_other_text() {
        assert_eq!(
            current_names("admin dm_x /tmp/dm611"),
            "admin dm_x /tmp/dm611"
        );
    }
}
