use std::time::Duration;

use super::*;

#[test]
fn budget_values() {
    assert_eq!(ALAC_STORAGE_UNIT, 1_000);
    assert_eq!(FEED_SLACK, 256);
    assert_eq!(EMU_KEEP_MIN, 64);
    assert_eq!(SCREEN_IDLE_COMPACT, Duration::from_secs(5 * 60));
    assert_eq!(STORE_BLOCK_LINES, 256);
    assert_eq!(OUTPUT_RING_BYTES, 1 << 20);
}

#[test]
fn history_lines_default_is_within_range() {
    assert_eq!(HISTORY_LINES_DEFAULT, 20_000);
    assert_eq!(HISTORY_LINES_MIN, 1_000);
    assert_eq!(HISTORY_LINES_MAX, 200_000);
    assert!((HISTORY_LINES_MIN..=HISTORY_LINES_MAX).contains(&HISTORY_LINES_DEFAULT));
}

#[test]
fn emu_keep_by_rows() {
    assert_eq!(emu_keep(24), 464);
    assert_eq!(emu_keep(40), 448);
    assert_eq!(emu_keep(50), 438);
}

#[test]
fn emu_keep_floors_at_min() {
    let edge = (ALAC_STORAGE_UNIT - 2 * FEED_SLACK - EMU_KEEP_MIN) as u16;
    assert_eq!(edge, 424);
    assert_eq!(emu_keep(edge), EMU_KEEP_MIN);
    assert_eq!(emu_keep(edge + 1), EMU_KEEP_MIN);
    assert_eq!(emu_keep(u16::MAX), EMU_KEEP_MIN);
}

/// 행 수가 424 이하면 상한이 저장 단위 하나에 든다. 넘으면 두 단위를 쓴다(설계 §2).
#[test]
fn emu_cap_fits_one_storage_unit_up_to_424_rows() {
    for rows in [1u16, 24, 40, 50, 424] {
        assert_eq!(
            emu_cap(emu_keep(rows), rows),
            ALAC_STORAGE_UNIT,
            "rows={rows}"
        );
    }
    assert!(emu_cap(emu_keep(425), 425) > ALAC_STORAGE_UNIT);
    assert_eq!(
        emu_cap(emu_keep(425), 425),
        EMU_KEEP_MIN + 2 * FEED_SLACK + 425
    );
}

#[test]
fn emu_cap_never_below_storage_unit() {
    assert_eq!(emu_cap(0, 1), ALAC_STORAGE_UNIT);
    assert_eq!(emu_cap(1_000, 40), 1_000 + 2 * FEED_SLACK + 40);
}

#[test]
fn const_fns_are_const() {
    const K: usize = emu_keep(40);
    const C: usize = emu_cap(K, 40);
    assert_eq!((K, C), (448, ALAC_STORAGE_UNIT));
}
