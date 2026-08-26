import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M4_STEP1417_CONTRACT §2 — 15단계 레인 알고리즘. 검증 V46 (FR-GIT-117~121).
//
// 이 저장소에 JS 단위 테스트 러너가 없으므로 web/js/git-lanes.js 를 빈 페이지에
// 넣고 page.evaluate 로 순수 함수만 시험한다. DOM 도 앱도 띄우지 않으므로 사실상
// 단위 테스트다 — 레인 알고리즘은 16단계 UI 보다 먼저 고정한다 (SRS §6).

interface LaneCommit {
  hash: string;
  parents: string[];
}

interface LaneRow {
  hash: string;
  lane: number;
  passThrough: number[];
  parentLanes: number[];
  isNewHead: boolean;
  laneCount: number;
  compressed?: boolean;
}

interface LaneGraph {
  rows: LaneRow[];
  maxLanes: number;
}

// git-lanes.js 는 <script> 로 로드되는 전역 스크립트다 — import 대상이 아니다.
declare function buildLaneGraph(commits: LaneCommit[]): LaneGraph;
declare function clampLanes(graph: LaneGraph, max: number): LaneGraph;

const LANES_JS = join(process.cwd(), 'web', 'js', 'git-lanes.js');

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

const row = (
  hash: string,
  lane: number,
  passThrough: number[],
  parentLanes: number[],
  isNewHead: boolean,
  laneCount: number,
): LaneRow => ({ hash, lane, passThrough, parentLanes, isNewHead, laneCount });

const crow = (r: LaneRow, compressed: boolean): LaneRow => ({ ...r, compressed });

test.describe('15단계 — 레인 알고리즘 (V46)', () => {
  test.beforeEach(async ({ page }) => {
    await loadLanes(page);
  });

  test('L1: 선형 (A→B→C) — 전부 lane 0, passThrough 없음, A 만 isNewHead', async ({ page }) => {
    const g = await build(page, [c('A', 'B'), c('B', 'C'), c('C')]);
    expect(g.rows).toEqual([
      row('A', 0, [], [0], true, 1),
      row('B', 0, [], [0], false, 1),
      row('C', 0, [], [], false, 1),
    ]);
    expect(g.maxLanes).toBe(1);
    expect(g.rows.every(r => r.lane === 0)).toBe(true);
    expect(g.rows.every(r => r.passThrough.length === 0)).toBe(true);
    expect(g.rows.filter(r => r.isNewHead).map(r => r.hash)).toEqual(['A']);
  });

  test('L2: 분기 (A,B 가 같은 부모 C) — A lane 0, B lane 1, C lane 0, B.parentLanes=[0]', async ({ page }) => {
    const g = await build(page, [c('A', 'C'), c('B', 'C'), c('C')]);
    expect(g.rows).toEqual([
      row('A', 0, [], [0], true, 1),
      row('B', 1, [0], [0], true, 2),
      row('C', 0, [], [], false, 1),
    ]);
    expect(g.maxLanes).toBe(2);
    expect(g.rows[0].lane).toBe(0);
    expect(g.rows[1].lane).toBe(1);
    expect(g.rows[2].lane).toBe(0);
    // 부모 C 가 이미 레인 0 에 예약돼 있으므로 B 는 새 레인을 만들지 않는다.
    expect(g.rows[1].parentLanes).toEqual([0]);
  });

  test('L3: 머지 (M 의 부모 2개) — M lane 0, parentLanes=[0,1]', async ({ page }) => {
    const g = await build(page, [c('M', 'P1', 'P2'), c('P1'), c('P2')]);
    expect(g.rows).toEqual([
      row('M', 0, [], [0, 1], true, 2),
      row('P1', 0, [1], [], false, 2),
      row('P2', 1, [], [], false, 2),
    ]);
    expect(g.maxLanes).toBe(2);
    expect(g.rows[0].lane).toBe(0);
    expect(g.rows[0].parentLanes).toEqual([0, 1]);
  });

  test('L4: 옥토퍼스 (부모 4개) — parentLanes 길이 4, 서로 다른 레인', async ({ page }) => {
    const g = await build(page, [
      c('O', 'P1', 'P2', 'P3', 'P4'), c('P1'), c('P2'), c('P3'), c('P4'),
    ]);
    const pl = g.rows[0].parentLanes;
    expect(pl).toHaveLength(4);
    expect(new Set(pl).size).toBe(4);
    expect(pl).toEqual([0, 1, 2, 3]);
    expect(g.maxLanes).toBe(4);
    expect(g.rows).toEqual([
      row('O', 0, [], [0, 1, 2, 3], true, 4),
      row('P1', 0, [1, 2, 3], [], false, 4),
      row('P2', 1, [2, 3], [], false, 4),
      row('P3', 2, [3], [], false, 4),
      row('P4', 3, [], [], false, 4),
    ]);
  });

  test('L5: 교차 — 비었던 레인이 재사용되고 passThrough 가 정확하다', async ({ page }) => {
    // B2(루트)가 레인 1 을 비우고, 다음 머리 D 가 그 자리를 다시 쓴다.
    const g = await build(page, [
      c('A', 'A2'), c('B', 'B2'), c('A2', 'A3'), c('B2'), c('D', 'D2'), c('A3'), c('D2'),
    ]);
    expect(g.rows).toEqual([
      row('A', 0, [], [0], true, 1),
      row('B', 1, [0], [1], true, 2),
      row('A2', 0, [1], [0], false, 2),
      row('B2', 1, [0], [], false, 2),
      row('D', 1, [0], [1], true, 2),
      row('A3', 0, [1], [], false, 2),
      row('D2', 1, [], [], false, 2),
    ]);
    // 레인이 재사용되므로 폭은 2 를 넘지 않는다.
    expect(g.maxLanes).toBe(2);
    expect(g.rows[4].lane).toBe(1);
  });

  test('L6: 상한 초과 — clampLanes(g,3) 이 lane>=3 을 접고 compressed 를 세운다', async ({ page }) => {
    const commits = [
      c('Z', 'O'), c('O', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5'),
      c('P0'), c('P1'), c('P2'), c('P3'), c('P4'), c('P5'),
    ];
    const g = await build(page, commits);
    expect(g.maxLanes).toBe(6);
    expect(g.rows[1].parentLanes).toEqual([0, 1, 2, 3, 4, 5]);

    const cl = await clamp(page, commits, 3);
    expect(cl.maxLanes).toBe(3);
    expect(cl.rows).toEqual([
      crow(row('Z', 0, [], [0], true, 1), false),
      crow(row('O', 0, [], [0, 1, 2], false, 3), true),
      crow(row('P0', 0, [1, 2], [], false, 3), true),
      crow(row('P1', 1, [2], [], false, 3), true),
      crow(row('P2', 2, [2], [], false, 3), true),
      crow(row('P3', 2, [2], [], false, 3), true),
      crow(row('P4', 2, [2], [], false, 3), true),
      crow(row('P5', 2, [], [], false, 3), true),
    ]);
    // 접힌 뒤 어떤 인덱스도 상한을 넘지 않는다.
    for (const r of cl.rows) {
      expect(r.lane).toBeLessThan(3);
      expect(r.passThrough.every(i => i < 3)).toBe(true);
      expect(r.parentLanes.every(i => i < 3)).toBe(true);
    }
    // 같은 인덱스를 두 번 그리면 선이 겹쳐 굵어 보인다 — 중복 없이 오름차순이다.
    const asc = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1] < v);
    for (const r of cl.rows) {
      expect(asc(r.passThrough)).toBe(true);
      expect(asc(r.parentLanes)).toBe(true);
    }
    // 접힘이 없는 행에는 표식을 세우지 않는다.
    expect(cl.rows.filter(r => r.compressed).map(r => r.hash))
      .toEqual(['O', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5']);
  });

  test('L6: clampLanes 는 원본 그래프를 고치지 않고, 두 번 접어도 같다', async ({ page }) => {
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
    // 상한이 실제 레인 수 이상이면 아무 행도 압축되지 않는다.
    expect(r.loose.rows.some(x => x.compressed)).toBe(false);
    expect(r.loose.maxLanes).toBe(6);
  });

  test('L7: 루트 커밋 (부모 0개) — parentLanes 비었고 레인이 해제된다', async ({ page }) => {
    const g = await build(page, [c('R1'), c('R2')]);
    expect(g.rows).toEqual([
      row('R1', 0, [], [], true, 1),
      row('R2', 0, [], [], true, 1),
    ]);
    expect(g.maxLanes).toBe(1);
    expect(g.rows[0].parentLanes).toEqual([]);
    // R1 이 해제한 레인 0 을 R2 가 다시 쓴다 — 해제되지 않으면 lane 1 이 된다.
    expect(g.rows[1].lane).toBe(0);
  });

  test('L8: 브랜치 머리 — isNewHead 가 참인 행만 위쪽 진입선을 갖지 않는다', async ({ page }) => {
    const commits = [c('A', 'M'), c('B', 'C'), c('M', 'C', 'D'), c('C'), c('D')];
    const g = await build(page, commits);
    expect(g.rows).toEqual([
      row('A', 0, [], [0], true, 1),
      row('B', 1, [0], [1], true, 2),
      row('M', 0, [1], [1, 0], false, 2),
      row('C', 1, [0], [], false, 2),
      row('D', 0, [], [], false, 1),
    ]);
    expect(g.rows.filter(r => r.isNewHead).map(r => r.hash)).toEqual(['A', 'B']);

    // isNewHead=false ⟺ 앞선 행이 이 해시를 그 레인에 예약했다 (FR-GIT-121).
    const reserved = (r: LaneRow, i: number) =>
      g.rows.slice(0, i).some((p, j) =>
        commits[j].parents.some((h, k) => h === r.hash && p.parentLanes[k] === r.lane));
    expect(g.rows.every((r, i) => r.isNewHead !== reserved(r, i))).toBe(true);

    // 머지 M 의 첫 부모 C 는 이미 레인 1 에 예약돼 있어 M 의 레인을 물려받지 않는다.
    expect(g.rows[2].parentLanes[0]).toBe(1);
  });
});
