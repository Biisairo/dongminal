import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASE, GITPANEL, load } from './harness.mjs';

/**
 * REFACTOR3_FE_GITPANEL_SRS — Git 패널 mixin 을 부품 클래스로.
 *   TC-FEP-1 부품 계층·패널이 드는 부품 · TC-FEP-2 옮긴 mixin 이 없고 `Object.assign` 이 준다
 *   TC-FEP-3 부품 소유 필드가 패널에 없다 · TC-DLG-1·2 위임자가 없고 부품 인스턴스에 갈아 끼운 것을 패널이 부른다 (REFACTOR3_FE_DELEG_SRS)
 *
 * 하위 단계마다 `PARTS` 에 한 줄을 더한다.
 */
const JS = join(dirname(fileURLToPath(import.meta.url)), '..');
const GIT = join(JS, 'git');
const read = (f) => readFileSync(join(JS, f), 'utf8');

/**
 * field: 패널이 드는 이름 · cls: 부품 클래스 · gone: 사라진 mixin · owned: 부품 소유 필드
 * exposed·exposedRW: e2e 가 읽고 쓰던 소유 필드 — 패널 접근자를 걷었고 e2e 가 `panel.<부품>.X` 로 닿는다
 * delegates: 옛 패널 위임자였던 부품 이름(인자는 옛 시험의 것) · statics: 옛 패널 정적 위임자였던 부품 정적 메서드
 */
const PARTS = [
  { field: 'blame', cls: 'GitBlame', gone: ['git/panel-blame.js'],
    owned: ['_blameKey', '_blameData', '_blameErr', '_blameAll'],
    delegates: [['openBlame', [{ path: 'a.txt', group: 'working' }]], ['blameStale', []], ['_paintBlame', [{ id: 'el' }]]] },
  { field: 'hunks', cls: 'GitHunks', gone: ['git/panel-hunks.js'],
    owned: ['_hunkBarEd', '_hunkBarEl', '_hunkBarPos', '_hunkBarHunk', '_hunkBarFocus', '_hunkBarOff', '_hunkErr', '_hunkErrKey'],
    exposed: ['_hunkBarEd', '_hunkBarPos'],
    delegates: [['_paintHunks', [{ id: 'el' }, { path: 'a.txt' }]], ['_hunkText', []], ['_hunkNote', [{ id: 'note' }, 'text']],
      ['_hunkBarWire', [{ id: 'ed' }]], ['_hunkBarDispose', []], ['_hunkBarHide', []], ['_hunkBarPaint', []],
      ['_hunkAct', ['stage']], ['_diffChanged', []]] },
  { field: 'diffPane', cls: 'GitDiffPane', gone: ['git/panel-diff.js', 'git/panel-diff-tab.js'],
    owned: ['_diffAsking', '_diffShown', '_diffStale', '_diffDirtyShown', '_dtKey', '_dtPendingView', '_sideBy', '_ignWs'],
    delegates: [['_renderDiff', [{ id: 'el' }]], ['_diffInvalidate', []], ['_fileList', []], ['_diffIndex', [[1, 2]]],
      ['_diffMove', [1]], ['reloadDiff', [true]], ['_destroyViews', []], ['diffTabApply', [{ path: 'a.txt' }]],
      ['diffViewKeep', []], ['diffViewRestore', []], ['diffTabViewState', []], ['diffTabViewApply', [{ top: 1 }]]] },
  { field: 'poll', cls: 'GitPoll', gone: ['git/panel-poll.js'], owned: ['_fold'],
    delegates: [['_foldPref', []], ['_setFold', [true]], ['absPath', [{ path: 'a.txt' }]], ['repoTop', []],
      ['openFileDiff', [{ path: 'a.txt' }]], ['copyText', ['t']], ['init', []],
      ['signal', ['write']], ['_pollOk', []], ['_cadence', [1000]], ['_applyCadence', []],
      ['_reschedule', []], ['_stop', []], ['collect', []]] },
  // REFACTOR3_FE_REST5_SRS FR-FR5-21: `git-poll.js` 에서 새로고침·뷰 다시 받기와 워치독이 갈라졌다.
  { field: 'viewReload', cls: 'GitViewReload', gone: [], owned: ['_refsRound'],
    delegates: [['refresh', []], ['_reloadViews', [true]], ['_staleTake', ['history', '/r']], ['_inRefsRound', [() => 1]],
      ['_reloadStaleViews', ['sig']]] },
  { field: 'write', cls: 'GitWrite', gone: ['git/panel-write.js'], owned: ['_opActs', '_opActsP'],
    delegates: [['afterCommitOp', [{ ok: true }]], ['noteCompareMark', ['l']], ['afterRefWrite', [{ status: {} }]],
      ['afterRemoteJob', []], ['afterJobSlots', []], ['stashApply', ['o1', true]], ['stashPop', ['o1']], ['stashDrop', ['o1']],
      ['afterStashWrite', [{ ok: true }]], ['stashBranch', [{ oid: 'o1' }]], ['stashCreate', []],
      ['afterStashRefWrite', [{ ok: true }]], ['applyWriteFail', [{ data: {} }]], ['removeIndexLock', [{ path: 'l' }]],
      ['post', ['/u', { a: 1 }, { detach: true }]], ['bumpWrite', []], ['wqPost', ['/u', { a: 1 }]], ['busyNote', []],
      ['postJob', ['/u', { a: 1 }, () => 1]], ['writeReason', [{ data: {} }]], ['writeError', [{ data: {} }]],
      ['adopt', [{ status: {} }]], ['_paintOp', [{ id: 'el' }, { operation: null }]], ['runOperation', ['abort']],
      ['_paintNote', [{ id: 'el' }]]] },
  { field: 'changes', cls: 'GitChanges', gone: ['git/panel-changes.js'], owned: ['_fileView', '_initBusy', '_initErr'],
    exposedRW: ['_fileView'],
    delegates: [['_renderChanges', [{ id: 'el' }]], ['_paint', []], ['_wireHead', [{ id: 'el' }]], ['_paintHeadIn', [{ id: 'el' }]],
      ['paintHeads', []], ['_treeMode', []]],
    statics: [['headHTML', [{ remote: false }]]] },
  { field: 'changeRows', cls: 'GitChangeRows', gone: [], owned: ['_io'],
    delegates: [['_paintGroup', [{ id: 'el' }, { key: 'working' }, []]], ['_actCols', [['stage'], [['stage']]]], ['_actGap', []],
      ['_toggleGroup', ['working']], ['_watchMore', [{ id: 'files' }]], ['revealRow', ['working', 'a.txt']]] },
  { field: 'files', cls: 'GitFiles', gone: ['git/panel-files.js'], owned: [],
    delegates: [['untrackedPaths', []], ['uncommittedReset', []], ['uncommittedClean', [['a.txt']]], ['ignorePath', [{ path: 'a.txt' }]],
      ['openFileHistory', [{ path: 'a.txt' }]], ['openFileAtHead', [{ path: 'a.txt' }]], ['dirtyCount', []], ['isDirty', []],
      ['showCommitDiff', [{ oid: 'o1' }]], ['_target', ['working', { path: 'a.txt' }]], ['_selected', []],
      ['_rowTargets', ['stage', 'working', 'a.txt', '', false]], ['_bulk', ['working', 'stage']],
      ['_dirBulk', ['working', 'd', 'stage']], ['_run', ['stage', []]], ['_op', []]] },
  { field: 'selection', cls: 'GitSelection', gone: ['git/panel-dir-entry.js'], owned: [],
    delegates: [['_diffTarget', []], ['_selKey', ['working', 'a.txt']], ['_noBaseline', ['working', { path: 'a.txt' }]],
      ['_openInEditor', [{ path: 'a.txt' }]], ['_select', ['working', { path: 'a.txt' }, null]], ['_openDiff', ['working', { path: 'a.txt' }]],
      ['openView', ['diff']], ['_dirEntryNote', [{ sub: '' }]], ['_dirEntryActs', [{ path: 'd' }]]] },
  { field: 'views', cls: 'GitViews', gone: ['git/panel-views.js'], owned: ['_knownRefs'], exposed: ['_knownRefs'],
    delegates: [
      ['_commit', []], ['_remote', []], ['adoptJobs', [[]]], ['expandGroup', ['working']], ['_history', []],
      ['_branches', []], ['_console', []], ['_worktrees', []], ['_stash', []],
      ['_renderView', ['history', { id: 'el' }]], ['_emptyHint', [{ id: 'el' }, 't']], ['statusOf', []],
      ['actionOf', ['a']], ['_viewFp', [{ status: {} }]], ['headName', []],
      ['checkoutRef', ['main', { force: true }]], ['checkoutRemote', ['origin/x']],
      ['branchRename', [{ short: 'x' }]], ['branchDelete', [{ short: 'x' }, ['x']]],
      ['branchDeleteTargets', [{ short: 'x' }]], ['branchMerge', ['x']], ['branchRebase', ['x']],
      ['branchSetUpstream', [{ short: 'x' }]], ['branchUnsetUpstream', [{ short: 'x' }]],
      ['branchPush', [{ short: 'x' }]], ['branchFetchInto', [{ short: 'x' }]],
      ['branchDeleteRemote', [{ short: 'x' }]], ['branchDeleteBoth', [{ short: 'x' }, ['x']]],
      ['branchDeletePair', [{ short: 'x' }]], ['adoptRefs', [[{ short: 'x' }]]],
      ['fetchRefs', ['/r', { stale: null }]], ['branchNote', ['m']], ['notifyPins', []],
      ['createBranchFrom', ['o1']], ['createTag', ['o1']], ['tagDelete', ['v1']], ['tagDeleteRemote', ['v1']],
      ['tagPush', ['v1']], ['tagPushAll', []]] },
  { field: 'viewRoots', cls: 'GitViewRoots', gone: ['git/panel-life.js'], owned: [],
    delegates: [['elFor', ['history']], ['viewDirty', ['diff', true]], ['viewSave', ['diff']], ['dropView', ['diff']], ['_render', ['changes']], ['_paintStaleIn', [{ id: 'el' }]], ['paintStale', []], ['_enterMissing', []], ['_enterMissingView', []], ['_leaveMissing', []], ['_paintAllViews', []]] },
];

/** 옛 `panel-life.js` 중 패널 클래스 본문으로 온 것 (FR-FEP-7). */
const BODY = ['setRepo', '_repoSwitchView', 'destroy', 'detach', 'token', 'isStale'];

/** 생성자 밖 참조가 없어 지운 필드 (FR-FEP-6). */
const DEAD = ['_hunkBarWidget', '_hunkBarSubs'];

/** 하위 단계가 끝난 뒤 남는 `Object.assign(GitPanel.prototype` 의 수 (TC-FEP-2). 처음은 12 다. */
const ASSIGNS_LEFT = 0;

function setup(globals = {}) {
  const ctx = load([...BASE, ...GITPANEL], {
    expose: ['GitPanel', 'GitPart', 'Component', ...PARTS.map((s) => s.cls)],
    // `GitPoll` 의 클래스 필드가 생성 때 읽는다 (PERF 1.15). 원본은 i18n 을 부르는 constants-git-detect.js 라 싣지 않는다.
    globals: { TIMERS: { disposeOwner() {} }, GIT_STATUS_RETRY_MS: 30000, ...globals },
  });
  const obs = { attach() {}, detach() {}, resettle() {} };
  // `renderer.life` — 패널은 파괴될 때 생명주기에서도 빠진다 (PERF M3 §3.5).
  const app = { git: { surfaces: { gitObs: () => obs } }, timers: { disposeOwner() {} }, renderer: { life: { unmount() {} } } };
  return { ctx, app, panel: new ctx.GitPanel(app, '') };
}

test('TC-FEP-1 부품은 GitPart·Component 하위이고 패널이 든다', () => {
  const { ctx, app, panel } = setup();
  assert.ok(ctx.GitPart.prototype instanceof ctx.Component);
  for (const s of PARTS) {
    const part = panel[s.field];
    assert.ok(part instanceof ctx[s.cls], `${s.field} 가 ${s.cls} 가 아니다`);
    assert.ok(part instanceof ctx.GitPart, `${s.cls} 가 GitPart 하위가 아니다`);
    assert.equal(part.p, panel);
    assert.equal(part.app, app);
  }
});

test('TC-DLG-1 부품의 이름은 부품 원형에 있고 패널 원형에는 없다 (REFACTOR3_FE_DELEG_SRS DL-3)', () => {
  const { ctx, panel } = setup();
  const proto = Object.getPrototypeOf(panel);
  for (const s of PARTS) {
    for (const [name] of s.delegates) {
      assert.equal(typeof Object.getPrototypeOf(panel[s.field])[name], 'function', `${s.field}.${name} 이 없다`);
      assert.ok(!(name in proto), `위임자가 남았다: ${name}`);
    }
    for (const k of [...(s.exposed || []), ...(s.exposedRW || [])]) assert.ok(!(k in proto), `접근자가 남았다: ${k}`);
    for (const [name, args] of s.statics || []) {
      assert.equal(typeof ctx[s.cls][name], 'function', `${s.cls}.${name} 이 없다`);
      assert.equal(typeof ctx[s.cls][name](...args), 'string');
      assert.ok(!(name in ctx.GitPanel), `정적 위임자가 남았다: ${name}`);
    }
  }
  assert.ok(!('watchdog' in proto) && !('_watchdog' in proto), '감시견이 남았다 (PERF_OPTIMIZATION_SRS M1 C4)');
});

test('TC-DLG-2 부품 인스턴스에 갈아 끼운 메서드를 패널 본문이 부른다', () => {
  const { panel } = setup({
    GitMenu: { close() {} }, GIT_PANEL_VIEW_FIELDS: [], GIT_VIEWS: [{ key: 'changes' }],
    GIT_PREVIEW_HINT: 'p', GIT_NO_REPO_HINT: 'n', document: { getElementById: () => null },
  });
  const seen = [];
  panel.poll._stop = () => seen.push('poll._stop');
  panel.diffPane._destroyViews = () => seen.push('diffPane._destroyViews');
  panel.views._commit = () => ({ unmount: () => seen.push('views._commit().unmount') });
  panel.detach();
  assert.deepEqual(seen, ['poll._stop', 'diffPane._destroyViews', 'views._commit().unmount']);
  seen.length = 0;
  panel.hunks._hunkBarHide = () => seen.push('hunks._hunkBarHide');
  panel.viewRoots._render = (k) => seen.push('viewRoots._render:' + k);
  panel._els.set('changes', {});
  panel._repoSwitchView('');
  assert.deepEqual(seen, ['hunks._hunkBarHide', 'viewRoots._render:changes']);
});

test('TC-FEP-1 패널 destroy 가 부품을 해제한다 (FR-FEP-1)', () => {
  const { panel } = setup();
  panel.detach = () => {};
  panel.destroy();
  for (const s of PARTS) assert.equal(panel[s.field].disposed, true, `${s.field} 가 해제되지 않았다`);
});

test('TC-FEP-2 옮긴 mixin 파일이 없고 Object.assign(GitPanel.prototype 이 준다', () => {
  for (const s of PARTS) for (const f of s.gone) assert.ok(!existsSync(join(JS, f)), `${f} 가 남았다`);
  let n = 0;
  for (const f of readdirSync(GIT)) n += (readFileSync(join(GIT, f), 'utf8').match(/^Object\.assign\(GitPanel\.prototype/gm) || []).length;
  assert.equal(n, ASSIGNS_LEFT);
  const html = read('../index.html');
  const order = [...html.matchAll(/<script src="js\/(git\/(?:git-part|git-[a-z-]+|panel[a-z-]*)\.js)/g)]
    .map((m) => m[1]).filter((f) => GITPANEL.includes(f));
  assert.deepEqual(order, GITPANEL, 'index.html 의 순서가 하네스 묶음과 다르다');
});

test('TC-FEP-3 부품 소유 필드가 패널 원형·생성자에 없고 패널 쪽 파일이 읽지 않는다', () => {
  const { panel } = setup();
  const proto = Object.getPrototypeOf(panel);
  const panelSrc = readdirSync(GIT).filter((f) => /^panel/.test(f)).map((f) => [f, readFileSync(join(GIT, f), 'utf8')]);
  for (const s of PARTS) {
    for (const k of s.owned) {
      assert.ok(!Object.hasOwn(panel, k), `${k} 가 패널 생성자에 있다`);
      for (const [f, src] of panelSrc) assert.ok(!src.includes('this.' + k), `${f} 가 ${k} 를 읽는다`);
      assert.ok(!(k in proto), `${k} 가 패널 원형에 있다`);
    }
  }
  const all = readdirSync(GIT).map((f) => readFileSync(join(GIT, f), 'utf8')).join('\n');
  for (const k of DEAD) {
    assert.ok(!Object.hasOwn(panel, k), `죽은 필드 ${k} 가 남았다`);
    assert.ok(!all.includes(k), `죽은 필드 ${k} 가 소스에 남았다`);
  }
});

test('TC-FEP-2 life 의 수명 메서드는 GitPanel 클래스 본문에 있다 (FR-FEP-7)', () => {
  const { ctx } = setup();
  const src = read('git/panel.js');
  const body = src.slice(src.indexOf('class GitPanel {'));
  for (const m of BODY) {
    assert.ok(Object.hasOwn(ctx.GitPanel.prototype, m), `${m} 가 패널 원형에 없다`);
    assert.match(body, new RegExp('\\n  (async )?' + m + '\\('), `${m} 가 클래스 본문에 없다`);
  }
});
