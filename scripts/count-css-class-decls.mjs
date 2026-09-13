// DESIGN_TOKENS_SRS TC-TOK-22 — 과도기 클래스의 **선언 수**를 파일에서 센다.
//
// 게이트가 아니라 자다. §7 잔여표의 행을 지우기 전에 이것으로 0 을 확인한다
// (FR-TOK-35: 시점 판정은 사람이 아니라 파일이 말한다). 이름이 든 선택자의
// 본문 선언을 세고, 여러 이름이 묶인 규칙은 이름마다 센다 (§7 의 규약).
//
//   node scripts/count-css-class-decls.mjs tbtn mtbtn
//   종료코드: 하나라도 0 이 아니면 1
import fs from 'node:fs';
import path from 'node:path';

const CSS_DIR = 'web';
const names = process.argv.slice(2);
if (!names.length) { console.error('클래스 이름을 주세요'); process.exit(2) }
const files = fs.readdirSync(CSS_DIR).filter(f => f.endsWith('.css')).map(f => path.join(CSS_DIR, f));
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const out = Object.fromEntries(names.map(n => [n, { rules: 0, decls: 0, where: [] }]));
for (const f of files) {
  const css = strip(fs.readFileSync(f, 'utf8'));
  const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim(); if (sel.startsWith('@')) continue;
    const decls = m[2].split(';').map(s => s.trim()).filter(Boolean).length;
    for (const n of names) {
      if (new RegExp('\\.' + n.replace(/-/g, '\\-') + '(?![a-zA-Z0-9_-])').test(sel)) {
        out[n].rules++; out[n].decls += decls; out[n].where.push(path.basename(f) + ': ' + sel.replace(/\s+/g, ' '));
      }
    }
  }
}
let bad = 0;
for (const n of names) {
  const o = out[n];
  console.log(`.${n}\t규칙 ${o.rules}\t선언 ${o.decls}`);
  for (const w of o.where) console.log('    ' + w);
  if (o.decls) bad++;
}
process.exit(bad ? 1 : 0);
