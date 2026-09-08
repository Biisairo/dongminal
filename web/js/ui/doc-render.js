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

// markdown-it 인스턴스는 하나다. 문서마다 만들면 규칙 등록이 문서 수만큼 늘어난다.
let docMD = null;
// 정화 훅은 전역이며 한 번만 건다 — 두 번 걸면 같은 훅이 두 번 돈다.
let docPurifyHooked = false;

function docRenderLibsReady() {
  return typeof markdownit !== 'undefined' && typeof DOMPurify !== 'undefined';
}

/**
 * FR-DRV-13b: 코드 블록은 **정적 하이라이터**가 칠한다 (D-8) — VS Code 와 같은
 * 방식이다. Monaco 를 빌리지 않으므로 이 뷰는 Monaco 가 못 떠도 그려진다.
 *
 * FR-DRV-13c: 모르는 언어는 **색 없이 그대로 낸다.** 짐작해 칠하지 않는다.
 */
function docHighlight(code, lang) {
  if (typeof hljs === 'undefined' || !lang) return '';
  if (!hljs.getLanguage(lang)) return '';
  // hljs 는 자기 출력에서 escape 를 한다 — 그래서 이 문자열이 md 를 그대로 지나도
  // 원문의 `<` 가 태그가 되지 않는다.
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}

function docMarkdown() {
  if (docMD) return docMD;
  docMD = markdownit({
    // 인라인 HTML 을 살린다. `<details>`·`<br>` 이 문서에서 흔하고, 그것을 막으면
    // 우리 렌더만 남들과 다르게 보인다. **위험은 정화가 맡는다** (FR-DRV-20) —
    // 여기서 막는 것은 방어가 아니라 기능의 축소다.
    html: true,
    linkify: true,
    highlight: (str, lang) => {
      const out = docHighlight(str, (lang || '').toLowerCase());
      if (!out) return '';
      return '<pre><code class="hljs">' + out + '</code></pre>';
    },
  });
  /**
   * FR-DRV-44: 블록마다 **자기가 온 줄**을 싣는다. 스크롤 동기화가 그것을 딛는다 —
   * 비율로 맞추면 코드 블록이나 표가 있는 문서에서 어긋난다.
   *
   * 여는 토큰에만 붙인다(`nesting !== -1`). 닫는 토큰에 붙이면 같은 줄 번호가 두 번
   * 나와 어느 것이 그 블록의 시작인지 알 수 없다.
   */
  const baseRender = docMD.renderer.renderToken.bind(docMD.renderer);
  docMD.renderer.renderToken = (tokens, idx, options) => {
    const t = tokens[idx];
    if (t.map && t.nesting !== -1) t.attrSet('data-line', String(t.map[0] + 1));
    return baseRender(tokens, idx, options);
  };
  return docMD;
}

/**
 * FR-DRV-28: 외부 링크는 새 창으로 나가며 `rel` 을 단다. `noopener` 가 없으면 그
 * 창이 `window.opener` 로 우리 화면을 만질 수 있다.
 */
function docPurifyHook() {
  if (docPurifyHooked || typeof DOMPurify === 'undefined') return;
  docPurifyHooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href') || '';
    if (!/^https?:/i.test(href)) return;
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
}

// 확장자 → 종류. `app` 이 서기 전에도 뷰가 설 수 있으므로 표를 직접 딛는다.
function docRenderKindOf(path) {
  const m = String(path || '').toLowerCase().match(/(\.[^./\\]+)$/);
  return (m && DOC_RENDER_EXTS[m[1]]) || 'markdown';
}

function docFmtBytes(n) {
  const b = Number(n);
  if (!isFinite(b)) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

/**
 * 문서가 가리키는 자리를 절대경로로 푼다.
 *
 * **`/` 로 시작하는 참조는 문서의 디렉터리가 아니라 그 문서가 속한 Editor 루트를
 * 기준으로 한다.** 흔한 표기이며(`![](/img/a.png)`), 디렉터리를 기준으로 삼으면
 * `/repo/img/a.png` 가 `/repo/docs/img/a.png` 가 되어 조용히 어긋난다.
 *
 * 루트를 모르면(창 밖의 파일 등) `/` 표기를 파일시스템 절대경로로 그대로 받는다.
 * 없는 기준을 지어내지 않는다.
 */
/** 그 파일이 든 디렉터리. 구분자는 그 경로의 것이다. */
function docDirOf(filePath) {
  const s = String(filePath || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : (pathSep(s) === '\\' ? s : '/');
}

function docResolvePath(baseDir, rel, root) {
  // `/` 로 시작하면 그것은 "어딘가의 루트부터" 라는 뜻이다. 루트를 알면 그것이
  // 기준이고, 모르면 **그 표기를 그대로 절대경로로 받는다** — 문서 디렉터리 뒤에
  // 붙이면 같은 이름의 엉뚱한 파일을 열 수 있고, 그 어긋남은 조용하다.
  //
  // 구분자는 **기준 경로의 것**을 쓴다. `/` 로 굳히면 Windows 에서 기준이 한
  // 조각으로 뭉개져(`D:\a\root` 에는 `/` 가 없다) 결과가 `/D:\a\root\x` 가
  // 된다 — 그 경로는 어디에도 없다. 문서 안의 참조(`rel`)는 어느 OS 에서도
  // `/` 로 적히므로 양쪽을 다 받아 가른다.
  const abs = /^[\\/]/.test(String(rel));
  const from = abs ? (root || '') : baseDir;
  const sep = pathSep(String(from || baseDir || '/'));
  const parts = String(from).split(/[\\/]/).filter(Boolean);
  for (const seg of String(rel).split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg);
  }
  // POSIX 는 뿌리의 구분자가 앞에 하나 붙고, Windows 는 드라이브 문자가 첫 조각이다.
  return (sep === '/' ? '/' : '') + parts.join(sep);
}

/**
 * FR-DRV-26: 루트 밖을 가리키는가.
 *
 * `fsRoot` 가드가 어차피 거절하지만 **요청을 보내기 전에 막는다** — 스펙이 "그리지
 * 않는다" 라고 적은 자리이고, 보내면 404 가 깨진 이미지로 남아 문서가 잘못된
 * 것인지 우리가 못 그린 것인지 갈리지 않는다.
 */
function docInsideRoot(abs, root) {
  if (!root) return true;   // 기준이 없으면 판정하지 않는다 — 서버가 가른다
  return pathUnder(root, abs);
}

/**
 * FR-DRV-25·27: 상대 이미지는 우리 종단으로 바꾸고, **원격 이미지는 그대로 둔다**
 * (I-4 — VS Code 와 같이 그린다).
 */
function docFixImages(el, filePath, fsRoot) {
  const dir = docDirOf(filePath);
  for (const img of el.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src') || '';
    if (/^(https?:|data:)/i.test(src)) continue;
    const abs = docResolvePath(dir, src, fsRoot);
    // FR-DRV-26: 루트 밖은 그리지 않는다. `alt` 는 남긴다 — 무엇이 있어야 했는지는
    // 여전히 문서의 정보다.
    if (!docInsideRoot(abs, fsRoot)) { img.removeAttribute('src'); continue }
    img.setAttribute('src', FILE_RAW_API + '?path=' + encodeURIComponent(abs));
  }
}

/**
 * FR-DRV-28: 앵커가 가리킬 자리. markdown-it 은 헤딩에 id 를 붙이지 않으므로
 * 우리가 붙인다 — 없으면 `#제목` 링크가 갈 곳이 없다.
 *
 * 규칙은 흔한 것(GitHub 계열)을 따른다: 소문자, 공백은 `-`, 글자·숫자·`-` 만 남긴다.
 * 유니코드 글자를 지우지 않는 것이 중요하다 — 이 저장소의 헤딩은 대부분 한국어다.
 */
function docSlug(text) {
  return String(text).trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function docFixHeadings(root) {
  const used = new Set();
  for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const base = docSlug(h.textContent || '');
    if (!base) continue;
    // 같은 제목이 둘이면 뒤엣것에 번호가 붙는다 — 두 자리가 같은 id 를 가지면
    // 링크가 언제나 첫 번째로만 간다.
    let id = base;
    for (let n = 1; used.has(id); n++) id = base + '-' + n;
    used.add(id);
    h.id = id;
  }
}

/**
 * FR-DRV-16: 구분자로 나누되 **따옴표 안은 건드리지 않는다.**
 *
 * `split(',')` 로 되지 않는 이유가 그것이다 — 값 안의 쉼표와 줄바꿈이 흔하고,
 * 그것을 무시하면 표가 통째로 어긋난 채 **그럴듯하게** 보인다. 그런 표는 없는
 * 것보다 나쁘다.
 *
 * RFC 4180 의 규칙 셋만 본다: 따옴표로 감싼 칸, 그 안의 `""`(escape 된 따옴표),
 * 감싼 칸 안의 줄바꿈. 나머지 방언은 다루지 않는다.
 */
function docParseDelimited(text, delim) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') { cell += c; continue }
      if (text[i + 1] === '"') { cell += '"'; i++; continue }
      quoted = false;
      continue;
    }
    if (c === '"' && cell === '') { quoted = true; continue }
    if (c === delim) { row.push(cell); cell = ''; continue }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); docPushRow(rows, row); row = []; cell = ''; continue }
    cell += c;
  }
  // 마지막 줄에 줄바꿈이 없을 수 있다. 그때도 그 줄은 행이다.
  if (cell !== '' || row.length) { row.push(cell); docPushRow(rows, row) }
  return rows;
}

// **모든 칸이 빈 행은 담지 않는다.** 파일 끝의 빈 줄과 문단 사이의 빈 줄이 표에
// 빈 행으로 서면, 그것은 데이터가 아니라 파일의 여백이다.
function docPushRow(rows, row) {
  if (row.every(v => v === '')) return;
  rows.push(row);
}

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
    this.fsRoot = (typeof app !== 'undefined' && app && app._docRenderRootOf)
      ? app._docRenderRootOf(filePath) : '';
    this.el = document.createElement('div');
    this.el.className = 'doc-render';
    this.el.tabIndex = 0;
    this.el.innerHTML =
      '<div class="dr-bar">' +
        '<button type="button" class="dr-source" title="' + DOC_RENDER_SOURCE_TITLE + '">' +
          DOC_RENDER_SOURCE + '</button>' +
        '<span class="dr-path"></span>' +
      '</div>' +
      // UX_BATCH8_SRS FR-SCR-2: 스크롤 표면은 키트의 것이다 (`.ui-scroll`).
      '<div class="dr-body ui-scroll"><div class="dr-note">' + DOC_RENDER_LOADING + '</div></div>';
    this._body = this.el.querySelector('.dr-body');
    this.el.querySelector('.dr-path').textContent = name || '';
    // FR-DRV-6: **같은 버튼이 되돌린다.** 렌더를 켠 손이 끄는 법을 따로 배우지 않는다.
    this.el.querySelector('.dr-source').addEventListener('click', () => {
      if (window.app && window.app._docRenderToSource) window.app._docRenderToSource(this);
    });
    // 편집기 안의 키가 밖으로 나가지 않는 것과 같은 규약 — 여기서 앱 단축키가
    // 끼어들면 스크롤 중에 창이 바뀐다.
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    // FR-DRV-28: 링크의 대상에 따라 다르게 움직인다.
    this._body.addEventListener('click', (e) => this._onLinkClick(e));

    // FR-DRV-40: 문서를 딛는다. 뷰가 문서의 `views` 에 드는 것도 `FileEditor` 와
    // 같은 규약이며, 그래야 `_edDocDrop` 이 수명을 셀 수 있다 (FR-SVS-55).
    this._doc = (typeof app !== 'undefined' && app && app._edDoc) ? app._edDoc(filePath) : null;
    if (this._doc) this._doc.views.add(this);
    this._model = null;
    this._sub = null;
    this._timer = null;
    this._gen = 0;
    this._bindModel(this._findModel());
    this._paint();
  }

  // FR-DRV-35: 렌더 탭은 저장할 것이 없다. 문서의 dirty 를 물려받지 않는다 —
  // 물려받으면 렌더 탭만 열어 둔 창이 저장 확인에 걸린다 (FR-WBR-40).
  get _dirty() { return false }
  set _dirty(_v) { /* 렌더 뷰는 편집하지 않는다 (FR-DRV-19) */ }

  /**
   * 이 파일의 Monaco 모델. 모델의 URI 는 경로에서 나오므로(FR-SVS-50 의 규약)
   * 편집기를 거치지 않고 여기서 직접 찾을 수 있다 — 그래서 이 뷰는 편집기가
   * 있는지 없는지 몰라도 된다.
   */
  _findModel() {
    if (typeof monaco === 'undefined' || !monaco.editor) return null;
    try { return monaco.editor.getModel(monaco.Uri.file(this.filePath)) } catch { return null }
  }

  // 소스 탭이 **나중에** 열려 모델이 생겼을 때 app 이 알려준다. 그 통지가 없으면
  // 이 뷰는 디스크의 내용에 머문다.
  onDocModel(model) {
    if (!model || model === this._model) return;
    this._bindModel(model);
    this._schedule(0);
  }

  _bindModel(m) {
    if (this._sub) { this._sub.dispose(); this._sub = null }
    this._model = m || null;
    // FR-DRV-42: 편집을 구독한다. 지연은 `_schedule` 이 준다.
    if (m) this._sub = m.onDidChangeContent(() => this._schedule());
  }

  _schedule(ms) {
    TIMERS.cancel(this._timer);
    this._timer = TIMERS.after(ms == null ? DOC_RENDER_DEBOUNCE_MS : ms, () => this._paint(), {owner:this, label:'doc-paint'});
  }

  /**
   * FR-DRV-40·41: **문서가 진실이고 디스크는 낡았다.** 모델이 있으면 그것을 읽고,
   * 없으면(소스 탭이 닫힌 렌더 탭) 파일을 읽는다.
   */
  async _text() {
    if (this._model) return this._model.getValue();
    const r = await fetch('/api/file/read?path=' + encodeURIComponent(this.filePath));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
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
    // FR-DRV-43: 다시 그려도 자리를 지킨다. 한 글자를 고칠 때마다 문서 처음으로
    // 튀면 그것은 미리보기가 아니다.
    const top = this._body.scrollTop;
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
    this._body.innerHTML = html;
    docFixHeadings(this._body);
    docFixImages(this._body, this.filePath, this.fsRoot);
    this._body.scrollTop = top;
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
    // FR-DRV-26: 루트 밖으로는 가지 않는다. `_edOpenFile` 도 거절하지만, 거절이
    // 침묵이면 링크가 죽은 것인지 우리가 막은 것인지 갈리지 않는다.
    if (!docInsideRoot(abs, this.fsRoot)) { this._note(DOC_RENDER_OUTSIDE); return }
    if (window.app && window.app._edOpenFile) window.app._edOpenFile(abs, {});
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

  // 탭이 다시 활성화되거나 파일이 바뀌었을 때. 모델이 그 사이 생겼을 수 있으므로
  // 다시 찾는다.
  refresh() {
    this._bindModel(this._findModel());
    this._schedule(0);
  }

  // WORKBENCH_REVIEW_SRS FR-WBR-11 의 대상이 아니다 — 이 뷰에는 줄바꿈 설정이
  // 걸릴 자리가 없다. 계약을 만족시키려 둔다 (FR-DRV-32).
  applyWordWrap() { /* no-op */ }

  destroy() {
    TIMERS.cancel(this._timer);
    this._revokeBlob();
    if (this._sub) { this._sub.dispose(); this._sub = null }
    this._model = null;
    if (typeof app !== 'undefined' && app && app._edDocDrop) {
      app._edDocDrop(this.filePath, this);
    }
    this._doc = null;
  }
}
