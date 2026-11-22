import fs from 'node:fs';
import {GROUPS, M, UNUSED, C} from './meanings.mjs';

const PK = '/tmp/icons/pkgs';
const OUT = '/tmp/icons/proposal/index.html';
const cur = Object.fromEntries(JSON.parse(fs.readFileSync('/tmp/icons/data2.json', 'utf8')).map(i => [i.name, i]));
const lucVer = JSON.parse(fs.readFileSync(PK + '/lucide/package/package.json', 'utf8')).version;
const phVer = JSON.parse(fs.readFileSync(PK + '/phosphor/package/package.json', 'utf8')).version;

const inner = s => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s*\n\s*/g, '').trim();
const STROKE = w => `fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const sym = new Map();
const missing = [];
function add(id, attrs, body) { if (!sym.has(id)) sym.set(id, `<symbol id="${id}" ${attrs}>${body}</symbol>`); }
function useCur(n) { const id = 'cur-' + n; if (!cur[n]) { missing.push(id); return id; } add(id, `viewBox="0 0 24 24" ${STROKE(2)}`, cur[n].body); return id; }
function useA(n) { const id = 'a-' + n; const f = `${PK}/lucide/package/icons/${n}.svg`; if (!fs.existsSync(f)) { missing.push(id); return id; } add(id, `viewBox="0 0 24 24" ${STROKE(2)}`, inner(fs.readFileSync(f, 'utf8'))); return id; }
function useB(n) { const id = 'b-' + n; const f = `${PK}/phosphor/package/assets/duotone/${n}-duotone.svg`; if (!fs.existsSync(f)) { missing.push(id); return id; } add(id, `viewBox="0 0 256 256" fill="currentColor"`, inner(fs.readFileSync(f, 'utf8'))); return id; }
function useC(k) {
  const id = 'c-' + k;
  const body = C[k].replace(/class="t"( opacity="[^"]*")?/g, (_, op) => `fill="currentColor" stroke="none"${op || ' opacity=".2"'}`);
  add(id, `viewBox="0 0 24 24" ${STROKE(2.35)}`, body); return id;
}
const ico = (id, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// 후보별 이 뜻의 아이콘 id 목록
const byId = Object.fromEntries(M.map(m => [m.id, m]));
function ids(m, cand) {
  if (cand === 'cur') return m.cur.map(useCur);
  if (cand === 'a') return m.a.map(useA);
  if (cand === 'b') return m.b.map(useB);
  if (cand === 'c') return m.c ? [useC(m.c)] : m.a.map(useA);
}
const I = (key, cand, k = 0) => ids(byId[key], cand)[k] ?? ids(byId[key], cand)[0];

// 지금 아이콘 하나가 몇 뜻에 쓰이는지 → 겹침
const curCount = {};
for (const m of M) for (const n of new Set(m.cur)) (curCount[n] ||= []).push(m.ko);
const overlapOf = m => [...new Set(m.cur)].filter(n => curCount[n].length > 1).map(n => `${n}: ${curCount[n].filter(k => k !== m.ko).join(' · ')}`);
// 제안안 안에서 남는 겹침
function dupes(cand) {
  const seen = {};
  for (const m of M) for (const n of new Set(cand === 'a' ? m.a : m.b)) (seen[n] ||= []).push(m.ko);
  return Object.entries(seen).filter(([, v]) => v.length > 1);
}

const CANDS = [
  {k: 'cur', t: '지금', sub: `Lucide 선 · stroke 2 (현재 스프라이트 54개)`, lic: 'Lucide — ISC', pros: [], cons: []},
  {k: 'a', t: 'A. Lucide 선 + 짝 재정리', sub: `lucide-static ${lucVer} · stroke 2 · currentColor`, lic: 'ISC License (Lucide Contributors) · 일부는 Feather(MIT) 유래',
   pros: ['지금 화면과 결이 같아 바꿔 끼워도 어색함이 없다 — 아이콘 이름만 바꾸면 된다', '2,400개가 넘는 목록에서 뜻에 맞는 그림을 바로 고를 수 있다', '선 하나라 작은 크기(16px)에서도 가장 또렷하다'],
   cons: ['「귀여움」 은 거의 늘지 않는다 — 지금보다 정리된 느낌일 뿐이다', '선만 있어 상태(작업 중·끝남)의 무게감이 약하다', '라이선스가 ISC 라 SRS FR-GLY-3 의 「MIT」 표기를 고쳐야 한다']},
  {k: 'b', t: 'B. Phosphor Duotone (둥근 두 톤)', sub: `@phosphor-icons/core ${phVer} · viewBox 256 · fill + 옅은 면 opacity .2`, lic: 'MIT License (Phosphor Icons)',
   pros: ['옅은 면이 깔려 통통하고 부드럽다 — 「귀엽게」 에 가장 가깝다', '뜻마다 짝이 넉넉하다(9,000여 파일, 6가지 굵기)', '같은 이름으로 Fill·Bold 로 바꿔 끼울 수 있어 강조 상태를 만들기 쉽다'],
   cons: ['채움 기반이라 FR-GLY-2(stroke 규약)를 고쳐야 한다 — CSS 의 stroke 지정이 먹지 않는다', '16px 에서는 옅은 면이 뭉개져 선 아이콘보다 덜 또렷하다', 'Git 전용 그림(저장소·워크트리)은 없어 비유(책·폴더)로 대신한다']},
  {k: 'c', t: 'C. 직접 그린 고유 세트 (시범)', sub: `24×24 · stroke 2.35 · 둥근 끝 · 옅은 면 한 톤 · ${Object.keys(C).length}개만, 나머지는 A 로 채움`, lic: '자체 제작(이 저장소 라이선스를 따른다) · 빈 칸은 A(Lucide ISC)',
   pros: ['문제가 컸던 뜻(Repo·History·Stash·Worktree…)을 이 앱만의 그림으로 맞출 수 있다', '선 굵기·모서리·면 톤을 한 규칙으로 그려 묶음이 고르다', 'stroke 기반이라 지금 규약(currentColor·stroke)을 거의 그대로 쓴다'],
   cons: ['시범 수준이다 — 손으로 그린 좌표라 디자이너 손질이 필요하다', '나머지 뜻은 A 를 섞어 쓰므로 굵기(2 vs 2.35)가 조금 다르다', '아이콘이 늘 때마다 직접 그려야 해 유지 비용이 든다']},
];

// ── 한눈에 비교
const cell = (m, cand) => {
  const list = ids(m, cand);
  const names = cand === 'cur' ? m.cur : cand === 'a' ? m.a : cand === 'b' ? m.b : (m.c ? ['직접 그림'] : m.a.map(n => 'A: ' + n));
  const filler = cand === 'c' && !m.c;
  return `<td class="${filler ? 'filler' : ''} ${m.danger && cand !== 'cur' ? 'danger' : ''}"><div class="ics">${list.map(x => ico(x)).join('')}</div><div class="nm">${names.map(esc).join(' / ')}</div></td>`;
};
let rows = '';
for (const [g, gname] of GROUPS) {
  rows += `<tr class="grp"><th colspan="5">${gname}</th></tr>`;
  for (const m of M.filter(x => x.g === g)) {
    const ov = overlapOf(m);
    const changed = m.a.join() !== m.cur.join();
    rows += `<tr><th class="mean"><a href="#d-${m.id}">${esc(m.ko)}</a>${ov.length ? `<span class="tag ov" title="${esc(ov.join(' / '))}">겹침 해소</span>` : ''}${changed && !ov.length ? '<span class="tag ch">바꿈</span>' : ''}</th>${['cur', 'a', 'b', 'c'].map(c => cell(m, c)).join('')}</tr>`;
  }
}

// ── 목업
function mock(cand, theme, size) {
  const i = (k, n = 0) => ico(I(k, cand, n));
  const tab = (k, label, on) => `<span class="tb${on ? ' on' : ''}">${i(k)}<span>${label}</span></span>`;
  const btn = (k, label, cls = '') => `<span class="bt ${cls}" title="${label}">${i(k)}${label && !cls.includes('io') ? `<span>${label}</span>` : ''}</span>`;
  const st = (k, name, cls) => `<div class="st ${cls}">${i(k)}<span>${name}</span></div>`;
  return `<div class="mock th-${theme}" style="--s:${size}px">
  <div class="mh">${CANDS.find(c => c.k === cand).t.split(' (')[0]}</div>
  <div class="row lbl">사이드바 탭</div><div class="tabs">${tab('windowstab', 'Windows')}${tab('repotab', 'Repo', 1)}${tab('chattab', 'Chat')}</div>
  <div class="row lbl">Git 패널 탭</div><div class="tabs wrap"><span class="tb on"><span>Changes</span></span>${tab('history', 'History')}${tab('branches', 'Branches')}${tab('stash', 'Stash')}${tab('console', 'Console')}${tab('worktrees', 'Worktrees')}${tab('submodules', 'Submodules')}</div>
  <div class="row lbl">원격 단추</div><div class="btns">${btn('fetch', 'Fetch')}${btn('pull', 'Pull')}${btn('push', 'Push')}${btn('more', '', 'io')}</div>
  <div class="row lbl">변경 행</div>
  <div class="chg"><span class="fn">src/app.ts</span><span class="fm">M</span>${btn('openfile', '열기', 'io')}${btn('discard', 'Discard', 'io danger')}${btn('stage', 'Stage', 'io')}</div>
  <div class="chg"><span class="fn">README.md</span><span class="fm a">A</span>${btn('openfile', '열기', 'io')}${btn('unstage', 'Unstage', 'io')}</div>
  <div class="row lbl">Activity</div>
  <div class="sec">${i('agents')}<span>Agents</span><b>2</b></div>
  ${st('working', 'claude · 리팩터', 'w')}${st('done', 'codex · 테스트', 'd')}${st('waiting', 'claude · 허락 대기', 'wt')}${st('idle', 'gemini', 'i')}
  <div class="sec">${i('bg')}<span>Background</span></div><div class="sec">${i('runs')}<span>Runs</span></div>
  <div class="row lbl">상단·아래 단추</div><div class="btns">${btn('settings', '', 'io')}${btn('reload', '', 'io')}<span class="bt io bell">${i('bell')}<b>3</b></span>${btn('group', 'Group')}</div>
</div>`;
}
const THEMES = {tn: 'Tokyo Night', gh: 'GitHub Light'};
let mocks = '';
for (const size of [16, 32]) for (const th of ['tn', 'gh']) {
  mocks += `<h3>${THEMES[th]} · ${size}px${size === 16 ? ' (앱 크기)' : ' (확대)'}</h3><div class="mocks${size > 20 ? ' big' : ''}">${['cur', 'a', 'b', 'c'].map(c => mock(c, th, size)).join('')}</div>`;
}

// ── 상세
let detail = '';
for (const [g, gname] of GROUPS) {
  detail += `<h3>${gname}</h3>`;
  for (const m of M.filter(x => x.g === g)) {
    const ov = overlapOf(m);
    const show = c => ids(m, c).map(x => ico(x)).join('');
    detail += `<div class="det" id="d-${m.id}"><div class="dh"><b>${esc(m.ko)}</b>${ov.length ? '<span class="tag ov">겹침 해소</span>' : ''}</div>
<div class="dicons"><span>지금 ${show('cur')}</span><span>→ A ${show('a')}</span><span>B ${show('b')}</span><span${m.c ? '' : ' class="filler"'}>C ${show('c')}</span></div>
<div class="du"><span>쓰는 자리</span> ${esc(m.uses)}</div>${ov.length ? `<div class="du"><span>지금 겹치던 뜻</span> ${esc(ov.join(' / '))}</div>` : ''}
<div class="du"><span>이유</span> ${esc(m.why)}</div>${m.alt ? `<div class="du"><span>다른 후보</span> ${esc(m.alt)}${altIcons(m.alt)}</div>` : ''}</div>`;
  }
}
function altIcons(s) { return ' ' + (s.match(/[a-z][a-z0-9-]+/g) || []).filter(n => fs.existsSync(`${PK}/lucide/package/icons/${n}.svg`)).map(n => ico(useA(n))).join(''); }

// ── 겹침 해소 표
let ovRows = '';
for (const [n, means] of Object.entries(curCount).filter(([, v]) => v.length > 1)) {
  const ms = M.filter(m => m.cur.includes(n));
  ovRows += `<tr><td>${ico(useCur(n))} <code>${n}</code></td><td>${ms.map(m => `${esc(m.ko)} → ${ico(ids(m, 'a')[0])}<code>${m.a.join('/')}</code>`).join('<br>')}</td></tr>`;
}
const dupA = dupes('a'), dupB = dupes('b');
const cards = CANDS.filter(c => c.k !== 'cur').map(c => `<div class="card"><h4>${c.t}</h4><div class="sub">${esc(c.sub)}</div><div class="lic">라이선스: ${esc(c.lic)}</div>
<ul class="pro">${c.pros.map(p => `<li>${esc(p)}</li>`).join('')}</ul><ul class="con">${c.cons.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`).join('');

const cGallery = Object.keys(C).map(k => `<figure>${ico(useC(k))}${ico(useC(k), 'g16')}<figcaption>${esc(M.find(m => m.c === k).ko)}</figcaption></figure>`).join('');
const unused = UNUSED.map(n => `<span class="un">${ico(useCur(n))} <code>${n}</code></span>`).join(' ');

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>dongminal 아이콘 시안 비교</title>
<style>
:root{--bg:#1a1b26;--sb:#16161e;--bd:#292e42;--ac:#7aa2f7;--tx:#a9b1d6;--mu:#565f89;--br:#c0caf5;--dg:#f7768e;--ok:#9ece6a;--wn:#e0af68}
body.light{--bg:#ffffff;--sb:#f6f8fa;--bd:#d0d7de;--ac:#0969da;--tx:#1f2328;--mu:#656d76;--br:#1f2328;--dg:#cf222e;--ok:#1a7f37;--wn:#9a6700}
.th-tn{--bg:#1a1b26;--sb:#16161e;--bd:#292e42;--ac:#7aa2f7;--tx:#a9b1d6;--mu:#565f89;--br:#c0caf5;--dg:#f7768e;--ok:#9ece6a;--wn:#e0af68}
.th-gh{--bg:#ffffff;--sb:#f6f8fa;--bd:#d0d7de;--ac:#0969da;--tx:#1f2328;--mu:#656d76;--br:#1f2328;--dg:#cf222e;--ok:#1a7f37;--wn:#9a6700}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.55 -apple-system,"Apple SD Gothic Neo","Pretendard",system-ui,sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 28px 80px}h1{color:var(--br);font-size:22px;margin:0 0 6px}h2{color:var(--br);font-size:18px;margin:44px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--bd)}h3{color:var(--br);font-size:15px;margin:22px 0 10px}
.ic{width:var(--s,20px);height:var(--s,20px);flex:none;vertical-align:middle}
a{color:var(--ac)}code{font:12px ui-monospace,Menlo,monospace;color:var(--mu)}
.hd p{margin:4px 0;color:var(--mu)}.hd .lic{color:var(--tx)}
.tool{position:absolute;top:12px;right:16px;z-index:5}.tool button{background:var(--sb);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:4px 10px;cursor:pointer}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card{background:var(--sb);border:1px solid var(--bd);border-radius:10px;padding:12px 14px}.card h4{margin:0 0 4px;color:var(--br)}.card .sub,.card .lic{font-size:12px;color:var(--mu)}
.card ul{margin:8px 0 0;padding-left:18px;font-size:13px}.pro li::marker{content:"＋ ";color:var(--ok)}.con li::marker{content:"－ ";color:var(--dg)}
table{border-collapse:collapse;width:100%}
.cmp th,.cmp td{border-bottom:1px solid var(--bd);padding:6px 8px;text-align:left;vertical-align:middle}
.cmp thead th{position:sticky;top:0;background:var(--sb);color:var(--br);z-index:2}
.cmp .grp th{background:var(--sb);color:var(--ac);font-size:12px;letter-spacing:.02em}
.cmp .mean{width:220px;font-weight:500}.cmp .mean a{color:var(--br);text-decoration:none}
.cmp td{width:22%}.cmp .ics{display:flex;gap:6px;--s:22px;color:var(--br)}.cmp .nm{font:11px ui-monospace,Menlo,monospace;color:var(--mu);margin-top:2px}
.cmp td.danger .ics{color:var(--dg)}.filler{opacity:.45}
.tag{display:inline-block;font-size:11px;border-radius:9px;padding:0 7px;margin-left:6px;vertical-align:1px}.tag.ov{background:color-mix(in srgb,var(--dg) 18%,transparent);color:var(--dg)}.tag.ch{background:color-mix(in srgb,var(--ac) 16%,transparent);color:var(--ac)}
.mocks{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.mocks.big{grid-template-columns:repeat(2,1fr)}
.mock{background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:10px;padding:10px 12px;font-size:calc(var(--s)*.78 + 1px);--fs:calc(var(--s)*.78 + 1px)}
.mock .mh{font-weight:600;color:var(--br);font-size:13px;margin-bottom:6px}
.mock .lbl{font-size:11px;color:var(--mu);margin:8px 0 3px}
.tabs{display:flex;gap:2px;background:var(--sb);border-radius:6px;padding:2px}.tabs.wrap{flex-wrap:wrap}
.tb{display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border-radius:5px;color:var(--mu);white-space:nowrap}.tb.on{color:var(--br);background:var(--bg);box-shadow:inset 0 -2px 0 var(--ac)}
.btns{display:flex;gap:4px;flex-wrap:wrap}.bt{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border:1px solid var(--bd);border-radius:5px;color:var(--tx);background:var(--sb)}.bt.io{border-color:transparent;background:none;padding:3px}
.bt.danger{color:var(--dg)}.bt.bell b{font-size:11px;background:var(--dg);color:#fff;border-radius:8px;padding:0 5px;margin-left:-4px}
.chg{display:flex;align-items:center;gap:2px;padding:2px 0}.chg .fn{flex:1;color:var(--tx)}.chg .fm{color:var(--wn);font-weight:600;margin-right:4px}.chg .fm.a{color:var(--ok)}
.sec{display:flex;align-items:center;gap:6px;color:var(--br);font-weight:600;padding:3px 0}.sec b{font-size:11px;color:var(--bg);background:var(--ac);border-radius:8px;padding:0 6px}
.st{display:flex;align-items:center;gap:6px;padding:1px 0 1px 10px}.st.w svg{color:var(--ac)}.st.d svg{color:var(--ok)}.st.wt svg{color:var(--wn)}.st.i svg{color:var(--mu)}
.det{border-bottom:1px solid var(--bd);padding:10px 0}.dh b{color:var(--br);font-size:15px}.dicons{display:flex;gap:22px;margin:6px 0;--s:24px;color:var(--br);flex-wrap:wrap}.dicons span{display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--mu)}.dicons .ic{color:var(--br)}
.du{font-size:13px;margin:2px 0}.du>span{display:inline-block;min-width:92px;color:var(--mu);font-size:12px}.du .ic{--s:18px;margin-left:4px;color:var(--br)}
.gal{display:flex;flex-wrap:wrap;gap:10px}.gal figure{margin:0;width:118px;text-align:center;background:var(--sb);border:1px solid var(--bd);border-radius:10px;padding:10px 4px 6px;color:var(--br)}.gal .ic{--s:44px}.gal .ic.g16{--s:16px;margin-left:8px}.gal figcaption{font-size:11.5px;color:var(--mu);margin-top:4px}
.ovt td{border-bottom:1px solid var(--bd);padding:6px 8px;vertical-align:top}.ovt .ic{--s:18px;color:var(--br);margin-right:2px}
.note{background:var(--sb);border-left:3px solid var(--ac);padding:8px 12px;border-radius:4px;font-size:13px;margin:10px 0}
.un .ic{--s:20px;color:var(--mu)}
</style></head><body>
<svg id="sprite" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"><defs>@@SPRITE@@</defs></svg>
<div class="tool"><button onclick="document.body.classList.toggle('light')">페이지 밝기 바꾸기</button></div>
<main>
<header class="hd"><h1>dongminal 아이콘 시안 비교</h1>
<p>원칙: <b>한 뜻 = 한 아이콘, 한 아이콘 = 한 뜻.</b> 지금 아이콘 54개(쓰는 곳 52개)를 쓰는 자리로 나누어 <b>${M.length}개 뜻</b>으로 정리했다. 고를 것은 두 가지다 — ① 스타일(A·B·C) ② 뜻마다의 아이콘 짝.</p>
<p class="lic">라이선스 — 지금·A: Lucide (<b>ISC</b>, lucide-static ${lucVer}) · B: Phosphor Icons (<b>MIT</b>, @phosphor-icons/core ${phVer}) · C: 이 시안에서 직접 그림(빈 칸은 A 로 채움). 모든 SVG 는 이 파일 안 스프라이트에 들어 있고 밖을 부르지 않는다.</p>
<p>색: 아이콘은 모두 <code>currentColor</code>. B 의 옅은 면은 Phosphor 원본의 <code>opacity="0.2"</code>, C 의 옅은 면은 <code>opacity=".2"</code> 다.</p></header>

<h2>후보 셋 — 장단점</h2><div class="cards">${cards}</div>

<h2>한눈에 비교 (${M.length}개 뜻)</h2>
<p class="note">「겹침 해소」 = 지금 한 아이콘이 다른 뜻에도 쓰이던 자리. 이름에 마우스를 올리면 겹치던 뜻이 보인다. C 열의 흐린 칸은 직접 그리지 않아 A 를 빌려 쓴 자리다. Discard 는 제안안에서 위험색으로 칠한다.</p>
<table class="cmp"><thead><tr><th>뜻</th><th>지금</th><th>A. Lucide</th><th>B. Phosphor Duotone</th><th>C. 직접 그림(시범)</th></tr></thead><tbody>${rows}</tbody></table>

<h2>남는 겹침 · 쓰는 곳 없음</h2>
<div class="note">A 의 남는 겹침: ${dupA.length ? dupA.map(([n, v]) => `<code>${n}</code> — ${v.join(' · ')}`).join(' / ') : '없음'}<br>B 의 남는 겹침: ${dupB.length ? dupB.map(([n, v]) => `<code>${n}</code> — ${v.join(' · ')}`).join(' / ') : '없음'}<br>
▸(다음)와 ▸(접힘)은 방향 꺾쇠 관례라 남겨 두기를 권한다. 놓이는 자리(숫자 옆 단추 / 행 맨 앞 표시)로 갈린다. 꼭 가르려면 「이전/다음」 을 <code>arrow-left/right</code> 로 옮기고 「뒤로/앞으로」 를 <code>undo-2</code> 계열로 바꿔야 하는데, 그쪽이 더 헷갈린다.</div>
<p>쓰는 곳 없음 — 스프라이트에서 빼기를 권한다: ${unused}</p>

<h2>화면 목업</h2>
<p class="note">앱의 대표 자리를 후보마다 그렸다. 에이전트 상태 색(작업 중=강조색, 끝남=초록, 기다림=노랑, 쉼=흐림)과 Discard 위험색은 테마에서 가져왔다(<code>web/js/ui/themes.js</code>). C 목업에서 직접 그리지 않은 자리는 A 아이콘이다.</p>
${mocks}

<h2>C. 직접 그린 아이콘 (시범 ${Object.keys(C).length}개)</h2>
<p class="note">각 칸: 44px 확대 · 16px 실제 크기. 규칙 — 24×24 격자, 선 2.35, 둥근 끝·둥근 모서리(r 2.5~5.5), 옅은 면 한 톤(opacity .2), 모두 currentColor. 손으로 좌표를 잡은 시범이다 — 고르면 디자이너 손질을 권한다.</p>
<div class="gal">${cGallery}</div>

<h2>겹침 해소 표 (지금 → A 제안)</h2>
<table class="ovt"><tbody>${ovRows}</tbody></table>

<h2>뜻 목록 상세</h2>${detail}
</main></body></html>`;

if (missing.length) { console.error('MISSING', missing); process.exit(1); }
const out = html.replace('@@SPRITE@@', [...sym.values()].join(''));
fs.writeFileSync(OUT, out);
console.log('meanings', M.length, 'symbols', sym.size, 'bytes', out.length, 'dupA', JSON.stringify(dupA), 'dupB', JSON.stringify(dupB));
