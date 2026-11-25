import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * 클래식 `<script>` 를 Node 에서 불러오는 30줄 하네스
 * (CI_GATES_SRS B4 · `05-test.md §3.4`).
 *
 * `web/js` 는 모듈이 아니다 — 서버가 `web/bundles.txt` 의 순서대로 이어 붙인 묶음과
 * `web/index.html` 의 `<script>` 가 클래식 스크립트 약 300개를 순서대로 싣고, 그 안의
 * `class`/`function`/`const` 가 전역으로 서로를 본다 (`type="module"` 0개). 그래서
 * `import` 로는 꺼낼 수 없다.
 *
 * ESM 으로 옮기는 것이 정공법이지만 그것은 로드 순서와 `__ASSETV__`
 * 캐시 버스팅에 얽힌 별도 결정이다. **그때까지 순수 로직을 검사 못 할 이유는
 * 없다** — `vm.createContext` 에 같은 순서로 넣으면 브라우저가 하는 일과 같다.
 *
 * 이 자리가 없을 때는 `git-hunk.spec.ts` 의 "묶음 S — 좌표 사상" 5건이 **브라우저를
 * 띄워 순수 함수를 검사했다.** 지금은 `hunk-coords.test.mjs` 로 옮기고 e2e 에는 연결
 * 확인 1건만 남았다.
 */

/**
 * 옛 `core/helpers.js` 를 이루던 주제 파일들 — `web/bundles.txt` 의 순서다 (OPTIMIZE_REFACTOR_SRS
 * FR-OPT-11-6). 옛 파일 하나를 싣던 검사는 이것을 펼쳐 싣는다.
 */
export const HELPERS = ['core/path.js', 'core/helpers.js', 'core/theme-vars.js', 'core/shortcuts.js',
  'core/settings-state.js', 'core/layout-tree.js', 'core/git-status-helpers.js'];

/**
 * 옛 `core/constants.js` 를 이루던 주제 파일들 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_REST5_SRS FR-FR5-20). 옛 파일 하나를
 * 싣던 검사는 이것을 펼쳐 싣는다.
 */
export const CONSTANTS = ['core/constants.js', 'core/constants-term.js', 'core/constants-sandbox.js', 'core/constants-tips.js',
  'core/constants-file.js'];

/**
 * 터미널 칸 한 벌 — `web/bundles.txt` 의 순서다 (OPTIMIZE_REFACTOR_SRS FR-OPT-12-1·12-4). WS 배선
 * (`term-channel.js`)과 입력·IME(`term-input.js`)가 `term-pane.js` 에서 갈라졌다. 복사·텍스트 시트
 * (`term-clip.js`)와 터치 스크롤(`term-touch.js`)은 `term-input.js` 에서 갈라졌다 (UX_BATCH11_SRS).
 *
 * REFACTOR3_FE_REST5_SRS D-FR5-9: 부품 넷(`term-{transfer,held,output,fit}.js`)이 `term-pane.js` 에서 갈라졌다.
 * 부품이 `Controller`·`Component` 를 상속하므로 기반 클래스 둘을 앞에 싣는다.
 */
export const TERM_PANE = ['core/base/component.js', 'core/base/controller.js', 'ui/term-channel.js', 'ui/term-pane.js',
  'ui/term-transfer.js', 'ui/term-held.js', 'ui/term-output.js', 'ui/term-fit.js', 'ui/term-input.js', 'ui/term-clip.js',
  'ui/term-touch.js', 'ui/term-history.js'];

/**
 * 프론트 기반 클래스 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_BASE_SRS FR-FEB-16). `extends` 는 로드 시점에
 * 부모를 읽으므로 `component.js` 가 맨 앞이다.
 */
export const BASE = ['core/base/component.js', 'core/base/view.js', 'core/base/controller.js',
  'core/base/escape-stack.js', 'core/base/scroll-memo.js', 'core/base/badge.js'];

/**
 * 패널과 탭 줄 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_BASE_SRS FR-FEB-20~25). `BASE` 뒤에 싣는다.
 * 부모(`Panel`·`TabBar`)가 하위보다 먼저다.
 */
export const PANELS = ['ui/panel.js', 'ui/tab-bar.js', 'ui/sidebar-tab-bar.js', 'ui/sidebar-panel.js', 'ui/drawer-sheet.js',
  'core/activity-tab-bar.js', 'core/activity-panel.js'];

/**
 * 핸들의 크기 HUD 와 끌기 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_REST3_SRS FR-FR3-16). `ui/ui-kit.js` 바로 뒤, `DIALOG` 앞에
 * 싣는다. 묶음 순서: BASE → repaint → ui-kit → HANDLE → DIALOG → LIST → MENU.
 */
export const HANDLE = ['ui/size-hud.js', 'ui/size-drag.js'];

/**
 * 대화상자 기반 클래스와 킷 모달 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_DIALOG_SRS FR-FED-11). `BASE` 뒤,
 * `ui/ui-kit.js` 뒤에 싣는다. git 모달·설정 모달은 이 뒤에 각자 싣는다.
 */
export const DIALOG = ['ui/dialog.js', 'ui/kit-modal.js'];

/** 목록 기반 클래스 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_LIST_SRS FR-FEL-6). `BASE`·`ui/repaint.js` 뒤에 싣는다. */
export const LIST = ['ui/list-view.js'];

/** 메뉴 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_ESC_SRS FR-FEE-10). `BASE`·`ui/ui-kit.js` 뒤, `LIST` 뒤에 싣는다. */
export const MENU = ['ui/menu.js'];

/** Git 탭 기반 클래스 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_GITVIEW_SRS FR-FEV-11). `LIST` 뒤, git 뷰들 앞에 싣는다. */
export const GITVIEW = ['git/git-view.js'];

/**
 * Git 패널 한 벌 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_GITPANEL_SRS FR-FEP-9). `BASE` 뒤에 싣는다. 부품 기반
 * (`git-part.js`)이 `panel.js` 앞이고, 부품 파일은 옛 mixin 자리에 선다.
 */
export const GITPANEL = ['git/git-part.js', 'git/panel.js', 'git/git-changes.js',
  'git/git-change-rows.js', 'git/git-views.js', 'git/git-view-roots.js', 'git/git-write.js', 'git/git-files.js', 'git/git-selection.js',
  'git/git-diff-pane.js', 'git/git-blame.js', 'git/git-hunks.js', 'git/git-poll.js', 'git/git-view-reload.js'];

/**
 * 설정 섹션 한 벌 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_SETTINGS_SRS FR-FES-8). `BASE` 뒤에 싣는다. 섹션 기반과 행이
 * 섹션보다 먼저다. 컨트롤러의 부품(`settings-apply.js`·`settings-live.js`·`settings-save-state.js`, REFACTOR3_FE_APPCTL_SRS
 * 9a)도 싣는다 — 이 셋은 끝에서 App 원형에 위임자를 두므로 `App` 전역이 있어야 한다. 값의 표(`settings-table.js`)는
 * 싣지 않는다 — 시험이 `SETTINGS_ACCESS` 를 준다.
 */
export const SETTINGS = ['core/settings-apply.js', 'core/settings-section.js', 'core/settings-row.js', 'core/settings-display.js',
  'core/settings-terminal.js', 'core/settings-code.js', 'core/settings-polling.js', 'core/settings-statusbar.js',
  'core/settings-notify.js', 'core/settings-theme.js', 'core/settings-shortcuts.js', 'core/settings-live.js',
  'core/settings-save-state.js', 'core/settings-sandbox.js',
  'core/settings-access.js', 'core/settings-edges.js', 'core/settings-profile.js', 'core/settings-telegram.js',
  'core/settings-server.js', 'core/settings-claude.js', 'core/settings-backup.js', 'core/settings-presets.js',
  'core/screens.js', 'core/settings-controller.js', 'core/settings-open.js'];

/**
 * App 컨트롤러 묶음 — `web/bundles.txt` 의 순서다 (REFACTOR3_FE_APPCTL_SRS 9c). `BASE` 뒤에 싣는다. 뿌리가 부품을 생성자에서
 * 만들므로 한 묶음의 파일은 함께 싣는다. 끝에서 App 원형에 위임자를 두므로 `App` 전역이 있어야 한다.
 */
export const AGENTS = ['core/agents-controller.js', 'core/agents-sub.js', 'core/activity-list.js'];
/**
 * 화면 묶음이 모두 실린 것으로 보는 등록부 대역 (PERF 3.4.9). 화면을 등록하고 `Screens.ready` 로 본체를 세우는 파일
 * (`chat-controller.js` 등)을 그 본체와 함께 실을 때 `globals.Screens` 로 준다.
 */
export const SCREENS_LOADED = Object.freeze({ register() {}, ready: () => true, load: () => Promise.resolve() });
export const CHAT = ['core/chat-store.js', 'core/chat-controller.js', 'core/chat-views.js', 'core/chat-human.js', 'core/chat-window.js'];
export const MOBILE = ['core/mobile-controller.js', 'core/mobile-sheets.js', 'core/mobile-nav.js'];
// `core/screens.js` 가 앞이다 — git-controller.js 가 로드 시점에 git 화면을 등록한다 (PERF 3.4.6).
export const GIT = ['core/screens.js', 'core/git-repos-list.js', 'core/git-topics.js', 'core/git-controller.js', 'core/git-surfaces.js', 'core/git-sync.js'];
export const WS_SYNC = ['core/ws-sync-controller.js', 'core/ws-save-controller.js', 'core/soft-reload.js'];
export const FOCUS = ['core/focus-controller.js', 'core/focus-highlight.js', 'core/focus-owner.js'];
export const SLOTS = ['core/slots-controller.js', 'core/slot-ops.js'];
export const LAYOUT = ['core/layout-controller.js', 'core/layout-tab-add.js', 'core/layout-tab-ops.js', 'core/layout-window-state.js',
  'core/layout-dock.js', 'core/layout-tab-reopen.js', 'core/layout-dnd.js', 'core/layout-groups.js'];
export const TOOL = ['core/tool-cmd.js', 'core/tool-controller.js', 'core/tool-life.js', 'core/tool-work.js', 'core/tool-search.js'];
export const EDITOR = ['core/screens.js', 'core/editor-controller.js', 'core/editor-sync.js', 'core/editor-open.js', 'core/editor-doc.js',
  'core/editor-pane.js', 'core/editor-watch.js', 'core/editor-file.js', 'core/editor-section.js', 'core/editor-doc-render.js',
  'core/editor-search.js'];
export const REPO_WIN = ['core/repo-preview.js', 'core/repo-win-controller.js'];

/** App 필드 → 뿌리 컨트롤러 클래스. App 생성자가 세우는 것과 같다 (REFACTOR3_FE_APPCTL_SRS FR-FEA-1). */
const APP_CONTROLLERS = { settings: 'SettingsController', edges: 'EdgesController', update: 'UpdateController',
  attn: 'AttnController', claude: 'ClaudeAccountsController', statusbar: 'StatusBarController', chat: 'ChatController',
  agents: 'AgentsController', mobile: 'MobileController', git: 'GitController', wsSync: 'WsSyncController', wsSave: 'WsSaveController',
  focus: 'FocusController', slot: 'SlotsController', layout: 'LayoutController',
  tool: 'ToolController', editor: 'EditorController', repoWin: 'RepoWinController' };

/**
 * 실은 파일에 있는 뿌리 컨트롤러를 앱에 세운다 — App 생성자의 몫을 시험이 대신한다. 이미 있는 필드는 두고, 싣지 않은
 * 클래스는 건너뛴다. 클래스는 `expose` 하지 않아도 된다(같은 컨텍스트의 렉시컬 이름을 읽는다).
 */
export function controllers(ctx, app) {
  for (const [field, cls] of Object.entries(APP_CONTROLLERS)) {
    if (app[field]) continue;
    const C = vm.runInContext('typeof ' + cls + ' === "function" ? ' + cls + ' : null', ctx);
    if (C) { app[field] = new C(app); continue }
    // 싣지 않은 컨트롤러는 빈 주인으로 둔다 — 시험이 소유 경로(`app.git.plainWindows = …`)에 대역을 갈아 끼운다
    // (REFACTOR3_FE_DELEG_SRS FR-DLG-5).
    app[field] = Object.fromEntries((APP_CONTROLLER_PARTS[field] || []).map((k) => [k, {}]));
  }
  return app;
}

/** 뿌리 컨트롤러 → 그것이 드는 부품의 필드. 싣지 않은 컨트롤러의 빈 주인을 세울 때 쓴다. */
const APP_CONTROLLER_PARTS = { settings: ['apply', 'live', 'saveState'], git: ['surfaces', 'sync'], agents: ['sub', 'list'],
  chat: ['window', 'human', 'views'], claude: ['maps'], mobile: ['nav', 'sheets'], focus: ['hl', 'owner'], slot: ['ops'],
  wsSync: ['reload'], repoWin: ['preview'],
  layout: ['tabAdd', 'tabOps', 'dock', 'dnd', 'groups', 'winState', 'reopen'],
  tool: ['life', 'cmd', 'work', 'search'],
  editor: ['sync', 'open', 'pane', 'watch', 'section', 'doc', 'file', 'docRender', 'search'] };

/** 탐색기 필드 → 부품 클래스. `FileTree` 생성자가 세우는 것과 같다 (REFACTOR3_FE_REST5_SRS FR-FR5-31). */
const FILE_TREE_PARTS = { loader: 'FileTreeLoad', selector: 'FileTreeSelect', painter: 'FileTreePaint', keys: 'FileTreeKeys',
  marquee: 'FileTreeMarquee', edits: 'FileTreeEdit', xfer: 'FileTreeXfer', dl: 'FileTreeDownload' };

/**
 * 실은 파일에 있는 탐색기 부품을 탐색기 대역에 세운다 — `FileTree` 생성자의 몫을 시험이 대신한다(`controllers` 와 같은 꼴).
 * 싣지 않은 부품은 건너뛴다.
 */
export function treeParts(ctx, t) {
  for (const [field, cls] of Object.entries(FILE_TREE_PARTS)) {
    const C = vm.runInContext('typeof ' + cls + ' === "function" ? ' + cls + ' : null', ctx);
    if (C) t[field] = new C(t);
  }
  return t;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const JS_ROOT = join(HERE, '..');

/**
 * 최소 브라우저 대역. **필요한 것만 둔다** — 넓은 대역은 검사 대상이 실제로
 * 무엇에 기대는지를 감춘다.
 */
function browserStub(clock) {
  const listeners = new Map();
  return {
    document: {
      hidden: false,
      addEventListener: (t, fn) => { listeners.set(t, fn) },
      removeEventListener: (t) => { listeners.delete(t) },
      /** 검사가 가시성 변화를 흉내내는 자리. */
      _fire: (t) => { const fn = listeners.get(t); if (fn) fn() },
      /**
       * 위젯을 **세우기만** 하면 되는 검사를 위한 최소 원소다. 레이아웃도
       * 이벤트 전파도 없다 — 그것을 재려는 검사는 e2e 로 간다.
       */
      createElement: () => elementStub(),
      body: { classList: { contains: () => false } },
    },
    requestAnimationFrame: (fn) => clock.setTimeout(fn, 16),
    cancelAnimationFrame: (h) => clock.clearTimeout(h),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: clock.Date,
    console,
    // 웹 API 중 **검사 대상이 실제로 부르는 것만** 둔다. `core/api.js` 가 URL 조립·
    // 시한·업로드 판별에 이 셋을 쓴다 (CLIENT_API_SRS FR-CAPI-5·6·7).
    //
    // Node 의 전역을 그대로 넣는다 — 검사가 만든 `FormData` 와 vm 안의 것이 같은
    // 생성자여야 `instanceof` 가 realm 을 건너 성립한다.
    URLSearchParams,
    AbortSignal,
    FormData,
    // `core/constants.js` 가 로드 시점에 쓰고, `ui/term-pane.js` 가 WS 바이트를
    // 글자로 옮길 때 쓴다 (TERMINAL_RESUME_SRS FR-TRS-7 의 좌표가 그 **앞의**
    // 바이트 수다).
    TextDecoder,
    TextEncoder,
  };
}

/** `document.createElement` 가 돌려주는 최소 원소. */
function elementStub() {
  const el = {
    className: '', dataset: {}, style: { cssText: '' }, children: [],
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c) { el.children.push(c); return c },
    // UX_AUDIT_FIX_SRS FR-UXF-100: 글자 앞에 아이콘을 세우는 자리가 쓴다. 글자 조각은 원소가 아니므로 세지 않는다.
    prepend(...cs) { el.children.unshift(...cs.filter((c) => typeof c === 'object')) },
    replaceChildren() { el.children.length = 0 },
    remove() {},
    addEventListener() {}, removeEventListener() {},
    attrs: {},
    setAttribute(k, v) { el.attrs[k] = String(v) },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    querySelector: () => null,
    textContent: '',
  };
  return el;
}

/**
 * 가짜 시계. `TimerHub` 는 `Date.now()` 와 `setTimeout` 위에 서 있으므로, 그 둘을
 * 쥐면 주기 동작을 **실시간을 기다리지 않고** 결정적으로 잴 수 있다.
 *
 * 실시간 대기로 재면 그 검사는 느리고 흔들린다 — e2e 의 `waitForTimeout` 224회가
 * 그렇게 생겼다 (`05-test.md §3.2`).
 */
/** 대기 중인 마이크로태스크를 전부 비운다. */
const drain = () => new Promise((r) => setImmediate(r));

export function fakeClock(start = 1_700_000_000_000) {
  let now = start, seq = 0;
  const timers = new Map();
  const clock = {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (+ms || 0), fn }); return id },
    clearTimeout: (id) => { timers.delete(id) },
    Date: class extends Date {
      static now() { return now }
    },
    now: () => now,
    /**
     * ms 만큼 흘린다. 그 사이에 걸린 타이머를 시각 순서대로 돌린다.
     *
     * **비동기다.** `TimerHub._fire` 는 `await job.run(ctx)` 를 지나므로 다음
     * 마감을 거는 `_arm` 이 마이크로태스크로 밀린다. 동기 루프로 흘리면 그
     * 재무장이 아직 일어나지 않은 상태에서 다음 타이머를 찾게 되어, 주기 job 이
     * 한 번만 돌고 멈춘 것처럼 보인다.
     */
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await drain();
      }
      now = until;
      await drain();
    },
    pending: () => timers.size,
  };
  return clock;
}

/**
 * `web/js` 아래의 스크립트들을 **하나의 스크립트로 이어** 싣는다.
 *
 * 이어 붙이는 것이 핵심이다. 브라우저의 클래식 `<script>` 들은 **하나의 전역
 * 렉시컬 환경**을 공유하므로, A 파일의 `const X` 를 B 파일이 그대로 본다.
 * `vm.Script` 를 파일마다 따로 돌리면 그 공유가 사라져 `X is not defined` 가
 * 난다 — 브라우저에서 나지 않는 오류를 검사가 만들어 내는 셈이다.
 *
 * 같은 이유로 최상위 `const`·`let`·`class` 는 `globalThis` 의 속성이 **아니다**
 * (그것은 `var` 와 함수 선언만 그렇다). 그래서 꺼내 볼 이름을 `expose` 로 받아
 * 같은 스크립트 끝에서 전역에 얹는다.
 *
 * @param {string[]} files `web/js` 기준 상대 경로. **`web/bundles.txt`(와 index.html)의 로드 순서와 같은 순서로 준다.**
 * @param {object} [opts]
 * @param {string[]} [opts.expose] 꺼내 볼 최상위 `const`/`class` 이름들.
 * @param {object} [opts.globals] 싣기 **전에** 세워 둘 전역. 실으려는 파일이 제
 *   앞 파일의 전역에 **대입**할 때 쓴다 (`ui/themes.js` 끝줄의 `TOPTS.theme=…`).
 *   그 한 줄 때문에 `core/constants.js` 를 통째로 끌고 오면 검사 대상이 실제로
 *   무엇에 기대는지가 감춰진다 — 최소 대역이라는 이 하네스의 규약과 같은 이유다.
 * @param {ReturnType<typeof fakeClock>} [opts.clock]
 * @returns 컨텍스트. 함수 선언과 `expose` 한 이름이 속성으로 보인다.
 */
export function load(files, opts = {}) {
  const clock = opts.clock || fakeClock();
  const ctx = vm.createContext({ ...browserStub(clock), ...(opts.globals || {}), _clock: clock });
  ctx.globalThis = ctx;
  ctx.window = ctx;

  const parts = [];
  // 묶음 상수 둘이 같은 파일(예: `core/screens.js` — GIT·EDITOR)을 함께 들 수 있다. 한 번만 싣는다.
  // 등록부 대역(`globals.Screens`, 예: SCREENS_LOADED)을 주면 실물 `core/screens.js` 는 싣지 않는다 — 같은 이름이 둘이 된다.
  const skip = opts.globals && opts.globals.Screens ? 'core/screens.js' : null;
  for (const rel of new Set(files)) {
    if (rel === skip) continue;
    // 실패한 줄을 찾을 수 있게 경계를 남긴다. 이어 붙이므로 스택의 줄 번호는
    // 합친 소스의 것이다.
    parts.push('/* ==== web/js/' + rel + ' ==== */');
    parts.push(readFileSync(join(JS_ROOT, rel), 'utf8'));
  }
  const expose = opts.expose || [];
  if (expose.length) {
    parts.push(';Object.assign(globalThis, { ' + expose.join(', ') + ' });');
  }
  new vm.Script(parts.join('\n'), { filename: 'web/js/<' + files.join('+') + '>' }).runInContext(ctx);
  return ctx;
}

/**
 * vm 컨텍스트의 값을 **호스트 실인(realm)의 값**으로 옮긴다.
 *
 * `vm.createContext` 는 새 실인을 만들므로 그 안의 배열·객체는 호스트의
 * `Array.prototype` 을 갖지 않는다. `assert.deepStrictEqual` 은 프로토타입까지
 * 보므로, 내용이 같아도 실패한다 — 출력에 `actual [1,1]` 과 `expected [1,1]` 이
 * 나란히 찍히는 그 모양이다.
 *
 * 느슨한 `deepEqual` 로 내리면 그 문제는 사라지지만 `'1'` 과 `1` 을 같다고 하므로
 * 검사가 약해진다. 옮기고 나서 엄격하게 보는 쪽이 옳다.
 */
export function plain(v) {
  return structuredClone(v);
}

/**
 * 터미널 칸의 채널 대역 (PERF_OPTIMIZATION_SRS M1 C5). 옛 칸별 소켓 시험이 쓰던 모양을 그대로 준다 —
 * `term.open` 시도마다 의사 소켓 하나가 `opened` 에 서고, `openSock(ws)` 가 그 시도를 받아들이며
 * (`readyState` 1, 서버 `hello`), `dropSock(ws)` 가 그 터미널만 끊는다(`term.lost`). `ws.sent` 에는
 * sid 를 뗀 옛 프레임(`[op][payload]`)이 쌓이고, `ws.open` 은 보낸 `term.open` 본문이다.
 *
 * `load` 의 `expose` 에 `'TERM_MUX'` 를 넣어야 한다.
 */
export function fakeTermChannel(ctx) {
  const opened = [];
  const raw = new Map();
  const bins = [];
  let accept = null;
  const fire = (t, m) => { for (const fn of raw.get(t) || []) fn(Object.assign({ t }, m)) };
  const ch = {
    ready: () => true,
    send(v) {
      if (v.t === 'term.close') { const w = opened.find((x) => x.sid === v.sid && x.readyState === 1); if (w) { w.readyState = 3; w.closed++ } return true }
      if (v.t !== 'term.open') return true;
      if (accept && accept.sid === undefined) {
        accept.sid = v.sid; accept.open = v; accept.readyState = 1; accept = null;
        return true;
      }
      opened.push({ sid: v.sid, open: v, readyState: 0, closed: 0, sent: [] });
      return false;
    },
    sendBinary(u8) {
      const sid = new DataView(u8.buffer, u8.byteOffset, u8.length).getUint32(1, false);
      const w = opened.findLast((x) => x.sid === sid && x.readyState === 1);
      if (!w) return false;
      const m = new Uint8Array(u8.length - 4);
      m[0] = u8[0]; m.set(u8.subarray(5), 1);
      w.sent.push(m);
      return true;
    },
    on(t, fn) { if (!raw.has(t)) raw.set(t, []); raw.get(t).push(fn); return { stop() {} } },
    onBinary(fn) { bins.push(fn); return { stop() {} } },
  };
  ctx.TERM_MUX.attach(ch);
  return {
    ch, opened,
    openSock(w) { accept = w; w.sid = undefined; fire('hello', {}); if (accept === w) accept = null },
    dropSock(w) { w.readyState = 3; fire('term.lost', { sid: w.sid }) },
    frame(w, op, payload = []) {
      const b = new Uint8Array(5 + payload.length);
      b[0] = op; new DataView(b.buffer).setUint32(1, w.sid, false); b.set(payload, 5);
      for (const fn of bins) fn(b);
    },
  };
}
