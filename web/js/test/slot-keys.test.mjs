import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SAFETY_CORRECTNESS_SRS 묶음 F · FR-SAF-24.
 *
 * **손으로 적은 슬롯 목록을 금지한다.**
 *
 * `SLOT_MAX` 가 2 에서 4 로 자랐을 때, 상수를 도는 자리
 * (`_slotReap`·`_gitPanelReap`·`_slotSyncSubs`·`_slotCloseAllSubs`)는 따라왔고
 * 손으로 적은 자리 둘(`_killToolInstances`·`toolAny`)은 따라오지 못했다. 그
 * 결과 슬롯 2·3 의 도구 인스턴스가 삭제 경로에서 회수되지 않고 **죽은 PTY 로
 * 무한 재접속**했다 — `_killToolInstances` 바로 위 주석이 *"모든 슬롯의
 * 인스턴스를 파괴한다 (FR-WSL-22)"* 라고 예고한 실패 모드 그대로다.
 *
 * 그래서 재는 것은 "지금 몇 칸을 도는가" 가 아니라 **"상수에서 파생했는가"** 다.
 * 숫자를 세면 `SLOT_MAX` 가 5 가 될 때 이 검사도 함께 낡는다.
 */

const JS_ROOT = new URL('../', import.meta.url).pathname;

/** 슬롯 파생의 **단일 출처**. 여기서만 리터럴 첨자를 써도 된다. */
const SOURCE_OF_TRUTH = 'core/app-slots.js';

function jsFiles() {
  const out = [];
  for (const dir of ['core', 'ui', 'git']) {
    for (const f of readdirSync(join(JS_ROOT, dir))) {
      if (f.endsWith('.js')) out.push(dir + '/' + f);
    }
  }
  return out;
}

test('slotKey 를 리터럴 첨자로 부르는 자리가 없다 (FR-SAF-24)', () => {
  // `slotKey(id, 1)` · `slotKey(pid,2)` 꼴. 변수·식은 잡지 않는다 —
  // 파생이면 첨자가 리터럴일 이유가 없다.
  const LITERAL = /\.slotKey\([^,()]+,\s*\d+\s*\)/g;
  const hits = [];
  for (const rel of jsFiles()) {
    if (rel === SOURCE_OF_TRUTH) continue;
    const src = readFileSync(join(JS_ROOT, rel), 'utf8');
    for (const line of src.split('\n')) {
      const m = line.match(LITERAL);
      if (m) hits.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, [],
    '슬롯 첨자를 손으로 적은 자리가 있다 — SLOT_MAX 가 자랄 때 따라오지 못한다:\n' + hits.join('\n'));
});

test('슬롯 전체를 도는 자리는 SLOT_MAX 에서 파생한다 (FR-SAF-17)', () => {
  const src = readFileSync(join(JS_ROOT, SOURCE_OF_TRUTH), 'utf8');
  assert.ok(/slotKeysOf\s*\(/.test(src),
    'app-slots.js 에 slotKeysOf 가 없다 — 파생을 담을 자리가 있어야 한다');
  // 그 함수의 본문이 SLOT_MAX 를 딛는지 본다.
  const at = src.indexOf('slotKeysOf');
  const body = src.slice(at, at + 400);
  assert.ok(/SLOT_MAX/.test(body),
    'slotKeysOf 가 SLOT_MAX 를 딛지 않는다 — 손으로 적은 목록과 같아진다');
});
