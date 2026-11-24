/**
 * 문서 렌더 뷰 — 문서를 사람이 보는 모습으로 그린다 (DOC_RENDER_VIEW_SRS 묶음 C·D).
 *
 * **이것은 LSP 와 무관하다** (그 SRS §2.14). 언어 서버는 문서를 그려 주지 않으며,
 * 이 뷰는 언어 서버가 하나도 없어도 동작한다. 렌더러·정화기·하이라이터는 전부
 * `vendor/` 에 있다 (FR-DRV-21) — 정화기를 남의 서버에서 받아 오는 것은 그 서버가
 * 우리 화면의 보안을 정하게 하는 일이다.
 *
 * 뷰 계약은 `FileEditor` 와 같다 (FR-DRV-32): `el`·`focus()`·`refresh()`·
 * `destroy()`·`_dirty`·`applyWordWrap()`. `fileEditors` Map 하나가 두 종류의 뷰를
 * 함께 쥐므로(D-1), 그 Map 을 훑는 자리들이 종류를 묻지 않아도 된다.
 */

class DocRender {
  constructor(id, name, filePath) {
    this.id = id;
    this.name = name;
    this.filePath = filePath;
    // 이 뷰가 무엇인지 스스로 안다 — 훑는 쪽이 `instanceof` 를 쓰지 않아도 된다.
    this.render = true;
    // FR-DRV-1: 종류는 확장자가 정한다. 표는 `constants-docrender.js` 한 자리다.
    this.kind = docRenderKindOf(filePath);
    // 이 문서가 속한 Editor 루트. `/` 로 시작하는 참조의 기준이자 루트 밖 판정의
    // 기준이다 (FR-DRV-25·26).
    this.fsRoot = (typeof app !== 'undefined' && app && app.editor?.docRender.docRenderRootOf)
      ? app.editor.docRender.docRenderRootOf(filePath) : '';
    this.el = document.createElement('div');
    this.el.className = 'doc-render';
    this.el.tabIndex = 0;
    this.el.innerHTML =
      '<div class="dr-bar">' +
        // UX_AUDIT_FIX_SRS FR-UXF-100: 앞의 꺾쇠는 아이콘이다(이전 카탈로그 글자 `‹`).
        '<button type="button" class="ui-btn ui-btn-sm dr-source" title="' + DOC_RENDER_SOURCE_TITLE + '">' +
          UIKit.iconHTML('arrow-left') + DOC_RENDER_SOURCE + '</button>' +
        '<span class="dr-path"></span>' +
      '</div>' +
      // UX_BATCH8_SRS FR-SCR-2: 스크롤 표면은 키트의 것이다 (`.ui-scroll`).
      '<div class="dr-body ui-scroll"><div class="dr-note">' + DOC_RENDER_LOADING + '</div></div>';
    this._body = this.el.querySelector('.dr-body');
    this.el.querySelector('.dr-path').textContent = name || '';
    // FR-DRV-6: **같은 버튼이 되돌린다.** 렌더를 켠 손이 끄는 법을 따로 배우지 않는다.
    this.el.querySelector('.dr-source').addEventListener('click', () => {
      if (window.app && window.app.editor?.docRender.docRenderToSource) window.app.editor.docRender.docRenderToSource(this);
    });
    // 편집기 안의 키가 밖으로 나가지 않는 것과 같은 규약 — 여기서 앱 단축키가
    // 끼어들면 스크롤 중에 창이 바뀐다.
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    // FR-DRV-28: 링크의 대상에 따라 다르게 움직인다.
    this._body.addEventListener('click', (e) => this._onLinkClick(e));

    // FR-DRV-40: 문서를 딛는다. 뷰가 문서의 `views` 에 드는 것도 `FileEditor` 와
    // 같은 규약이며, 그래야 `edDocDrop` 이 수명을 셀 수 있다 (FR-SVS-55).
    this._doc = (typeof app !== 'undefined' && app && app.editor?.open.edDoc) ? app.editor.open.edDoc(filePath) : null;
    if (this._doc) this._doc.views.add(this);
    this._buf = null;
    this._sub = null;
    this._timer = null;
    this._gen = 0;
    this._bindBuf(this._findBuf());
    this._paint();
  }

  // FR-DRV-35: 렌더 탭은 저장할 것이 없다. 문서의 dirty 를 물려받지 않는다 —
  // 물려받으면 렌더 탭만 열어 둔 창이 저장 확인에 걸린다 (FR-WBR-40).
  get _dirty() { return false }
  set _dirty(_v) { /* 렌더 뷰는 편집하지 않는다 (FR-DRV-19) */ }

  /**
   * 이 파일의 문서 버퍼(`EdBuffer`). 문서는 경로로 찾으므로(FR-SVS-50 의 규약) 편집기를
   * 거치지 않고 여기서 직접 찾을 수 있다 — 그래서 이 뷰는 편집기가 있는지 없는지 몰라도 된다.
   */
  _findBuf() {
    const d = (typeof app !== 'undefined' && app && app.editor?.doc.edDocAt) ? app.editor.doc.edDocAt(this.filePath) : null;
    return (d && d.buf) || null;
  }

  // 소스 탭이 **나중에** 열려 버퍼가 생겼을 때 app 이 알려준다. 그 통지가 없으면
  // 이 뷰는 디스크의 내용에 머문다.
  onDocBuf(buf) {
    if (!buf || buf === this._buf) return;
    this._bindBuf(buf);
    this._schedule(0);
  }

  _bindBuf(b) {
    if (this._sub) { this._sub(); this._sub = null }
    this._buf = b || null;
    // FR-DRV-42: 편집을 구독한다. 지연은 `_schedule` 이 준다. 잠든 뷰는 깰 때 구독한다(PERF 3.5.3).
    if (b && !this.asleep) this._sub = b.onChange(() => this._schedule());
  }

  _schedule(ms) {
    // PERF 3.5.3: 잠든 뷰는 예약하지 않고 깰 때 그린다(`ui/editor-view-life.js`).
    if (this.asleep) { this._sleptVer = -1; return }
    TIMERS.cancel(this._timer);
    this._timer = TIMERS.after(ms == null ? DOC_RENDER_DEBOUNCE_MS : ms, () => this._paintIfShown(), {owner:this, label:'doc-paint'});
  }

  /**
   * OPTIMIZE_REFACTOR_SRS FR-OPT-12-6 (FEU-11): 가려진 탭(`.vis` 없음)은 그리지 않고 표식만
   * 남긴다 — 렌더는 markdown → 정화 → innerHTML 전체라 편집마다 돌기에 비싸다. 다시 보일 때
   * (`restoreView` — 가려진 탭은 문서에서 떼였으므로 보일 때 언제나 그 길을 지난다) 그린다.
   */
  _paintIfShown() {
    if (!this.el.classList.contains('vis')) { this._stale = true; return }
    this._paint();
  }

  /**
   * FR-DRV-40·41: **문서가 진실이고 디스크는 낡았다.** 버퍼가 있으면 그것을 읽고,
   * 없으면(소스 탭이 닫힌 렌더 탭) 파일을 읽는다.
   */
  async _text() {
    if (this._buf) return this._buf.value();
    // REPO_FIX 03 §3A-3·3A-5: 파일을 직접 읽지 않는다 — 문서가 판별·변환해 버퍼를
    // 만든다(첫 뷰가 렌더 탭이어도 버퍼가 생긴다). 인코딩 계약이 소스와 같아진다.
    //   이전 동작: `/api/file/read` 원문을 UTF-8 로 풀었다 — CP949 문서가 깨졌다
    const buf = (typeof app !== 'undefined' && app && app.editor?.doc.edDocLoad) ? await app.editor.doc.edDocLoad(this.filePath) : null;
    if (!buf) throw new Error('document not loaded');
    if (buf !== this._buf) this._bindBuf(buf);
    return buf.value();
  }

  _note(text) {
    this._body.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'dr-note';
    d.textContent = text;
    this._body.appendChild(d);
  }

  async _paint() {
    /**
     * **늦게 시작한 그리기가 먼저 끝날 수 있다.**
     *
     * `_schedule` 의 `clearTimeout` 은 아직 시작하지 않은 예약만 취소한다. 모델이
     * 없는 렌더 탭(소스 탭을 닫은 뒤)은 `_text()` 에서 파일을 읽으므로 그 사이에
     * 다음 그리기가 시작될 수 있고, 그때 응답 순서가 뒤집히면 **낡은 내용이 화면에
     * 남는다.** 세대를 세어 그 경우를 버린다.
     */
    const gen = ++this._gen;
    let text = '';
    try {
      text = await this._text();
    } catch (e) {
      console.error('[DocRender] read error:', e);
      if (gen === this._gen) this._note(DOC_RENDER_FAIL);
      return;
    }
    if (gen !== this._gen) return;
    // FR-DRV-17: 그리지 못하면 사유를 말한다 — 빈 화면은 고장과 구별되지 않는다.
    if (text.length > DOC_RENDER_MAX_BYTES) { this._note(DOC_RENDER_TOO_BIG); return }

    // D-4: **종류마다 그리는 법이 다르다.** 하나의 길로 통일하지 않는다 —
    // 통일하려면 가장 위험한 것의 방식으로 나머지를 끌어와야 한다.
    if (this.kind === 'svg') { this._paintSvg(text); return }
    if (this.kind === 'table') { this._paintTable(text); return }
    if (this.kind === 'html') { this._paintHtml(text); return }

    if (!docRenderLibsReady()) { this._note(DOC_RENDER_NO_LIB); return }

    docPurifyHook();
    let html = '';
    try {
      // FR-DRV-20: 렌더 결과는 **정화를 지난다.** `<script>`·`on*`·`javascript:` 가
      // 남지 않는다. 이 한 줄이 이 뷰의 방어선이며, 그래서 정화기가 우리
      // 배포물에 있다 (FR-DRV-21).
      html = DOMPurify.sanitize(docMarkdown().render(text), { ADD_ATTR: ['target'] });
    } catch (e) {
      console.error('[DocRender] render error:', e);
      this._note(DOC_RENDER_FAIL);
      return;
    }
    /**
     * FR-DRV-43: 다시 그려도 자리를 지킨다. 한 글자를 고칠 때마다 문서 처음으로
     * 튀면 그것은 미리보기가 아니다.
     *
     * VIEW_SCROLL_RESTORE_SRS FR-VSR-10: **자리는 바꾸기 직전에 읽는다.**
     *
     *   이전 동작: 함수 머리에서 읽었다 (`_text()` 의 await 앞)
     *   새  동작: `innerHTML` 을 갈아 끼우기 바로 앞에서 읽는다
     *   이유:     그리기는 비동기다. 그 사이에 탭이 다시 붙어 복원이 자리를
     *             놓으면(FR-VSR-3), 늦게 끝난 그리기가 **머리에서 읽은 0** 으로
     *             그것을 덮었다 — 실측으로 그 순서를 밟았다
     *
     * 떼여 있으면 잴 것이 없으므로(0) 갈무리한 자리를 쓴다.
     */
    const top = (this.el.isConnected && this.el.classList.contains('vis'))
      ? this._body.scrollTop : (this._keptTop || 0);
    this._body.innerHTML = html;
    docFixHeadings(this._body);
    docFixImages(this._body, this.filePath, this.fsRoot);
    this._body.scrollTop = top;
    this._applyWant(true);
    this._unwrapBareFiles(gen);
  }

  /** FR-BDL-5: 맨 도메인 링크 중 이 문서 폴더의 파일 이름인 것은 글자로 되돌린다. */
  async _unwrapBareFiles(gen) {
    const as = [...this._body.querySelectorAll('a[data-bare]')];
    if (!as.length) return;
    const files = await bareLinkFiles(as.map((a) => a.textContent), docDirOf(this.filePath));
    if (gen !== this._gen) return;
    for (const a of as) if (files.has(a.textContent)) a.replaceWith(document.createTextNode(a.textContent));
  }

  /**
   * FR-DRV-28: 링크는 셋으로 갈린다.
   *
   * | 대상 | 하는 일 |
   * |---|---|
   * | 문서 안 앵커 (`#제목`) | 이 뷰 안에서 스크롤한다 |
   * | 저장소 안 상대 링크 (`./other.md`) | **그 파일을 탭으로 연다** |
   * | 외부 (`https://…`) | 새 창. 정화 훅이 `target`·`rel` 을 이미 달았다 |
   *
   * 외부만 기본 동작에 맡기고 나머지는 막는 이유는, 우리 화면이 통째로 그 문서로
   * 이동해 버리기 때문이다 — 그러면 편집기도 터미널도 사라진다.
   */
  _onLinkClick(e) {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || /^(https?|mailto):/i.test(href)) return;
    e.preventDefault();
    const hash = href.indexOf('#');
    const target = hash < 0 ? href : href.slice(0, hash);
    const frag = hash < 0 ? '' : href.slice(hash + 1);
    if (!target) { this._goAnchor(frag); return }
    let rel = target;
    try { rel = decodeURIComponent(target) } catch { /* 잘못 인코딩된 링크는 그대로 쓴다 */ }
    const dir = docDirOf(this.filePath);
    const abs = docResolvePath(dir, rel, this.fsRoot);
    // FR-DRV-26: 루트 밖으로는 가지 않는다. `edOpenFile` 도 거절하지만, 거절이
    // 침묵이면 링크가 죽은 것인지 우리가 막은 것인지 갈리지 않는다.
    if (!docInsideRoot(abs, this.fsRoot)) { this._note(DOC_RENDER_OUTSIDE); return }
    if (window.app && window.app.editor?.file.edOpenFile) window.app.editor.file.edOpenFile(abs, {});
  }

  // 앵커. **이 상자 안에서만 움직인다** — `scrollIntoView` 는 조상 스크롤까지
  // 건드려서 창 전체가 밀린다.
  _goAnchor(frag) {
    if (!frag) return;
    let id = frag;
    try { id = decodeURIComponent(frag) } catch { /* 그대로 쓴다 */ }
    let el = null;
    try { el = this._body.querySelector('#' + CSS.escape(id)) } catch { el = null }
    if (!el) return;
    const r = el.getBoundingClientRect();
    const b = this._body.getBoundingClientRect();
    this._body.scrollTop += (r.top - b.top);
  }

  /**
   * FR-DRV-14·23: SVG 는 **`<img>` 로만** 그린다. 인라인 `<svg>` 로 넣으면 그 안의
   * 스크립트가 우리 문서 컨텍스트에서 돈다.
   *
   * 바이트를 `/api/file/raw` 에서 받지 않고 **blob 으로 만들어 붙이는 것이 요점이다**
   * — 그래야 저장하지 않은 편집이 그려진다 (FR-DRV-40). blob 도 `<img>` 안에서는
   * 같은 정지 모드이므로 스크립트는 여전히 돌지 않는다.
   *
   * (`raw` 종단의 SVG 문은 다른 필요다 — Markdown 문서 **안에서** 참조된 `.svg`
   * 이미지가 그 길로 온다. FR-DRV-24.)
   */
  _paintSvg(text) {
    this._revokeBlob();
    this._body.innerHTML =
      '<div class="dr-svg-wrap"><img class="dr-svg" alt=""><div class="dr-svg-meta"></div></div>';
    const img = this._body.querySelector('.dr-svg');
    const meta = this._body.querySelector('.dr-svg-meta');
    const blob = new Blob([text], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    this._blobUrl = url;
    img.addEventListener('load', () => {
      // FR-DRV-14: 크기와 바이트를 함께 적는다 — 이미지 뷰와 같은 규약이다.
      meta.textContent = img.naturalWidth + '×' + img.naturalHeight +
        ' · ' + docFmtBytes(blob.size);
    });
    // FR-DRV-17: 그리지 못하면 사유를 말한다. SVG 가 안 그려지는 흔한 이유는
    // 문서 자신이며(닫히지 않은 태그 등), 그것을 알면 사용자가 고칠 수 있다.
    img.addEventListener('error', () => { meta.textContent = DOC_RENDER_SVG_FAIL });
    img.src = url;
  }

  /**
   * FR-DRV-15·22: HTML 은 **`allow-scripts` 도 `allow-same-origin` 도 없는**
   * sandbox iframe 에 넣는다. 그러므로 문서의 스크립트는 돌지 않고, 그 프레임은
   * 우리 출처의 쿠키·저장소에 닿지 못한다.
   *
   * `sandbox` 를 **빈 값으로** 두는 것이 요점이다 — 값을 하나라도 적으면 그것만
   * 풀리는 것이 아니라 "그것을 허용한다" 가 된다. 빈 값이 가장 조인 상태다.
   *
   * 그리고 **그 사실을 화면에 적는다.** 적지 않으면 스크립트로 그리는 문서가
   * 빈 화면으로 보이고, 그것을 우리 버그로 읽는다 (D-9 와 같은 근거).
   */
  _paintHtml(text) {
    this._body.innerHTML =
      '<div class="dr-html-wrap">' +
        '<div class="dr-html-note"></div>' +
        '<iframe class="dr-html" sandbox referrerpolicy="no-referrer"></iframe>' +
      '</div>';
    this._body.querySelector('.dr-html-note').textContent = DOC_RENDER_HTML_NOTE;
    const fr = this._body.querySelector('.dr-html');
    // FR-DRV-25 는 HTML 에도 걸린다 — 상대 이미지를 우리 종단으로 옮기지 않으면
    // `about:srcdoc` 안에서는 풀 기준이 없어 하나도 보이지 않는다.
    let html = text;
    try {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      docFixImages(doc, this.filePath, this.fsRoot);
      html = '<!doctype html>' + doc.documentElement.outerHTML;
    } catch (e) {
      console.error('[DocRender] html parse error:', e);
    }
    fr.setAttribute('srcdoc', html);
  }

  /**
   * FR-DRV-16: 표로 그린다. 첫 줄이 머리글이다.
   *
   * 정화를 거치지 않는 것은 **DOM 을 우리가 만들기 때문이다** — 값은 전부
   * `textContent` 로 들어가므로 그 안의 `<script>` 는 글자로 남는다. 문자열로 HTML 을
   * 만들어 붙였다면 정화가 필요했을 것이고, 그 경로를 만들지 않는 것이 더 낫다.
   */
  _paintTable(text) {
    const ext = (this.filePath.toLowerCase().match(/(\.[^./\\]+)$/) || [])[1] || '';
    const rows = docParseDelimited(text, DOC_RENDER_DELIM[ext] || ',');
    if (!rows.length) { this._note(DOC_RENDER_TABLE_EMPTY); return }

    const shown = rows.slice(0, DOC_RENDER_TABLE_MAX_ROWS);
    const table = document.createElement('table');
    table.className = 'dr-table';
    for (let r = 0; r < shown.length; r++) {
      const tr = document.createElement('tr');
      const cells = shown[r].slice(0, DOC_RENDER_TABLE_MAX_COLS);
      for (const v of cells) {
        const td = document.createElement(r === 0 ? 'th' : 'td');
        td.textContent = v;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    this._body.innerHTML = '';
    // FR-DRV-29: 잘랐으면 **그 사실을 말한다.**
    if (rows.length > shown.length) {
      const n = document.createElement('div');
      n.className = 'dr-note';
      n.textContent = DOC_RENDER_TABLE_CUT
        .replace('%r', String(rows.length)).replace('%n', String(shown.length));
      this._body.appendChild(n);
    }
    this._body.appendChild(table);
  }

  _revokeBlob() {
    if (!this._blobUrl) return;
    URL.revokeObjectURL(this._blobUrl);
    this._blobUrl = null;
  }

  /**
   * FR-DRV-44: 소스의 그 줄이 보이도록 옮긴다.
   *
   * **그 줄 이하의 마지막 블록**을 고른다 — 정확히 그 줄에서 시작하는 블록이 없는
   * 것이 보통이기 때문이다(문단 한가운데를 보고 있을 때). 그 블록의 머리를 상자
   * 꼭대기에 맞추면 소스에서 보던 자리가 렌더에서도 꼭대기에 온다.
   */
  syncToLine(line) {
    if (this.kind !== 'markdown' || !this._body) return;
    const n = Math.max(1, parseInt(line, 10) || 1);
    let best = null;
    let first = null;
    for (const el of this._body.querySelectorAll('[data-line]')) {
      const v = parseInt(el.getAttribute('data-line'), 10);
      if (!isFinite(v)) continue;
      if (!first) first = el;
      if (v > n) break;
      best = el;
    }
    // 첫 블록 위에는 아무것도 없다. 그 머리를 꼭대기에 맞추려 하면 상자의
    // 위 여백(padding-top + 그 블록의 margin)만큼 밀려, **소스가 첫 줄에 있는데도
    // 렌더는 스크롤된 상태**가 된다. 문서의 처음은 스크롤 0 이다.
    if (!best || best === first) { this._body.scrollTop = 0; return }
    const r = best.getBoundingClientRect();
    const b = this._body.getBoundingClientRect();
    this._body.scrollTop += (r.top - b.top);
  }

  focus() { this.el.focus() }

  // 탭이 다시 활성화되거나 파일이 바뀌었을 때. 버퍼가 그 사이 생겼을 수 있으므로
  // 다시 찾는다.
  refresh() {
    this._bindBuf(this._findBuf());
    // REPO_FIX 03 E-7.1: 외부 변경은 문서가 한 번 읽는다 — 첫 뷰가 이 렌더 탭이어도
    // 소스 버퍼가 갱신된다. 버퍼 갱신은 구독(`onChange`)이 다시 그린다.
    if (typeof app !== 'undefined' && app && app.editor?.doc.edDocRefresh) app.editor.doc.edDocRefresh(this.filePath);
    this._schedule(0);
  }

  // REPO_FIX 03 §3A-5: 문서가 새 경로로 옮겨졌다 — 같은 버퍼에 그대로 붙어 있다.
  onDocMoved(path, buf) {
    this.filePath = path;
    this._bindBuf(buf || this._findBuf());
    this._schedule(0);
  }

  // WORKBENCH_REVIEW_SRS FR-WBR-11 의 대상이 아니다 — 이 뷰에는 줄바꿈 설정이
  // 걸릴 자리가 없다. 계약을 만족시키려 둔다 (FR-DRV-32).
  applyWordWrap() { /* no-op */ }

  /**
   * VIEW_SCROLL_RESTORE_SRS FR-VSR-10·11: 렌더 뷰의 스크롤도 같은 계기로 남는다.
   *
   * 탭 타입은 편집기와 하나이고 실체만 둘이므로(`DOC_RENDER_VIEW_SRS D-1`) 계기를
   * 둘로 만들지 않는다. 이쪽 표면은 평범한 DOM 스크롤러(`.dr-body`)다.
   *
   * 0 은 기록하지 않는다 (`FR-SCR-4` 와 같은 규약).
   */
  keepView() {
    if (!this._body || !this.el.isConnected || !this.el.classList.contains('vis')) return;
    const st = this._body.scrollTop;
    if (st) this._keptTop = st;
  }

  restoreView() {
    if (this._stale) { this._stale = false; this._paint() }
    if (!this._body || !this._keptTop) return;
    this._wantTop = this._keptTop;
    this._applyWant(false);
    // **방금 붙은 요소는 이 프레임에 크기가 없다** — `clientHeight` 가 0 이면
    // `scrollTop` 대입은 0 으로 잘린다(실측: 본문 201개·scrollHeight 6860 인데도
    // 0 이 됐다). 그래서 한 프레임 뒤에 다시 놓는다. 터미널의 사후 처리가
    // `TIMERS.frame` 에 있는 것과 **같은 이유·같은 자리**다 (FR-PDR-10).
    if (this._wantTop) {
      TIMERS.frame(() => this._applyWant(true),
        { owner: this, label: 'doc-view-restore', coalesce: 'view' });
    }
  }

  /**
   * FR-VSR-10: 되돌릴 자리를 **실제로 놓을 수 있을 때** 놓는다.
   *
   * 방금 붙은 뷰의 본문은 비어 있을 수 있다 — 그리기가 비동기이기 때문이다
   * (`_schedule`·`_paint`). 그때 `scrollTop` 대입은 0 으로 잘려 조용히 사라진다.
   * 그래서 놓지 못한 값은 **그리기 한 번까지** 들고 있다가 그 끝에서 놓는다.
   *
   * `final` 은 그 마지막 기회다 — 그 뒤에는 버린다. 영영 들고 있으면 사용자가
   * 스스로 옮긴 자리를 나중의 그리기가 되돌린다.
   */
  _applyWant(final) {
    if (!this._body || !this._wantTop) return;
    this._body.scrollTop = this._wantTop;
    if (final || this._body.scrollTop === this._wantTop) this._wantTop = 0;
  }

  destroy() {
    TIMERS.cancel(this._timer);
    this._revokeBlob();
    if (this._sub) { this._sub(); this._sub = null }
    this._buf = null;
    if (typeof app !== 'undefined' && app && app.editor?.open.edDocDrop) {
      app.editor.open.edDocDrop(this.filePath, this);
    }
    this._doc = null;
    if (typeof app !== 'undefined' && app && app.renderer) app.renderer.life.unmount(this);
  }
}
