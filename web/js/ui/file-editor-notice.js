/**
 * FileEditorNotice — 편집기 칸의 알림 줄(`note`)과 언어 서버 제안 띠(`offer`) (EDITOR_LSP_SRS FR-LSP-28·44·45).
 *
 * `FileEditor` 의 부품이다 (REFACTOR3_FE_REST5_SRS FR-FR5-21). 칸은 `note`·`offer`·`offerClose` 를 위임자로 남긴다 —
 * 앱(`lsp-client.js`·편집기 문서)과 e2e 가 칸에서 부른다. 띠를 닫는 버튼은 칸의 `offerClose` 를 지난다.
 */
class FileEditorNotice {
  constructor(ed) {
    this.ed = ed;
    this.noteEl = null;
    this.noteT = null;
    this.offerEl = null;
    this.offerRo = null;
  }

  /**
   * EDITOR_LSP_SRS FR-LSP-28 / D-9: **침묵은 고장과 구별되지 않는다.**
   *
   * 코드 탐색은 안 되는 경우가 많다 — 서버 없음, 툴체인 없음, 기동 실패, 시간
   * 초과, 결과 없음. 그 다섯이 모두 "아무 일도 일어나지 않음" 으로 보이면 사용자는
   * 전부 우리 버그로 읽는다. 짧은 알림 줄 하나가 그것을 가른다.
   *
   * 자리는 찾기 패널과 같은 규약이다 (편집기 우상단) — 새 개념을 만들지 않는다.
   */
  // `action` 이 있으면 버튼 하나를 함께 둔다(`{label, run}`) — 그 알림은 눌러야 하므로
  // 더 오래 남는다.
  note(text, ms, action) {
    if (!text) return;
    if (!this.noteEl) {
      const el = document.createElement('div');
      el.className = 'fe-note';
      this.ed.el.appendChild(el);
      this.noteEl = el;
    }
    this.noteEl.textContent = text;
    this.noteEl.classList.toggle('fe-note-act', !!action);
    if (action) {
      this.noteEl.appendChild(UIKit.button({ label: action.label, size: 'sm', cls: 'fe-note-btn',
        onClick: () => { this.noteEl.classList.remove('vis'); action.run() } }));
    }
    // FR-TOK-22: 같은 층에서 겹치는 순서는 DOM 이 정한다 — 보일 때 맨 뒤로
    // 옮긴다 (`file-editor-find.js` 의 `findOpen` 이 같은 규약이다).
    this.ed.el.appendChild(this.noteEl);
    this.noteEl.classList.add('vis');
    TIMERS.cancel(this.noteT);
    // 스스로 사라진다 — 닫는 조작을 배워야 하는 알림은 알림이 아니라 창이다.
    this.noteT = TIMERS.after(ms || FE_NOTE_MS, () => {
      if (this.noteEl) this.noteEl.classList.remove('vis');
    }, {owner:this.ed,label:'note-hide'});
  }

  /**
   * EDITOR_LSP_SRS FR-LSP-44·45: 언어 서버가 없을 때의 제안.
   *
   * 알림 줄(`note`)과 **다른 것이다** — 이것은 스스로 사라지지 않고 버튼을 갖는다.
   * 사용자가 무언가를 해야 하는 알림과 그냥 알리는 알림은 같은 모양일 수 없다.
   */
  offer(st) {
    if (!st || this.offerEl) return;
    const el = document.createElement('div');
    el.className = 'ui-notice fe-offer';
    el.dataset.id = st.id;
    // 받을 수 없을 때의 사유는 **서버가 사람의 말로 적어 보낸다** (FR-EXT-29) —
    // 화면이 다시 쓰면 서버가 아는 사유와 사용자가 읽는 문장이 갈린다.
    const body = st.canInstall
      ? josa(LSP_OFFER_BODY.replace('%s', st.id))
      : josa((st.note || LSP_OFFER_BLOCKED).replace('%s', st.id));
    // 마크업에 잇는 것은 **이름 붙인 값**이다 — 속성 접근이 마크업 안에 그대로
    // 들어가면 `check-html.sh` 가 그것을 값으로 보고 막는다 (FE-16·17 의 규칙).
    const actBtn = st.canInstall
      ? '<button type="button" class="ui-btn ui-btn-sm ui-btn-primary fe-offer-go">' + LSP_OFFER_INSTALL + '</button>'
      : '<button type="button" class="ui-btn ui-btn-sm fe-offer-set">' + LSP_OFFER_SETTINGS + '</button>';
    el.innerHTML =
      '<span class="fe-offer-msg"></span>' +
      actBtn +
      '<button type="button" class="ui-btn ui-btn-sm fe-offer-no">' + LSP_OFFER_DISMISS + '</button>';
    // 사유는 텍스트 노드로 넣는다 — 서버가 보낸 이름이 그 자리에 닿는다.
    el.querySelector('.fe-offer-msg').textContent = body;
    this.ed.el.appendChild(el);
    this.offerEl = el;
    // 종전에는 여기서 `fe-offered` 표식을 남겨 렌더 진입 손잡이를 아래로 내려
    // 앉혔다. **U-2 로 그 손잡이가 좌하단으로 내려가면서 자리를 다투지 않게 됐다** —
    // 표식이 가리키던 규칙이 사라졌으므로 표식도 함께 걷는다.
    //
    // 찾기 줄·알림 줄은 여전히 내려 앉는다. 그 둘은 형제 선택자(`.fe-offer ~ …`)로
    // 닿으므로 표식이 필요 없다.
    /**
     * EDITOR_LSP_SRS FR-LSP-44a (2026-09-08 접수): **띠의 높이는 고정이 아니다.**
     *
     *   이전 동작: 아래로 내려 앉는 값이 `38px` 로 박혀 있었다 — 띠가 한 줄이라는
     *              가정이다
     *   새  동작: 실제 높이를 재어 `--fe-offer-h` 로 넘긴다
     *   이유:     390px 폭에서 안내가 두세 줄로 접히면 띠가 38px 을 넘고, 그러면
     *              `◈ 미리보기` 손잡이를 **그대로 덮는다** — 눌러도 띠가 먹는다
     *              (CI ubuntu 실측: 그 러너에는 markdown 서버가 없어 띠가 늘 선다)
     *
     * 폭이 바뀌면 줄 수도 바뀌므로 한 번 재는 것으로는 모자라다. 관측을 띠와 같은
     * 수명으로 두고 `offerClose` 에서 함께 놓는다.
     */
    this.measure();
    if (typeof ResizeObserver === 'function') {
      this.offerRo = new ResizeObserver(() => this.measure());
      this.offerRo.observe(el);
    }

    const go = el.querySelector('.fe-offer-go');
    if (go) {
      go.addEventListener('click', () => {
        go.disabled = true;
        go.textContent = LSP_INSTALLING;
        // 조달의 단위는 **팩**이다 (FR-EXT-5·31) — 서버 id 로 부르면 다섯을 내는
        // 팩에서 아무것도 받지 못한다.
        if (window.app) window.app.lspClient().lspOfferInstall(st.pack || st.id, this.ed);
      });
    }
    const set = el.querySelector('.fe-offer-set');
    if (set) {
      set.addEventListener('click', () => {
        // 받을 수 없을 때의 다음 걸음은 설정창이다 — 거기에 무엇이 없는지와
        // 어디서 찾았는지가 다 있다.
        if (window.app) window.app.settings._openSettings('code');
        this.ed.offerClose();
      });
    }
    // UX_AUDIT_FIX_SRS FR-UXF-82: 닫는 길은 둘(받기·나중에)이다. "제안함" 기록은 띠가 설 때
    // 이미 남았다(`lspOfferFor`) — 다시 열려면 상태바 표식을 누른다(FR-UXF-83).
    el.querySelector('.fe-offer-no').addEventListener('click', () => this.ed.offerClose());
  }

  // FR-LSP-44a: 띠가 지금 먹고 있는 높이. 이 값 하나로 손잡이·찾기 줄·알림 줄이
  // 다 같이 내려 앉는다 (`style-editor.css`·`style-docrender.css`).
  measure() {
    if (!this.offerEl) return;
    this.ed.el.style.setProperty('--fe-offer-h', this.offerEl.offsetHeight + 'px');
  }

  close() {
    if (!this.offerEl) return;
    if (this.offerRo) { this.offerRo.disconnect(); this.offerRo = null }
    this.offerEl.remove();
    this.offerEl = null;
    this.ed.el.style.removeProperty('--fe-offer-h');
  }

  // FR-LSP-44a: 띠의 관측은 띠와 같은 수명이다. 닫히지 않은 채 뷰가 파괴되면 `close` 를 지나지 않으므로 칸의
  // `destroy` 가 이것을 부른다.
  release() {
    if (this.offerRo) { this.offerRo.disconnect(); this.offerRo = null }
  }
}
