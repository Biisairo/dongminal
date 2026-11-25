//! 데몬 터미널의 메모리 예산 상수 (NFR-PRF-10, D-49~D-55, PERF 4.1 `M4_MEMORY_DESIGN.md` §1).
//!
//! 도구 하나가 데몬에서 쓰는 메모리를 정하는 값만 여기 둔다. 동작을 정하는 내부값(읽기 버퍼 크기,
//! 검색 일치 상한 등)은 쓰는 crate 에 둔다.
//!
//! ## 예산 (NFR-PRF-10, 터미널당 평균 8 MB 이하)
//!
//! 도구 하나 = 출력 링 + 에뮬레이터 그리드 + 줄 저장소.
//!
//! - 출력 링: [`OUTPUT_RING_BYTES`] = 1 MiB.
//! - 에뮬레이터: alacritty 그리드는 저장 공간을 [`ALAC_STORAGE_UNIT`] 행 단위로 늘리고 줄인다.
//!   [`emu_cap`] 을 저장 단위 하나 안에 두면 그리드는 화면 + 1,000행이다. 120열에서 행 하나가
//!   약 3 KB 이므로 약 3.1 MB 다(이전 keep 1,000 은 화면 + 2,000행, 약 6.3 MB).
//! - 줄 저장소: [`HISTORY_LINES_DEFAULT`] 2만 줄 × 줄당 deflate 뒤 약 24~131 B = 약 0.5~2.6 MB.
//!
//! 120×40 에서 출력 중 약 4.8~7.0 MB, [`SCREEN_IDLE_COMPACT`] 동안 출력이 없어 기록을 줄 저장소로
//! 옮긴 뒤 약 1.7~3.9 MB 다(설계 §8).

use std::time::Duration;

/// alacritty 그리드 저장 공간이 한 번에 늘리고 줄이는 행 수다(alacritty_terminal 0.26
/// `grid/storage.rs` `MAX_CACHE_SIZE`).
pub const ALAC_STORAGE_UNIT: usize = 1_000;

/// 넣기 조각 하나가 기록으로 밀어 올릴 수 있는 행 수다. 걸친 논리 줄을 기다리는 여유이기도 하다.
pub const FEED_SLACK: usize = 256;

/// 에뮬레이터가 화면 위에 남기는 기록 줄 수의 하한이다(화면이 아주 클 때).
pub const EMU_KEEP_MIN: usize = 64;

/// 화면 `rows` 행일 때 에뮬레이터가 화면 위에 남기는 기록 줄 수다(D-52).
/// [`emu_cap`] 이 저장 단위 하나에 들도록 정하고, [`EMU_KEEP_MIN`] 아래로는 내리지 않는다.
pub const fn emu_keep(rows: u16) -> usize {
    let room = ALAC_STORAGE_UNIT.saturating_sub(2 * FEED_SLACK + rows as usize);
    if room > EMU_KEEP_MIN {
        room
    } else {
        EMU_KEEP_MIN
    }
}

/// 에뮬레이터 기록 상한이다. 조각 나누기가 세지 않는 밀어 올림(화면 한 벌)까지 담는다.
/// 저장 단위 하나보다 작게 잡아도 그리드는 한 단위를 쓰므로 그 아래로는 내리지 않는다.
pub const fn emu_cap(keep: usize, rows: u16) -> usize {
    let cap = keep + 2 * FEED_SLACK + rows as usize;
    if cap > ALAC_STORAGE_UNIT {
        cap
    } else {
        ALAC_STORAGE_UNIT
    }
}

/// 출력이 이만큼 없으면 에뮬레이터 기록을 줄 저장소로 옮기고 그리드 저장 공간을 줄인다(D-50).
pub const SCREEN_IDLE_COMPACT: Duration = Duration::from_secs(5 * 60);

/// 설정 `termHistoryLines` 의 기본값이다(D-51). 웹 설정 서술자의 `def` 와 같은 수다.
pub const HISTORY_LINES_DEFAULT: usize = 20_000;
/// 설정 `termHistoryLines` 의 범위다(D-25). 웹 설정 서술자와 같은 수다.
pub const HISTORY_LINES_MIN: usize = 1_000;
pub const HISTORY_LINES_MAX: usize = 200_000;

/// 줄 저장소 블록 하나의 줄 수다. 버릴 때도 이 단위로 버린다.
pub const STORE_BLOCK_LINES: usize = 256;

/// 도구 출력 링버퍼의 크기다.
pub const OUTPUT_RING_BYTES: usize = 1 << 20;

#[cfg(test)]
mod tests;
