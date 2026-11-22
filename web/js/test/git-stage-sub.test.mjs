import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from './harness.mjs';

/**
 * REFACTOR3_FE_REST1_SRS FR-FR1-9·11 (FU-17, 사용자 결정 Q3): 행의 Stage 는 서버의 행 답이 켜고 끈다.
 *   이전 동작: 화면이 `gitSubParts(e.sub)` 로 안쪽만 바뀐 서브모듈을 판정해 껐다
 *   새  동작: status 응답의 `rowActions[path]['git.stage']` 로 끈다. 답이 없는 행은 행 단위 판정이 없다
 *   이유:     서버도 같은 함수로 거절한다 — 판정이 한 벌이다
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(JS, f), 'utf8');

function setup(rowActions) {
  // `constants-git-remote.js` 는 `GIT_API` 를 딛으므로 싣지 않는다 — 동작 ID 는 소스 검사가 본다.
  const ctx = load(['core/base/component.js', 'ui/repaint.js', 'core/action-answer.js',
    'core/constants-git-changes.js', 'git/git-part.js', 'git/git-views.js', 'git/git-change-rows.js'], {
    expose: ['GitChangeRows', 'GitViews', 'GIT_STAGE_WHY_TITLE'],
    globals: { t: (k, a) => (a ? k + JSON.stringify(a) : k), GIT_ACTION: { stage: 'git.stage' } },
  });
  const panel = { app: {}, _status: { actions: {}, rowActions } };
  panel.views = new ctx.GitViews(panel);
  return { ctx, rows: new ctx.GitChangeRows(panel) };
}

test('TC-FR1-6: 거짓인 행 답이면 Stage 가 꺼지고 툴팁은 영어 문장이다', () => {
  const { ctx, rows } = setup({ sub: { 'git.stage': { ok: false, why: 'submodule_inner_only' } } });
  const title = rows._stageOff({ path: 'sub', dir: true, sub: 'S..U' });
  assert.equal(title, ctx.GIT_STAGE_WHY_TITLE.submodule_inner_only);
  assert.match(title, /^Nothing here for this repository to stage — commit inside the submodule first$/);
});

test('TC-FR1-6: 참인 답·답이 없는 행은 켜진다 — 화면은 sub 를 판정하지 않는다', () => {
  const { rows } = setup({ subc: { 'git.stage': { ok: true } } });
  assert.equal(rows._stageOff({ path: 'subc', dir: true, sub: 'SC.U' }), '');
  // 서버가 답을 싣지 않은 행은 sub 가 상태 B 여도 켜진다 — 판정은 서버의 것이다
  assert.equal(rows._stageOff({ path: 'other', dir: true, sub: 'S..U' }), '');
  assert.equal(setup(undefined).rows._stageOff({ path: 'x.txt' }), '');
});

test('TC-FR1-6: 표에 없는 사유는 카탈로그 문구다', () => {
  const { rows } = setup({ sub: { 'git.stage': { ok: false, why: 'job_busy' } } });
  assert.equal(rows._stageOff({ path: 'sub' }), 'why.job_busy');
});

test('TC-FR1-6 (FR-FR1-11): 행의 Stage 판정에 gitSubParts 가 없다', () => {
  const src = read('git/git-change-rows.js');
  const i = src.indexOf('  _rowEl(group,e,depth){');
  // 주석의 "이전 동작" 기록은 옛 이름을 인용한다 — 코드 줄만 본다
  const body = src.slice(i, src.indexOf('\n  }\n', i)).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.ok(i >= 0 && !/gitSubParts/.test(body), '_rowEl 이 gitSubParts 로 판정한다');
  assert.ok(!/GIT_TIP_SUB_STAGE_OFF/.test(read('core/constants-git-changes.js')));
  assert.match(read('core/constants-git-remote.js'), /stage:'git\.stage'/);
});
