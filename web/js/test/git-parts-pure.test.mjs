import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE, load } from './harness.mjs';

/**
 * REFACTOR3_FE_REST3_SRS FR-FR3-18·19·20 (FU-15·16, TC-FR3-39·40) — Git 패널 부품의 큰 함수에서 뺀 순수 함수.
 * 골격 문자열 · 행 제목 · 행 동작 제목 · status 응답 판정.
 */
const ctx = load([...BASE, 'git/git-part.js', 'git/git-changes.js', 'git/git-change-rows.js', 'git/git-poll.js'], {
  globals: {
    TIMERS: { disposeOwner() {} },
    GIT_OP_CONTINUE: 'continue', GIT_OP_SKIP: 'skip', GIT_OP_ABORT: 'abort',
    GIT_PARTIAL_TITLE: 'partly staged',
    GIT_SIDE_TITLE: { '': { ours: 'ours?', theirs: 'theirs?' }, merge: { ours: 'keep mine', theirs: 'take theirs' } },
    GIT_ACT_TITLE: { stage: 'Stage', discard: 'Discard' },
    GIT_ACT_TITLE_UNTRACKED: { discard: 'Delete' },
  },
});

test('TC-FR3-39: gitChangesHTML — 커밋 → 머리 → 잡 → 진행 중 작업 → 부분 노트 → 목록 순서다', () => {
  const html = ctx.gitChangesHTML('<HEAD/>', '<BOXES/>');
  const at = (s) => html.indexOf(s);
  const order = ['class="git-commit"', '<HEAD/>', 'class="git-jobs"><BOXES/></div>', 'class="git-op-bar"',
    'git-partial-note', 'class="git-changes-body"', 'class="git-files ui-scroll-sm"'];
  for (const s of order) assert.ok(at(s) >= 0, s + ' 가 없다');
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), order[i - 1] + ' → ' + order[i]);
  for (const a of ['continue', 'skip', 'abort']) assert.match(html, new RegExp('git-op-act" data-act="' + a + '" hidden'));
  assert.match(html, /ui-btn-danger git-op-act" data-act="abort"/);
});

test('TC-FR3-39: gitRowTitle — 이름 바뀜·점수·일부 스테이지·디렉터리 설명', () => {
  const t = ctx.gitRowTitle;
  assert.equal(t({ path: 'a.js' }, false, ''), 'a.js');
  assert.equal(t({ path: 'b.js', origPath: 'a.js', score: 92 }, false, ''), 'a.js → b.js (92%)');
  assert.equal(t({ path: 'a.js' }, true, ''), 'a.js — partly staged');
  assert.equal(t({ path: 'sub', dir: true }, true, 'submodule'), 'sub — partly staged — submodule');
});

test('TC-FR3-39: gitRowActTitle — ours/theirs 는 진행 중 조작으로, 새 파일 폐기는 삭제 문구로', () => {
  const t = ctx.gitRowActTitle;
  assert.equal(t('ours', {}, 'merge'), 'keep mine');
  assert.equal(t('theirs', {}, ''), 'theirs?');
  assert.equal(t('theirs', {}, 'unknown-op'), 'theirs?', '모르는 조작은 양쪽을 다 밝히는 문구');
  assert.equal(t('discard', { untracked: true }, ''), 'Delete');
  assert.equal(t('discard', {}, ''), 'Discard');
  assert.equal(t('stage', { untracked: true }, ''), 'Stage', '새 파일 문구가 없는 동작은 기본 문구');
});

test('TC-FR3-40: gitStatusVerdict — net · error · drop · not_repo · ok', () => {
  const v = ctx.gitStatusVerdict;
  assert.equal(v({ status: 0, ok: false }, null, '/r'), 'net');
  assert.equal(v({ status: 500, ok: false }, { error: 'x' }, '/r'), 'error');
  assert.equal(v({ status: 200, ok: true }, null, '/r'), 'drop');
  assert.equal(v({ status: 200, ok: true }, { requested: '/other' }, '/r'), 'drop');
  assert.equal(v({ status: 200, ok: true }, { requested: '/r', isRepo: false }, '/r'), 'not_repo');
  assert.equal(v({ status: 200, ok: true }, { requested: '/r', isRepo: true }, '/r'), 'ok');
  assert.equal(v({ status: 200, ok: true }, { requested: '/r' }, '/r'), 'ok');
});
