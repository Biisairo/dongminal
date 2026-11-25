/**
 * 묶음 JS 의 주석 걷기 모형 (PERF_OPTIMIZATION_SRS D-35·D-42, NFR-PRF-12).
 *
 * 서버 `rust/crates/webserver/httpapi/src/js_strip.rs` 의 `strip_comments` 와 `bundles.rs` 의 `concat` 을
 * 바이트 단위로 그대로 옮겼다. 서버 묶음을 띄우지 않고 부팅 JS 바이트를 재려고 둔다
 * (`check-boot-bytes.mjs`). 서버 규칙을 바꾸면 이 파일도 같이 바꾼다 — 실측과 같은지는
 * `scenario.mjs --only boot` 의 `jsBytes` 로 확인한다.
 *
 *   stripComments(buf)       주석과 줄 끝 공백을 걷은 바이트
 *   concatJs(name, files)    [{path, src}] → `/b/<name>.js` 의 바이트
 */

const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

const C = (s) => s.charCodeAt(0);
const SLASH = C('/'), STAR = C('*'), BANG = C('!'), BSL = C('\\'), BT = C('`'), DOLLAR = C('$');
const SQ = C("'"), DQ = C('"'), LF = C('\n'), CR = C('\r'), SP = C(' '), TAB = C('\t');
const LBRACE = C('{'), RBRACE = C('}'), RPAREN = C(')'), RBRACK = C(']'), LBRACK = C('['), PLUS = C('+'), MINUS = C('-'), DOT = C('.');

const isBlank = (b) => b === SP || b === TAB || b === LF || b === CR;
const isDigit = (b) => b >= 0x30 && b <= 0x39;
const isWord = (b) => isDigit(b) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b === DOLLAR || b === 0x23 || b === BSL || b >= 0x80;

function trimLineEnd(out) {
  while (out.length && (out[out.length - 1] === SP || out[out.length - 1] === TAB)) out.pop();
}

function push(out, src, from, to) {
  for (let k = from; k < to; k++) out.push(src[k]);
}

function lineEnd(src, i) {
  for (let j = i; j < src.length; j++) if (src[j] === LF || src[j] === CR) return j;
  return src.length;
}

function blockEnd(src, i) {
  for (let j = i + 2; j + 1 < src.length; j++) if (src[j] === STAR && src[j + 1] === SLASH) return j + 2;
  return src.length;
}

function stringEnd(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === BSL) j += 2;
    else if (src[j] === LF) return j;
    else if (src[j] === q) return j + 1;
    else j++;
  }
  return src.length;
}

function regexEnd(src, i) {
  let j = i + 1;
  let cls = false;
  while (j < src.length) {
    const b = src[j];
    if (b === BSL) j++;
    else if (b === LBRACK) cls = true;
    else if (b === RBRACK) cls = false;
    else if (b === SLASH && !cls) {
      j++;
      while (j < src.length && isWord(src[j])) j++;
      return j;
    } else if (b === LF) return j;
    j++;
  }
  return src.length;
}

function wordEnd(src, i) {
  const digit = isDigit(src[i]);
  while (i < src.length && (isWord(src[i]) || (digit && src[i] === DOT))) i++;
  return i;
}

// 템플릿 본문을 그대로 옮긴다. 닫는 `` ` `` 나 `${` 의 다음 자리를 돌려준다.
function template(src, i, out, templates, st) {
  while (i < src.length) {
    const b = src[i];
    if (b === BSL) {
      const end = Math.min(i + 2, src.length);
      push(out, src, i, end);
      i = end;
    } else if (b === BT) {
      out.push(BT);
      st.afterValue = true;
      return i + 1;
    } else if (b === DOLLAR && src[i + 1] === LBRACE) {
      out.push(DOLLAR, LBRACE);
      templates.push(0);
      st.afterValue = false;
      return i + 2;
    } else {
      out.push(b);
      i++;
    }
  }
  return i;
}

export function stripComments(src) {
  const out = [];
  const st = { afterValue: false };
  const templates = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === SLASH && src[i + 1] === SLASH) {
      trimLineEnd(out);
      i = lineEnd(src, i);
    } else if (c === SLASH && src[i + 1] === STAR) {
      const end = blockEnd(src, i);
      const body = src.subarray(i, end);
      if (src[i + 2] === BANG) push(out, src, i, end);
      else if (body.includes(LF)) {
        trimLineEnd(out);
        for (const b of body) if (b === LF) out.push(LF);
      } else if (out.length && !isBlank(out[out.length - 1]) && !(end < src.length && isBlank(src[end]))) out.push(SP);
      i = end;
    } else if (c === SLASH && !st.afterValue) {
      const end = regexEnd(src, i);
      push(out, src, i, end);
      st.afterValue = true;
      i = end;
    } else if (c === SQ || c === DQ) {
      const end = Math.min(stringEnd(src, i), src.length);
      push(out, src, i, end);
      st.afterValue = true;
      i = end;
    } else if (c === BT) {
      out.push(c);
      i = template(src, i + 1, out, templates, st);
    } else if (c === LF || c === CR) {
      trimLineEnd(out);
      out.push(c);
      i++;
    } else if (c === SP || c === TAB) {
      out.push(c);
      i++;
    } else if (c === LBRACE) {
      if (templates.length) templates[templates.length - 1]++;
      out.push(c);
      st.afterValue = false;
      i++;
    } else if (c === RBRACE && templates.length && templates[templates.length - 1] === 0) {
      templates.pop();
      out.push(c);
      i = template(src, i + 1, out, templates, st);
    } else if (c === RBRACE) {
      if (templates.length) templates[templates.length - 1]--;
      out.push(c);
      st.afterValue = false;
      i++;
    } else if (c === RPAREN || c === RBRACK) {
      out.push(c);
      st.afterValue = true;
      i++;
    } else if ((c === PLUS || c === MINUS) && src[i + 1] === c) {
      push(out, src, i, i + 2);
      st.afterValue = true;
      i += 2;
    } else if (isWord(c)) {
      const end = wordEnd(src, i);
      st.afterValue = isDigit(c) || !REGEX_AFTER_WORDS.has(src.subarray(i, end).toString('latin1'));
      push(out, src, i, end);
      i = end;
    } else {
      out.push(c);
      st.afterValue = false;
      i++;
    }
  }
  return Buffer.from(out);
}

export function concatJs(name, files) {
  const parts = [];
  for (const { path, src } of files) {
    parts.push(Buffer.from(`/* ==== ${path} ==== */\n`), stripComments(src));
    if (src[src.length - 1] !== LF) parts.push(Buffer.from('\n'));
  }
  parts.push(Buffer.from(`//# sourceMappingURL=${name}.js.map\n`));
  return Buffer.concat(parts);
}
