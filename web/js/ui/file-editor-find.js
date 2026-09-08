/**
 * Dongminal — 편집기의 파일 내 찾기 패널 (EDITOR_FIND_PANEL_SRS 묶음 B·C·D)
 *
 * `FileEditor` 에서 갈라 나온 주제 하나다 (DRIFT_RECLAIM_SRS FR-DRC-13) — 이
 * 코드베이스가 `FileTree`·`App` 에 이미 쓰는 방식과 같다: 뼈대 클래스는 자기
 * 파일에 남고, 주제는 `Object.assign(X.prototype, …)` 로 얹는다.
 *
 * Monaco 의 find 위젯을 쓰지 않는다 (FR-EFP-25 가 FR-EKB-3 을 개정했다).
 * **검색기는 여전히 Monaco 모델의 것이다** (D-2) — `findMatches` 가 정규식·
 * 대소문자·단어 단위를 이미 전부 받으므로 우리가 만드는 것은 껍데기뿐이다.
 *
 * `file-editor.js` 뒤에 실려야 한다 — 얹을 prototype 이 그때 있다.
 */
Object.assign(FileEditor.prototype, {
  /**
   * FR-EFP-4: Monaco 의 find 위젯을 **여는 모든 키를 닫는다.**
   *
   * `Mod+F` 만 막아도 위젯은 여전히 열린다 (SRS §2.6) — `Mod+H`(바꾸기)·
   * `Mod+E`(선택으로 찾기)·`F3`·`Mod+G`(다음 일치)가 각자 그것을 세운다. 길을
   * 하나만 닫으면 나머지로 들어오고, 그러면 §2.4 의 결함이 그 키들에 남는다.
   *
   * **인스턴스별로 건다** (`monaco.editor.addKeybindingRules` 가 아니다). 그 전역
   * 규칙은 Git 의 diff 뷰에도 걸리는데, 그 뷰에는 우리 패널이 없다 — 거기서
   * 되던 것을 아무것도 되지 않게 만든다 (SRS §2.12 / D-5b). 우리가 닫으려는
   * 것은 **이 편집기의** 위젯이다.
   *
   * 이것은 D-5 의 이중 안전장치다. 첫 겹은 `el` 의 capture 리스너이며 사용자가
   * 배정한 조합을 잡는다. 이 겹이 맡는 것은 **아무 동작에도 배정되지 않은** 조합이다.
   */
  _findKillMonacoKeys() {
    if (!this._editor || typeof monaco === 'undefined') return;
    const M = monaco.KeyMod, K = monaco.KeyCode;
    const noop = () => {};
    const kill = [
      M.CtrlCmd | K.KeyF,               // 찾기
      M.CtrlCmd | K.KeyH,               // 바꾸기 (Windows·Linux)
      M.CtrlCmd | M.Alt | K.KeyF,       // 바꾸기 (macOS)
      M.CtrlCmd | K.KeyE,               // 선택으로 찾기 (macOS)
      M.CtrlCmd | K.F3,                 // 선택으로 찾기 (Windows·Linux)
      K.F3,                             // 다음 일치
      M.Shift | K.F3,                   // 이전 일치
      M.CtrlCmd | K.KeyG,               // 다음 일치 (macOS)
      M.CtrlCmd | M.Shift | K.KeyG,     // 이전 일치 (macOS)
    ];
    for (const kb of kill) this._editor.addCommand(kb, noop);
  },

  _findVis() { return !!(this._find && this._find.classList.contains('vis')) },

  /**
   * FR-EFP-8 / D-3: 패널은 **이 인스턴스의 것**이며 이 인스턴스의 `el` 안에 산다.
   * 앱이 하나를 갖고 돌려 쓰면 두 칸이 같은 질의를 공유하는데, 칸마다 다른 자리를
   * 보고 있으므로 "현재 일치" 가 어느 칸의 것인지 정해지지 않는다.
   *
   * `.file-editor` 는 이미 `position:absolute` 이므로(SRS §2.8) 오버레이가 이 칸의
   * 편집기에만 얹힌다 — 새 좌표계를 만들 필요가 없다.
   */
  _findEnsure() {
    if (this._find) return this._find;
    const opt = (k, label, title) =>
      '<button type="button" class="fe-find-opt" data-opt="' + k + '" title="' + title + '">'
      + label + '</button>';
    const p = document.createElement('div');
    p.className = 'fe-find';
    p.innerHTML =
      '<input class="fe-find-q" type="text" spellcheck="false" autocomplete="off"'
      + ' placeholder="' + ED_FIND_IN_PLACEHOLDER + '">'
      + '<span class="fe-find-count"></span>'
      + opt('case', ED_FIND_OPT_CASE, ED_FIND_OPT_CASE_TITLE)
      + opt('regex', ED_FIND_OPT_REGEX, ED_FIND_OPT_REGEX_TITLE)
      + opt('word', ED_FIND_OPT_WORD, ED_FIND_OPT_WORD_TITLE)
      + '<button type="button" class="ui-btn ui-btn-icon ui-btn-ghost fe-find-prev" title="' + ED_FIND_PREV_TITLE + '" aria-label="' + ED_FIND_PREV_TITLE + '">' + UIKit.iconHTML('arrow-up') + '</button>'
      + '<button type="button" class="ui-btn ui-btn-icon ui-btn-ghost fe-find-next" title="' + ED_FIND_NEXT_TITLE + '" aria-label="' + ED_FIND_NEXT_TITLE + '">' + UIKit.iconHTML('arrow-down') + '</button>'
      + '<button type="button" class="ui-btn ui-btn-icon ui-btn-ghost fe-find-close" title="' + ED_FIND_CLOSE_TITLE + '" aria-label="' + ED_FIND_CLOSE_TITLE + '">' + UIKit.iconHTML('x') + '</button>';
    this.el.appendChild(p);
    this._find = p;
    this._findOpts = edFindOptsLoad();
    this._findHits = [];
    this._findCur = 0;
    this._findWire(p);
    this._findPaintOpts();
    return p;
  },

  _findWire(p) {
    const q = p.querySelector('.fe-find-q');
    q.addEventListener('input', () => { this._findCur = 0; this._findRun() });
    q.addEventListener('keydown', (e) => {
      // FR-EFP-11: 패널 안에서 누른 키는 밖으로 나가지 않는다 — 앱 단축키가
      // 끼어들면 타이핑 중에 창이 바뀐다. (검색 키 자신은 `el` 의 capture
      // 리스너가 이미 지나갔으므로 FR-EFP-12 의 다시 열기는 여전히 듣는다.)
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.findClose(); return }
      if (e.key === 'Enter') { e.preventDefault(); this._findMove(e.shiftKey ? -1 : 1) }
    });
    for (const b of p.querySelectorAll('.fe-find-opt')) {
      b.addEventListener('click', () => {
        const k = b.dataset.opt;
        this._findOpts[k] = !this._findOpts[k];
        edFindOptsSave(this._findOpts);
        this._findPaintOpts();
        // FR-EFP-22: 옵션을 바꾸면 즉시 다시 검색한다. 처음 일치로 돌아가는
        // 이유는 옵션이 바뀌면 일치의 집합 자체가 달라지기 때문이다.
        this._findCur = 0;
        this._findRun();
        q.focus();
      });
    }
    p.querySelector('.fe-find-prev').addEventListener('click', () => { this._findMove(-1); q.focus() });
    p.querySelector('.fe-find-next').addEventListener('click', () => { this._findMove(1); q.focus() });
    p.querySelector('.fe-find-close').addEventListener('click', () => this.findClose());
  },

  _findPaintOpts() {
    for (const b of this._find.querySelectorAll('.fe-find-opt')) {
      b.classList.toggle('on', !!this._findOpts[b.dataset.opt]);
    }
  },

  /**
   * FR-EFP-13: 편집기가 없는 탭(이진 파일·이미지·로딩 중)에서는 열지 않는다.
   * **거짓을 돌려주는 것이 계약이다** — 부르는 쪽이 그것을 보고 키를 삼키지 않는다.
   *
   * FR-EFP-5: 여기서 `ed.focus()` 를 부르지 않는다. 그것이 §2.3 의 결함이었다.
   * 패널을 여는 일은 **패널에** 포커스를 주는 일이다.
   *
   * FR-EFP-12: 이미 열려 있을 때 다시 불러도 닫지 않는다 — 질의 칸을 다시 고른다.
   */
  findOpen() {
    if (!this._editor) return false;
    const p = this._findEnsure();
    const q = p.querySelector('.fe-find-q');
    // FR-EFP-9: 한 줄 안의 선택 영역은 질의로 싣는다. 여러 줄은 싣지 않는다 —
    // 줄바꿈이 든 질의는 이 패널이 찾을 수 있는 것이 아니다.
    const sel = this._editor.getSelection();
    if (sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) {
      q.value = this._editor.getModel().getValueInRange(sel);
      this._findCur = 0;
    }
    p.classList.add('vis');
    q.focus();
    // 전체 선택해 둔다 — 한 번의 타이핑으로 다른 말로 갈아 칠 수 있어야 한다.
    q.select();
    this._findRun();
    return true;
  },

  findClose() {
    const p = this._find;
    if (!p) return;
    p.classList.remove('vis');
    p.classList.remove('bad-re');
    this._findHits = [];
    this._findCur = 0;
    this._findPaint();  // FR-EFP-18: 하이라이트를 걷는다
    // FR-EFP-10: 사용자가 방금까지 보고 있던 자리로 포커스를 돌린다.
    if (this._editor) this._editor.focus();
  },

  /**
   * 질의를 지금 문서에 대고 일치를 다시 센다.
   *
   * `keep` 은 문서가 바뀌어 다시 세는 경우다 (FR-EFP-17) — 그때 현재 자리를 0 으로
   * 되돌리면 편집할 때마다 시선이 문서 처음으로 튄다. 일치 수가 줄었을 수 있으므로
   * 범위 안으로 접어 넣는다.
   */
  _findRun(keep) {
    const p = this._find;
    if (!p || !this._editor) return;
    const model = this._editor.getModel();
    const query = p.querySelector('.fe-find-q').value;
    const o = this._findOpts;
    p.classList.remove('bad-re');

    if (!query || !model) {
      this._findHits = [];
      this._findCur = 0;
      this._findPaint();
      this._findCount('');
      return;
    }
    // FR-EFP-24: 잘못된 정규식을 조용히 0건으로 보이면 사용자가 없는 줄로 읽는다.
    if (o.regex && !edFindReOk(query)) {
      this._findHits = [];
      this._findCur = 0;
      p.classList.add('bad-re');
      this._findPaint();
      this._findCount(ED_FIND_BAD_RE);
      return;
    }
    // FR-EFP-21 / D-2: 세 옵션이 이 호출의 인자로 그대로 간다. 단어 단위를 끈
    // 상태는 구분자를 **보지 않는 것**이므로 `null` 이다.
    const found = model.findMatches(
      query, false, !!o.regex, !!o.case,
      o.word ? ED_FIND_WORD_SEPARATORS : null,
      false, ED_FIND_MAX_HITS);
    this._findHits = found.map(m => m.range);
    const n = this._findHits.length;
    this._findCur = n ? (keep ? Math.min(this._findCur, n - 1) : this._findCur) : 0;
    this._findPaint();
    this._findCount(n ? (this._findCur + 1) + '/' + n : ED_FIND_NONE);
  },

  // FR-EFP-16: 질의가 비면 수를 말하지 않는다 — 아직 묻지 않은 것이다.
  _findCount(text) {
    const el = this._find && this._find.querySelector('.fe-find-count');
    if (el) el.textContent = text;
  },

  /**
   * FR-EFP-14: 모든 일치를 하이라이트하고 현재 일치는 **그 위에 한 겹 더** 얹는다.
   * 둘이 같은 표시를 받으면 이전/다음이 무엇을 옮겼는지 보이지 않는다.
   */
  _findPaint() {
    if (!this._editor) return;
    if (!this._findDecos) this._findDecos = this._editor.createDecorationsCollection([]);
    this._findDecos.set((this._findHits || []).map((range, i) => ({
      range,
      options: {
        className: i === this._findCur
          ? ED_FIND_HIT_CLASS + ' ' + ED_FIND_HIT_CUR_CLASS
          : ED_FIND_HIT_CLASS,
      },
    })));
  },

  // FR-EFP-19: 끝에서 돌아 감는다 — 마지막 다음은 처음이다.
  _findMove(d) {
    const n = (this._findHits || []).length;
    if (!n) return;
    this._findCur = (this._findCur + d + n) % n;
    // FR-EFP-15: 화면 밖이면 그 자리로 스크롤한다. 포커스는 옮기지 않는다 —
    // 사용자는 여전히 질의 칸에서 타이핑하고 있다 (FR-EFP-5).
    this._editor.revealRangeInCenterIfOutsideViewport(this._findHits[this._findCur]);
    this._findPaint();
    this._findCount((this._findCur + 1) + '/' + n);
  },
});

/**
 * FR-EFP-23 / D-4: 찾기 옵션은 **기기별**이다 (`localStorage`).
 *
 * 설정 블롭에 사는 값들(`blockBrowserKeys` 등)은 "이 서버가 무엇인가" 를 말한다.
 * 검색 옵션은 그런 값이 아니라 지금 이 손의 버릇이며, 서버에 두면 다른 기계에서
 * 켜 둔 정규식 모드가 따라와 놀라게 된다.
 */
const ED_FIND_OPT_KEYS = ['case', 'regex', 'word'];

function edFindOptsLoad() {
  const o = { case: false, regex: false, word: false };
  let raw = null;
  try { raw = localStorage.getItem(ED_FIND_OPTS_KEY) } catch { raw = null }
  if (!raw) return o;
  let saved = null;
  try { saved = JSON.parse(raw) } catch { saved = null }
  if (!saved || typeof saved !== 'object') return o;
  for (const k of ED_FIND_OPT_KEYS) o[k] = !!saved[k];
  return o;
}

function edFindOptsSave(o) {
  const out = {};
  for (const k of ED_FIND_OPT_KEYS) out[k] = !!o[k];
  try { localStorage.setItem(ED_FIND_OPTS_KEY, JSON.stringify(out)) } catch { /* 사생활 모드 */ }
}

/**
 * FR-EFP-24: 정규식이 쓸 수 있는 것인가.
 *
 * JS 에서 이것을 묻는 길은 생성해 보는 것뿐이다 — 그래서 `try` 가 여기 하나 있고,
 * **이 함수 밖으로 나가지 않는다.** 흐름 제어가 아니라 판정이다.
 */
function edFindReOk(src) {
  try { new RegExp(src); return true } catch { return false }
}

// 테마 전환 훅 (helpers.js applyThemeObj). 이름이 같은 테마를 다시 정의하고
// setTheme 을 부르면 살아 있는 에디터와 diff 뷰가 함께 따라온다 (FR-GIT-49).
FileEditor.applyTheme = function() {
  if (typeof monaco === 'undefined') return;
  // EDITOR_DIRTY_DIFF_SRS FR-EDD-23b: 변경 표시의 색도 CSS 변수에서 왔으므로
  // 여기서 함께 다시 세운다. 두 번째 테마 훅을 만들지 않는다.
  if (typeof edDdReset === 'function') edDdReset();
  if (window.app && window.app._edDirtyDiffRepaint) window.app._edDirtyDiffRepaint();
  const name = monacoTheme();
  if (name !== MONACO_THEME) return;
  monaco.editor.setTheme(name);
};
