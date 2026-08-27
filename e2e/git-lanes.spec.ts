import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M4_STEP1417_CONTRACT §2 — 레인 알고리즘.
// 검증 V115~V120 (FR-GIT-117~121·228~231). V46 은 V117 이 대체한다.
//
// 이 저장소에 JS 단위 테스트 러너가 없으므로 web/js/git/lanes.js 를 빈 페이지에
// 넣고 page.evaluate 로 순수 함수만 시험한다. DOM 도 앱도 띄우지 않으므로 사실상
// 단위 테스트다.
//
// 4차 검토(E2)로 **계약이 넓어졌다** (GIT_REVIEW4_SRS D10). 열은 빈 자리 없이
// 왼쪽부터 매기고, 세그먼트는 위·아래 끝의 열을 따로 갖고, 색은 열이 아니라 갈래에
// 붙는다. 기대값은 그 계약으로 옮겼다 — 단정을 줄이지 않았다.

interface LaneCommit {
  hash: string;
  parents: string[];
}

interface Seg { top: number; bottom: number; color: number }
interface Par { col: number; color: number }

interface LaneRow {
  hash: string;
  lane: number;
  color: number;
  passThrough: Seg[];
  parentLanes: Par[];
  isNewHead: boolean;
  laneCount: number;
  compressed?: boolean;
}

interface LaneGraph {
  rows: LaneRow[];
  maxLanes: number;
}

// lanes.js 는 <script> 로 로드되는 전역 스크립트다 — import 대상이 아니다.
declare function buildLaneGraph(commits: LaneCommit[]): LaneGraph;
declare function clampLanes(graph: LaneGraph, max: number): LaneGraph;

const LANES_JS = join(process.cwd(), 'web', 'js', 'git', 'lanes.js');

// 앱을 띄우지 않는다. about:blank 에 파일 하나만 넣는다.
async function loadLanes(page: Page) {
  await page.setContent('<!doctype html><title>git-lanes</title>');
  await page.addScriptTag({ path: LANES_JS });
}

const c = (hash: string, ...parents: string[]): LaneCommit => ({ hash, parents });

const build = (page: Page, commits: LaneCommit[]) =>
  page.evaluate((cs: LaneCommit[]) => buildLaneGraph(cs), commits);

const clamp = (page: Page, commits: LaneCommit[], max: number) =>
  page.evaluate(
    ([cs, m]: [LaneCommit[], number]) => clampLanes(buildLaneGraph(cs), m),
    [commits, max] as [LaneCommit[], number],
  );

const seg = (top: number, bottom: number, color: number): Seg => ({ top, bottom, color });
const par = (col: number, color: number): Par => ({ col, color });

const row = (
  hash: string,
  lane: number,
  color: number,
  passThrough: Seg[],
  parentLanes: Par[],
  isNewHead: boolean,
  laneCount: number,
): LaneRow => ({ hash, lane, color, passThrough, parentLanes, isNewHead, laneCount });

const crow = (r: LaneRow, compressed: boolean): LaneRow => ({ ...r, compressed });

// 행의 아래 끝 열 집합과 위 끝 열 집합. 선의 연속성은 이 둘로 판정한다
// (FR-GIT-229). 새 머리의 점은 위쪽 진입선을 갖지 않으므로 위 끝이 아니다.
const bottomEnds = (r: LaneRow) =>
  [...new Set([...r.passThrough.map(s => s.bottom), ...r.parentLanes.map(p => p.col)])].sort((a, b) => a - b);
const topEnds = (r: LaneRow) =>
  [...new Set([...r.passThrough.map(s => s.top), ...(r.isNewHead ? [] : [r.lane])])].sort((a, b) => a - b);

/**
 * 모든 행에서 열이 촘촘한지 (빈 열이 없는지) 본다 — E2 의 직접 판정이다.
 *
 * 판정은 **위 끝**으로 한다. 위 끝의 열 집합은 T(i) 와 정확히 같다: 한 행에서 죽는
 * 갈래는 그 행의 커밋 레인뿐이고, 그 열은 점이 차지하므로 나머지는 전부 통과선이다.
 *
 * 아래 끝으로 판정하면 안 된다 — 다음 행의 **새 머리**가 T(i+1) 의 열 하나를
 * 차지하지만 위에서 내려오는 선이 없다. 그 자리는 비어 보이는 것이 맞다.
 */
function densityGaps(g: LaneGraph): string[] {
  const bad: string[] = [];
  for (const r of g.rows) {
    const top = new Set<number>([r.lane, ...r.passThrough.map(s => s.top)]);
    const max = Math.max(...top);
    for (let i = 0; i < max; i++) if (!top.has(i)) bad.push(`${r.hash} 열 ${i} 이 비었다`);
  }
  return bad;
}

test.describe('레인 알고리즘 — 위상과 배치 (V115~V120)', () => {
  test.beforeEach(async ({ page }) => {
    await loadLanes(page);
  });

  test('L1 (V117): 선형 (A→B→C) — 전부 열 0, 통과 없음, A 만 isNewHead', async ({ page }) => {
    const g = await build(page, [c('A', 'B'), c('B', 'C'), c('C')]);
    expect(g.rows).toEqual([
      row('A', 0, 0, [], [par(0, 0)], true, 1),
      row('B', 0, 0, [], [par(0, 0)], false, 1),
      row('C', 0, 0, [], [], false, 1),
    ]);
    expect(g.maxLanes).toBe(1);
    expect(g.rows.every(r => r.passThrough.length === 0)).toBe(true);
    expect(g.rows.filter(r => r.isNewHead).map(r => r.hash)).toEqual(['A']);
  });

  test('L2 (V117): 분기 (A,B 가 같은 부모 C)', async ({ page }) => {
    const g = await build(page, [c('A', 'C'), c('B', 'C'), c('C')]);
    expect(g.rows).toEqual([
      row('A', 0, 0, [], [par(0, 0)], true, 2),
      row('B', 1, 1, [seg(0, 0, 0)], [par(0, 1)], true, 2),
      row('C', 0, 0, [], [], false, 1),
    ]);
    expect(g.maxLanes).toBe(2);
    // C 는 이미 A 의 갈래에 있으므로 B 는 그 점으로 **붙는다** — 새 갈래를 만들지
    // 않는다. 붙는 선은 B 자신의 색이다 (Git Graph 가 그 선을 B 의 갈래에 담는다).
    expect(g.rows[1].parentLanes).toEqual([par(0, 1)]);
  });

  test('L3 (V117): 머지 (M 의 부모 2개)', async ({ page }) => {
    const g = await build(page, [c('M', 'P1', 'P2'), c('P1'), c('P2')]);
    expect(g.rows).toEqual([
      row('M', 0, 0, [], [par(0, 0), par(1, 1)], true, 2),
      row('P1', 0, 0, [seg(1, 0, 1)], [], false, 2),
      row('P2', 0, 1, [], [], false, 1),
    ]);
    expect(g.maxLanes).toBe(2);
    // P1 이 끝나면 P2 의 갈래가 열 0 으로 당겨진다 — 빈 열을 남기지 않는다.
    expect(g.rows[2].lane).toBe(0);
    // 색은 갈래에 붙으므로 P2 는 열이 1→0 으로 바뀌어도 색 키 1 이다.
    expect(g.rows[2].color).toBe(1);
  });

  test('L4 (V117): 옥토퍼스 (부모 4개) — 서로 다른 열, 끝나면 왼쪽으로 당겨진다', async ({ page }) => {
    const g = await build(page, [
      c('O', 'P1', 'P2', 'P3', 'P4'), c('P1'), c('P2'), c('P3'), c('P4'),
    ]);
    const pl = g.rows[0].parentLanes;
    expect(pl).toHaveLength(4);
    expect(new Set(pl.map(p => p.col)).size).toBe(4);
    expect(pl).toEqual([par(0, 0), par(1, 1), par(2, 2), par(3, 3)]);
    expect(g.maxLanes).toBe(4);
    expect(g.rows).toEqual([
      row('O', 0, 0, [], [par(0, 0), par(1, 1), par(2, 2), par(3, 3)], true, 4),
      row('P1', 0, 0, [seg(1, 0, 1), seg(2, 1, 2), seg(3, 2, 3)], [], false, 4),
      row('P2', 0, 1, [seg(1, 0, 2), seg(2, 1, 3)], [], false, 3),
      row('P3', 0, 2, [seg(1, 0, 3)], [], false, 2),
      row('P4', 0, 3, [], [], false, 1),
    ]);
    // 갈래가 끝날 때마다 나머지가 왼쪽으로 당겨진다.
    expect(g.rows.map(r => r.lane)).toEqual([0, 0, 0, 0, 0]);
    expect(densityGaps(g)).toEqual([]);
  });

  test('L5 (V115 / FR-GIT-228): 가운데 갈래가 끝나면 오른쪽 갈래가 왼쪽으로 당겨진다', async ({ page }) => {
    // E2 의 재현 모양이다. 압축이 없으면 B 가 비운 열 1 이 영구히 남고 C 가 열 2 에
    // 혼자 떨어져 보였다.
    const g = await build(page, [
      c('A1', 'A2'), c('B1', 'B2'), c('C1', 'C2'),
      c('B2'), c('A2', 'A3'), c('C2', 'C3'), c('A3'), c('C3'),
    ]);
    expect(g.rows.map(r => `${r.hash}:${r.lane}`)).toEqual([
      'A1:0', 'B1:1', 'C1:2', 'B2:1', 'A2:0', 'C2:1', 'A3:0', 'C3:0',
    ]);
    // B 가 끝난 뒤 C 는 열 1 이다 — 열 2 에 남지 않는다.
    expect(g.rows[5].lane).toBe(1);
    // 색 키는 갈래를 따른다 — C 는 열이 2→1→0 으로 바뀌어도 늘 2 다.
    expect(g.rows.filter(r => r.hash.startsWith('C')).map(r => r.color)).toEqual([2, 2, 2]);
    // 빈 열이 없다.
    expect(densityGaps(g)).toEqual([]);
  });

  test('L6 (V116 / FR-GIT-229): 선이 행 경계에서 끊기지 않는다', async ({ page }) => {
    const shapes: LaneCommit[][] = [
      [c('A', 'B'), c('B', 'C'), c('C')],
      [c('A', 'C'), c('B', 'C'), c('C')],
      [c('M', 'P1', 'P2'), c('P1'), c('P2')],
      [c('O', 'P1', 'P2', 'P3', 'P4'), c('P1'), c('P2'), c('P3'), c('P4')],
      [c('A1', 'A2'), c('B1', 'B2'), c('C1', 'C2'), c('B2'), c('A2', 'A3'), c('C2', 'C3'), c('A3'), c('C3')],
      [c('A', 'M'), c('B', 'C'), c('M', 'C', 'D'), c('C'), c('D')],
      [c('R1'), c('R2')],
    ];
    for (const cs of shapes) {
      const g = await build(page, cs);
      for (let i = 0; i + 1 < g.rows.length; i++) {
        expect(bottomEnds(g.rows[i]), `${cs.map(x => x.hash).join(',')} 행 ${i}`)
          .toEqual(topEnds(g.rows[i + 1]));
      }
      expect(densityGaps(g), cs.map(x => x.hash).join(',')).toEqual([]);
    }
  });

  test('L7 (V116): 무작위 DAG 200개에서도 경계가 맞고 열이 촘촘하다', async ({ page }) => {
    const bad = await page.evaluate(() => {
      // 결정론적 난수 — 실패를 재현할 수 있어야 한다.
      let s = 12345;
      const rnd = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n };
      const out: string[] = [];
      for (let t = 0; t < 200; t++) {
        const n = 4 + rnd(14);
        // 위상순: i 의 부모는 i 보다 뒤에 있는 커밋에서만 고른다.
        const commits: { hash: string; parents: string[] }[] = [];
        for (let i = 0; i < n; i++) {
          const parents: string[] = [];
          const room = n - i - 1;
          const k = room === 0 ? 0 : rnd(3);
          const picked = new Set<number>();
          for (let j = 0; j < k; j++) {
            const p = i + 1 + rnd(room);
            if (!picked.has(p)) { picked.add(p); parents.push('c' + p) }
          }
          commits.push({ hash: 'c' + i, parents });
        }
        const g = buildLaneGraph(commits);
        for (let i = 0; i + 1 < g.rows.length; i++) {
          const a = g.rows[i], b = g.rows[i + 1];
          const be = [...new Set([...a.passThrough.map((x: any) => x.bottom), ...a.parentLanes.map((x: any) => x.col)])].sort((x, y) => x - y);
          const te = [...new Set([...b.passThrough.map((x: any) => x.top), ...(b.isNewHead ? [] : [b.lane])])].sort((x, y) => x - y);
          if (JSON.stringify(be) !== JSON.stringify(te))
            out.push('t' + t + ' 행 ' + i + ' bottom=' + JSON.stringify(be) + ' top=' + JSON.stringify(te));
        }
        for (const r of g.rows) {
          // 위 끝만 본다 — 아래 끝은 다음 행의 새 머리 열을 포함한다 (densityGaps 주석).
          const top = new Set<number>([r.lane, ...r.passThrough.map((x: any) => x.top)]);
          const mx = Math.max(...top);
          for (let i = 0; i < mx; i++) if (!top.has(i)) out.push('t' + t + ' ' + r.hash + ' 빈 열 ' + i);
        }
        if (out.length > 8) return out;
      }
      return out;
    });
    expect(bad).toEqual([]);
  });

  test('L8 (V118 / FR-GIT-230): 갈래의 색 키는 살아 있는 동안 하나다', async ({ page }) => {
    // C 갈래는 열을 2→1→0 으로 옮기지만 색 키는 바뀌지 않는다.
    const g = await build(page, [
      c('A1', 'A2'), c('B1', 'B2'), c('C1', 'C2'),
      c('B2'), c('A2', 'A3'), c('C2', 'C3'), c('A3'), c('C3'),
    ]);
    // 각 갈래(색 키)가 놓인 열의 집합 — 여러 열에 놓였어도 색 키는 하나다.
    const cols = new Map<number, Set<number>>();
    for (const r of g.rows) {
      if (!cols.has(r.color)) cols.set(r.color, new Set());
      cols.get(r.color)!.add(r.lane);
    }
    expect(cols.get(2)!.size).toBeGreaterThan(1);
    // 색 키는 희소 레인이므로 열보다 크거나 같을 수 있다 — 겹치지 않는다는 것이 요점이다.
    expect([...new Set(g.rows.map(r => r.color))].sort()).toEqual([0, 1, 2]);
  });

  test('L9 (V120 / FR-GIT-231): 상한 접기는 압축된 열에 적용된다', async ({ page }) => {
    const commits = [
      c('Z', 'O'), c('O', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5'),
      c('P0'), c('P1'), c('P2'), c('P3'), c('P4'), c('P5'),
    ];
    const g = await build(page, commits);
    expect(g.maxLanes).toBe(6);
    expect(g.rows[1].parentLanes.map(p => p.col)).toEqual([0, 1, 2, 3, 4, 5]);

    const cl = await clamp(page, commits, 3);
    expect(cl.maxLanes).toBe(3);
    // 접힌 뒤 어떤 열도 상한을 넘지 않는다.
    for (const r of cl.rows) {
      expect(r.lane).toBeLessThan(3);
      expect(r.passThrough.every(s => s.top < 3 && s.bottom < 3)).toBe(true);
      expect(r.parentLanes.every(p => p.col < 3)).toBe(true);
    }
    // 같은 자리를 두 번 그리면 선이 겹쳐 굵어 보인다 — 중복 없이 오름차순이다.
    for (const r of cl.rows) {
      const keys = r.passThrough.map(s => s.top + ':' + s.bottom);
      expect(new Set(keys).size).toBe(keys.length);
      expect(r.passThrough.every((s, i) => i === 0 || r.passThrough[i - 1].top <= s.top)).toBe(true);
      const cols = r.parentLanes.map(p => p.col);
      expect(new Set(cols).size).toBe(cols.length);
      expect(cols.every((v, i) => i === 0 || cols[i - 1] < v)).toBe(true);
    }
    // 접힘이 없는 행에는 표식을 세우지 않는다.
    // 압축이 열을 줄이므로 접힘이 일어나는 행은 압축 전보다 **줄어든다** —
    // P4·P5 는 그때 이미 상한 안이다 (FR-GIT-231 의 마지막 문장).
    expect(cl.rows.filter(r => r.compressed).map(r => r.hash))
      .toEqual(['O', 'P0', 'P1', 'P2']);
  });

  test('L10 (V120): clampLanes 는 원본을 고치지 않고, 두 번 접어도 같다', async ({ page }) => {
    const commits = [
      c('Z', 'O'), c('O', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5'),
      c('P0'), c('P1'), c('P2'), c('P3'), c('P4'), c('P5'),
    ];
    const r = await page.evaluate((cs: LaneCommit[]) => {
      const g = buildLaneGraph(cs);
      const before = JSON.stringify(g);
      const once = clampLanes(g, 3);
      return {
        before,
        after: JSON.stringify(g),
        once: JSON.stringify(once),
        twice: JSON.stringify(clampLanes(once, 3)),
        loose: clampLanes(g, 6),
      };
    }, commits);
    expect(r.after).toBe(r.before);
    expect(r.twice).toBe(r.once);
    // 상한이 실제 열 수 이상이면 아무 행도 압축되지 않는다.
    expect(r.loose.rows.some(x => x.compressed)).toBe(false);
    expect(r.loose.maxLanes).toBe(6);
  });

  test('L13 (V128 / FR-GIT-234): 새 머리가 빈 슬롯을 물려받아도 오래된 갈래가 오른쪽으로 밀리지 않는다', async ({ page }) => {
    // main(슬롯 0)이 먼저 끝나 슬롯 0 이 빈다. featX(슬롯 1)가 살아 있는 동안 새 머리
    // n1 이 그 슬롯을 물려받는다. 열을 **슬롯 번호**로 정하면 그 순간 featX 가 열
    // 0 → 1 로 밀린다 — 선이 자기 일 없이 오른쪽으로 움직이는 것이다.
    const g = await build(page, [
      c('m1', 'm2'), c('x1', 'x2'), c('m2'), c('x2', 'x3'), c('n1', 'n2'), c('x3'), c('n2'),
    ]);
    const at = (h: string) => g.rows.find(r => r.hash === h)!;
    // featX 는 main 이 끝난 뒤 열 0 으로 당겨지고, 새 머리가 와도 그대로 0 이다.
    expect(at('x2').lane).toBe(0);
    expect(at('x3').lane).toBe(0);
    // 새 머리는 살아 있는 갈래 중 가장 어리므로 그 행의 가장 오른쪽 열을 받는다.
    expect(at('n1').lane).toBe(1);
    // 통과 세그먼트가 오른쪽으로 가지 않는다.
    for (const r of g.rows)
      for (const sg of r.passThrough)
        expect(sg.bottom, r.hash + ' 의 통과선이 오른쪽으로 휘었다').toBeLessThanOrEqual(sg.top);
  });

  test('L14 (V129 / FR-GIT-234): 통과선은 왼쪽으로만 움직인다', async ({ page }) => {
    const bad = await page.evaluate(() => {
      let s = 987654;
      const rnd = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n };
      const out: string[] = [];
      for (let t = 0; t < 200; t++) {
        const n = 4 + rnd(16);
        const commits: { hash: string; parents: string[] }[] = [];
        for (let i = 0; i < n; i++) {
          const parents: string[] = [];
          const room = n - i - 1;
          const k = room === 0 ? 0 : rnd(3);
          const picked = new Set<number>();
          for (let j = 0; j < k; j++) {
            const p = i + 1 + rnd(room);
            if (!picked.has(p)) { picked.add(p); parents.push('c' + p) }
          }
          commits.push({ hash: 'c' + i, parents });
        }
        const g = buildLaneGraph(commits);
        for (const r of g.rows) {
          for (const sg of r.passThrough) {
            // 오른쪽으로 가지 않는다 — 자기 일이 없는 선이 오른쪽으로 갈 이유가 없다.
            // 왼쪽으로 몇 칸을 가는지는 제한하지 않는다: 한 행에서 여러 갈래가 함께
            // 끝날 수 있고, 그러면 오른쪽 선이 그만큼 당겨진다 (git 의 `|/ /`).
            if (sg.bottom > sg.top) out.push('t' + t + ' ' + r.hash + ' 오른쪽 ' + sg.top + '->' + sg.bottom);
          }
        }
        if (out.length > 8) return out;
      }
      return out;
    });
    expect(bad).toEqual([]);
  });

  test('L15 (V131 / FR-GIT-235): 부모가 없는 커밋 아래로 선이 늘어지지 않는다', async ({ page }) => {
    // `--all` 에서 뿌리가 중간에 올 수 있다 (연결되지 않은 두 DAG). 그때 뿌리
    // 아래로 아무 데도 닿지 않는 선이 늘어져서는 안 된다.
    const g = await build(page, [c('R1'), c('B1', 'B2'), c('B2')]);
    const at = (h: string) => g.rows.find(r => r.hash === h)!;
    expect(at('R1').parentLanes).toEqual([]);
    // R1 이 갈래를 놓았으므로 B1 은 그 열을 쓴다.
    expect(at('R1').lane).toBe(0);
    expect(at('B1').lane).toBe(0);
    // R1 아래 행(B1)에 R1 에서 내려온 통과선이 없다.
    expect(at('B1').passThrough).toEqual([]);
    expect(g.maxLanes).toBe(1);
  });

  test('L11 (V117): 루트 커밋 (부모 0개) — parentLanes 비었고 갈래가 해제된다', async ({ page }) => {
    const g = await build(page, [c('R1'), c('R2')]);
    expect(g.rows).toEqual([
      row('R1', 0, 0, [], [], true, 1),
      row('R2', 0, 0, [], [], true, 1),
    ]);
    expect(g.maxLanes).toBe(1);
    // R1 이 해제한 갈래 0 을 R2 가 다시 쓴다 — 해제되지 않으면 열 1 이 된다.
    expect(g.rows[1].lane).toBe(0);
  });

  test('L12 (V117 / FR-GIT-121): 브랜치 머리만 위쪽 진입선을 갖지 않는다', async ({ page }) => {
    const commits = [c('A', 'M'), c('B', 'C'), c('M', 'C', 'D'), c('C'), c('D')];
    const g = await build(page, commits);
    expect(g.rows.filter(r => r.isNewHead).map(r => r.hash)).toEqual(['A', 'B']);

    // isNewHead=false ⟺ **바로 위 행에서 내려온 선이 이 점의 열에 닿는다**
    // (FR-GIT-121). 점의 열은 그 행에서 점 자신이 집은 것이므로, 닿는 선이 있다는
    // 것과 어떤 자식이 이 커밋을 예약했다는 것이 같은 뜻이다.
    const arrives = (i: number) => {
      if (i === 0) return false;
      const p = g.rows[i - 1];
      const col = g.rows[i].lane;
      return p.passThrough.some(sg => sg.bottom === col) || p.parentLanes.some(x => x.col === col);
    };
    expect(g.rows.every((r, i) => r.isNewHead === !arrives(i))).toBe(true);

    // R3: 갈래는 first-parent 사슬을 끝까지 잡는다 — A→M→C 가 한 색이다.
    expect(g.rows[0].color).toBe(g.rows[2].color);
    expect(g.rows[2].color).toBe(g.rows[3].color);
    // B 의 선은 그 트렁크로 **붙는다** — 트렁크의 색을 빼앗지 않는다.
    expect(g.rows[1].color).not.toBe(g.rows[0].color);
  });
});
