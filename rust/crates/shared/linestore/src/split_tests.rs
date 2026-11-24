use super::*;

fn rows_bound(piece: &[u8], cols: usize) -> usize {
    piece.iter().filter(|b| NEWLINES.contains(b)).count() + piece.len() / cols + 1
}

fn check(chunk: &[u8], cols: usize, max_rows: usize) -> Vec<&[u8]> {
    let pieces = split_for_rows(chunk, cols, max_rows);
    assert_eq!(pieces.concat(), chunk, "이어 붙이면 원래 청크");
    for p in &pieces {
        assert!(!p.is_empty());
        assert!(
            rows_bound(p, cols) <= max_rows,
            "조각 {} 바이트가 상한을 넘는다",
            p.len()
        );
    }
    pieces
}

#[test]
fn one_64k_chunk_of_thousands_of_lines_is_split_under_the_budget() {
    let mut chunk = Vec::new();
    let mut n = 0;
    while chunk.len() < 64 * 1024 {
        chunk.extend_from_slice(format!("{n}\r\n").as_bytes());
        n += 1;
    }
    assert!(n > 5000);
    let pieces = check(&chunk, 120, 500);
    assert!(pieces.len() >= n / 500, "줄바꿈이 많으면 조각이 늘어난다");
}

#[test]
fn a_long_line_without_newlines_is_split_by_wrap_rows() {
    let chunk = vec![b'x'; 64 * 1024];
    let pieces = check(&chunk, 80, 100);
    assert!(pieces.len() >= 64 * 1024 / 80 / 100);
}

#[test]
fn vt_and_ff_count_as_newlines() {
    let chunk = [0x0b, 0x0c, b'\n', 0x0b, 0x0c, b'\n'];
    let pieces = check(&chunk, 80, 3);
    assert_eq!(pieces.len(), 3);
}

#[test]
fn small_chunk_stays_whole_and_empty_chunk_has_no_pieces() {
    assert_eq!(split_for_rows(b"ab\ncd", 80, 1000), vec![&b"ab\ncd"[..]]);
    assert!(split_for_rows(b"", 80, 1000).is_empty());
}

#[test]
fn degenerate_budget_still_makes_progress() {
    let chunk = b"\n\n\n\n";
    let pieces = split_for_rows(chunk, 0, 0);
    assert_eq!(pieces.concat(), chunk);
    assert_eq!(pieces.len(), 4);
}
