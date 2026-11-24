//! 에뮬레이터 기록 행 ↔ 줄 저장소의 논리 줄 (D-14·D-28).

use otter_shared_linestore::{
    Color as LColor, Line, LineBuilder, LineStore, Link as LLink, Style, flags,
};

use crate::{Attrs, Color, Row};

fn color(c: Color) -> LColor {
    match c {
        Color::Default => LColor::Default,
        Color::Indexed(i) => LColor::Indexed(i),
        Color::Rgb(r, g, b) => LColor::Rgb(r, g, b),
    }
}

const FLAGS: [(Attrs, u16); 11] = [
    (Attrs::BOLD, flags::BOLD),
    (Attrs::DIM, flags::DIM),
    (Attrs::ITALIC, flags::ITALIC),
    (Attrs::UNDERLINE, flags::UNDERLINE),
    (Attrs::DOUBLE_UNDERLINE, flags::DOUBLE_UNDERLINE),
    (Attrs::UNDERCURL, flags::UNDERCURL),
    (Attrs::DOTTED_UNDERLINE, flags::DOTTED_UNDERLINE),
    (Attrs::DASHED_UNDERLINE, flags::DASHED_UNDERLINE),
    (Attrs::INVERSE, flags::INVERSE),
    (Attrs::HIDDEN, flags::HIDDEN),
    (Attrs::STRIKE, flags::STRIKEOUT),
];

fn push_row(b: &mut LineBuilder, row: &Row) {
    for c in row.cells.iter().filter(|c| c.width != 0) {
        let style = Style {
            fg: color(c.fg),
            bg: color(c.bg),
            underline: color(c.underline),
            flags: FLAGS
                .iter()
                .filter(|(a, _)| c.attrs.contains(*a))
                .fold(0, |f, (_, v)| f | v),
        };
        let link = c.link.as_ref().map(|l| LLink {
            id: l.id.clone(),
            uri: l.uri.clone(),
        });
        b.push(&c.text, c.width, style, link.as_ref());
    }
}

/// 오래된 행부터 `limit` 행 안에서 끝나는 논리 줄을 모은다. 옮긴 행 수를 함께 준다.
/// `cut` 이면 `limit` 안에서 끝나지 않는 줄도 `limit` 행까지 끊어 옮긴다.
pub(crate) fn complete_lines(rows: &[Row], limit: usize, cut: bool) -> (Vec<Line>, usize) {
    let mut out = Vec::new();
    let mut moved = 0;
    let mut b = LineBuilder::new();
    for (i, row) in rows.iter().enumerate().take(limit) {
        push_row(&mut b, row);
        if !row.wrapped {
            out.push(std::mem::take(&mut b).finish());
            moved = i + 1;
        }
    }
    if cut && moved < limit.min(rows.len()) {
        out.push(b.finish());
        moved = limit.min(rows.len());
    }
    (out, moved)
}

/// 저장소에서 새 줄부터 거슬러 지금 폭 `cols` 로 `rows` 행쯤 되는 줄을 꺼낸다(오래된 것부터).
/// 첫 줄의 번호를 함께 준다. 꺼낼 것이 없으면 그 번호는 저장소 끝 번호다.
pub(crate) fn newest_rows(store: &LineStore, rows: usize, cols: usize) -> (u64, Vec<Line>) {
    let cols = cols.max(1);
    let want = rows.min(store.len());
    let (first, lines) = store.lines(store.end() - want as u64, want);
    let mut used = 0;
    let keep = lines
        .iter()
        .rev()
        .take_while(|l| {
            used += l.columns().div_ceil(cols).max(1);
            used <= rows
        })
        .count();
    let skip = lines.len() - keep;
    (first + skip as u64, lines.into_iter().skip(skip).collect())
}
