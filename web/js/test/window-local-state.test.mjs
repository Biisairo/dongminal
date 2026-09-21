import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * UX_BATCH10_SRS 묶음 W (FR-UXB-1~12).
 *
 * **창의 치수는 창 밖으로 새지 않는다.**
 *
 * 세 값(슬롯 방향·사이드바 폭·탐색기 폭)이 각각 다른 곳에 살면서 같은 증상을
 * 냈다 — 한 창에서 끈 것이 다른 창에 나타난다. 방향은 `localStorage`(같은
 * 브라우저의 모든 창이 공유)였고, 폭 둘은 **워크스페이스**(서버, 모든 기기가
 * 공유)였다.
 *
 * 재는 것은 "지금 어떤 값인가" 가 아니라 **"어느 저장소에 닿는가"** 다. 값은
 * e2e 가 재고, 저장소는 여기서 재야 한다 — 저장소를 되돌리는 한 줄은 화면을
 * 보지 않고도 들어올 수 있고, 그때 증상은 창을 둘 열기 전까지 보이지 않는다.
 */

const JS_ROOT = new URL('../', import.meta.url).pathname;
const WEB_ROOT = new URL('../../', import.meta.url).pathname;

function jsFiles() {
  const out = [];
  for (const dir of ['core', 'ui', 'git']) {
    for (const f of readdirSync(join(JS_ROOT, dir))) {
      if (f.endsWith('.js')) out.push(dir + '/' + f);
    }
  }
  return out;
}

const read = (rel) => readFileSync(join(JS_ROOT, rel), 'utf8');

/** 주석은 저장소에 닿지 않는다 — 규약을 설명하는 문장이 검사를 깨지 않아야 한다. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('워크스페이스가 두 폭을 들지 않는다 (FR-UXB-6·7·8)', () => {
  const hits = [];
  for (const rel of jsFiles()) {
    const src = stripComments(read(rel));
    for (const key of ['sidebarWidth', 'repoSideWidth']) {
      // 걷어내는 자리는 마이그레이션이다 (FR-UXB-8) — 먼저 덜어낸 뒤 센다.
      const live = src
        .replace(new RegExp(`delete\\s+this\\.ws\\.${key}`, 'g'), '')
        .replace(new RegExp(`'${key}'\\s+in\\s+this\\.ws`, 'g'), '');
      const m = live.match(new RegExp(`(?:this\\.)?ws\\.${key}\\b`, 'g'));
      if (m) hits.push(`${rel}: ${m.join(' · ')}`);
    }
  }
  assert.deepEqual(hits, [], '폭은 워크스페이스가 아니라 sessionStorage 에 산다');
});

test('슬롯 방향은 localStorage 에 쓰이지 않는다 (FR-UXB-1)', () => {
  const src = stripComments(read('core/app-slots.js'));
  assert.ok(!/localStorage\.setItem\(\s*SLOT_DIR_KEY/.test(src),
    'slotDir 는 sessionStorage 의 것이다');
  assert.ok(!/localStorage\.getItem\(\s*SLOT_DIR_KEY/.test(src),
    'slotDir 를 localStorage 에서 읽으면 다른 창의 값을 본다');
  assert.ok(/sessionStorage\.(get|set)Item\(\s*SLOT_DIR_KEY/.test(src),
    'slotDir 는 sessionStorage 를 지난다');
});

test('옛 localStorage 키를 부팅에서 지운다 (FR-UXB-4)', () => {
  const src = stripComments(read('core/app-slots.js'));
  assert.ok(/localStorage\.removeItem\(\s*SLOT_DIR_KEY\s*\)/.test(src),
    '읽지 않는 키는 남기지 않는다 — 다음 사람이 그것을 진실로 읽는다');
});

test('이식 표의 slotDir 는 탭별 칸에 선다 (FR-UXB-5)', () => {
  const src = read('core/app-backup.js');
  const row = src.match(/\{\s*store:\s*'(\w+)'\s*,\s*key:\s*'slotDir'\s*\}/);
  assert.ok(row, 'BACKUP_KEYS 에 slotDir 행이 있어야 한다');
  assert.equal(row[1], 'session', 'displayMode·mobileBreakpoint 와 같은 칸이다');
});

test('첫 페인트의 폭 복원이 sessionStorage 를 읽는다 (FR-UXB-6)', () => {
  const html = readFileSync(join(WEB_ROOT, 'index.html'), 'utf8');
  const line = html.split('\n').find((l) => l.includes("'sidebarWidth'"));
  assert.ok(line, '첫 페인트 스크립트에 폭 복원이 있어야 한다');
  assert.ok(line.includes("sessionStorage.getItem('sidebarWidth')"),
    '첫 페인트도 창의 값을 읽는다 — 여기만 localStorage 면 창끼리 다시 섞인다');
  assert.ok(line.includes("localStorage.getItem('sidebarCollapsed')"),
    '접힘은 기기의 취향이다 (FR-UXB-12) — 함께 옮기지 않는다');
});
