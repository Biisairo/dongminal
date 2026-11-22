/**
 * 문서 렌더의 순수 도움 함수 — 마크다운·정화 훅·경로 풀이·이미지·제목 앵커·구분자 표 (DOC_RENDER_VIEW_SRS 묶음 C·D).
 *
 * `doc-render.js` 의 클래스 앞에 있던 것을 그대로 옮겼다 (REFACTOR3_FE_REST5_SRS FR-FR5-21). `DocRender` 가 부르며
 * `doc-render.js` **바로 앞**에 로드된다.
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
 * 방식이다. 편집기를 빌리지 않으므로 이 뷰는 편집기가 못 떠도 그려진다.
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
    const tok = tokens[idx];
    if (tok.map && tok.nesting !== -1) tok.attrSet('data-line', String(tok.map[0] + 1));
    return baseRender(tokens, idx, options);
  };
  // BARE_DOMAIN_LINK_SRS FR-BDL-5: 맨 도메인도 링크다. 그것에 표를 달아 두면 그리고 난 뒤
  // 같은 폴더의 파일 이름인 것을 글자로 되돌린다.
  docMD.linkify.set({ fuzzyLink: true });
  docMD.core.ruler.after('linkify', 'bare_link', (state) => {
    for (const blk of state.tokens) {
      if (blk.type !== 'inline' || !blk.children) continue;
      blk.children.forEach((tok, i) => {
        const txt = blk.children[i + 1];
        if (tok.type !== 'link_open' || tok.markup !== 'linkify' || !txt) return;
        if (/^https?:/i.test(tok.attrGet('href') || '') && !/^[a-z][a-z0-9+.-]*:/i.test(txt.content)) tok.attrSet('data-bare', '1');
      });
    }
  });
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
