/**
 * Remote Terminal — 경로 잇기·비교
 *
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-6 (FEC-24): 옛 helpers.js 에서 주제별로 갈라 왔다. 본문은
 * 바꾸지 않았다. index.html 이 옛 helpers.js 자리에 같은 순서로 싣는다 (path → helpers →
 * theme-vars → shortcuts → settings-state → layout-tree → git-status-helpers).
 */

// ── 경로 잇기 ──

/**
 * 디렉터리와 그 아래의 이름을 잇는다.
 *
 * **구분자는 그 경로가 이미 쓰고 있는 것을 따른다.** 서버가 주는 절대경로의
 * 모양은 OS 가 정한다 — Windows 에서는 `C:\Users\x` 다. 여기서 `/` 로 이으면
 * 한 문자열에 둘이 섞이고(`C:\Users\x/a.txt`), 그 값이 곧 화면의 `data-path`
 * 이자 서버로 되돌아가는 키가 된다. 서버는 `filepath.Clean` 으로 그것을 고쳐
 * 읽으므로 **동작은 하지만**, 화면이 든 문자열과 서버가 든 문자열이 갈린다 —
 * 그러면 그 둘을 견주는 자리(탐색기의 선택·git 색·검사)가 전부 어긋난다.
 *
 * `rel` 이 여러 겹(`a/b`)일 수 있다. 그것은 git 이 늘 `/` 로 주는 상대경로다.
 * **그 안쪽도 함께 맞춘다.** 잇는 자리 하나만 바꾸면 결과가 `D:\a\root\aa/bb/cc`
 * 처럼 **섞인 채로** 나오고, 그 값은 절대경로로 쓰이는 순간 전부 어긋난다 —
 * `pathSep` 은 섞인 문자열을 `/` 로 읽고, `pathUnder` 는 그래서 자기 루트조차
 * 아래로 보지 않으며, 화면의 `data-path`(서버가 준 순수한 OS 경로)와도 다르다.
 * 러너에서 실측한 자리다: 검색 결과로 연 파일이 어느 창에도 속하지 않는 것으로
 * 판정돼 홈 창으로 떨어졌고, 탐색기는 그 파일을 끝내 펼치지 못했다.
 *
 * git 이 준 값 자체는 바뀌지 않는다 — 바뀌는 것은 **이 함수가 만든 절대경로**뿐이고,
 * 그것이 이 함수의 목적이다.
 */
function pathJoin(dir,rel){
  const d=String(dir==null?'':dir);
  const r=String(rel==null?'':rel);
  if(!d) return r;
  if(!r) return d;
  if(d==='/') return '/'+r;
  const sep=(d.includes('\\')&&!d.includes('/'))?'\\':'/';
  const tail=sep==='\\'?r.replace(/\//g,'\\'):r;
  return d.replace(/[\\/]+$/,'')+sep+tail;
}

/** 그 경로가 쓰는 구분자. 서버가 준 절대경로의 모양이 곧 그 OS 의 모양이다. */
function pathSep(dir){
  const d=String(dir==null?'':dir);
  return (d.includes('\\')&&!d.includes('/'))?'\\':'/';
}

/**
 * 절대경로인가. POSIX 는 `/` 로 시작하고, Windows 는 `C:\\…` 또는 UNC(`\\\\srv\\…`)다.
 *
 * `startsWith('/')` 만으로 재면 **Windows 의 절대경로가 전부 상대로 읽힌다.**
 */
function isAbsPath(p){
  const s=String(p==null?'':p);
  return s.startsWith('/')||s.startsWith('\\\\')||/^[A-Za-z]:[\\/]/.test(s);
}

/**
 * `p` 가 `root` **아래**(또는 root 자신)인가.
 *
 * `startsWith(root)` 만으로는 `/a/bc` 가 `/a/b` 아래로 잡히므로 구분자까지
 * 본다. 그 구분자를 `/` 로 굳히면 **Windows 에서는 어떤 경로도 아래로 잡히지
 * 않는다** — `C:\\Users\\x` 아래의 어떤 것도 `C:\\Users\\x/` 로 시작하지
 * 않기 때문이다. 트리의 펼침·이동 금지·창 고르기가 전부 이 판정을 딛는다.
 */
function pathUnder(root,p){
  const raw=String(root==null?'':root);
  const s=String(p==null?'':p);
  if(!raw||!s) return false;
  if(s===raw) return true;
  // 구분자는 **자식 경로**에게 묻는다. 루트가 드라이브 뿌리(`C:\\`)이면 그
  // 문자열만으로는 구분자를 알 수 없다.
  const sep=pathSep(s);
  // 끝의 구분자는 있으나 없으나 같은 자리다 — 접두를 만들 때 한 번만 붙인다.
  const base=raw.endsWith(sep)?raw.slice(0,-sep.length):raw;
  if(s===base) return true;
  return s.startsWith(base+sep);
}

/**
 * 그 경로의 **마지막 조각**. 사람에게 보이는 이름이다.
 *
 * `split('/')` 로는 안 된다 — Windows 의 절대경로는 `C:\\Users\\x\\repo` 이고
 * 그 문자열에는 `/` 가 하나도 없어 **경로 전체가 이름으로 나온다** (러너 실측:
 * Changes 머리의 리포명 자리에 절대경로가 통째로 찍혔다). 구분자는 `pathSep` 이
 * 그 경로에게 묻는다.
 */
function pathBase(p){
  const s=String(p==null?'':p);
  if(!s) return '';
  const parts=s.split(/[\\/]+/).filter(Boolean);
  return parts.length?parts[parts.length-1]:s;
}

/**
 * `root` 아래의 절대경로를 **git 의 상대경로**로 옮긴다.
 *
 * git 은 어느 OS 에서도 `/` 로 답한다. 상태·색·접어 올림의 키가 그 값이므로,
 * 화면이 든 경로(그 OS 의 구분자)를 키로 쓰려면 여기서 한 번 맞춰야 한다 —
 * 맞추지 않으면 Windows 에서 **어느 행도 자기 상태를 찾지 못한다**.
 */
function pathRel(root,p){
  const r=String(root==null?'':root), s=String(p==null?'':p);
  if(!r||s===r) return '';
  const cut=r==='/'?1:r.length+1;
  return s.slice(cut).replace(/\\/g,'/');
}

/**
 * `root` 기준의 상대경로. **사람이 붙여넣을 값이다** (M9_SRS FR-M9-19 / D-M9-10).
 *
 * 위 `pathRel` 과 **다른 함수**인 이유가 셋이다. 저쪽은 git 의 키를 만든다:
 *   ① 구분자를 `/` 로 굳힌다 — git 이 어느 OS 에서도 그렇게 답하기 때문이다.
 *      이쪽은 **그 경로의 구분자를 지킨다** (`pathSep`). 사람이 붙여넣는 자리는
 *      그 OS 의 셸·편집기이고, 거기서 `C:\a\b` 를 `C:/a/b` 로 주면 틀린 값이다
 *   ② 루트 밖을 거르지 않는다 — 키를 만들 때는 호출자가 이미 아래임을 안다.
 *      이쪽은 사용자의 우클릭에서 오므로 `pathUnder` 로 **먼저 묻는다**. 아니면
 *      절대를 그대로 준다 (`/a/bc` 가 `/a/b` 아래로 잡히던 함정도 그 판정이 막는다)
 *   ③ 루트 자신에 `''` 를 준다. 빈 문자열은 붙여넣을 것이 없다는 뜻이 되므로
 *      여기서는 **그 이름**(`pathBase`)이다
 *
 * 둘을 한 함수로 합치지 않는다 — 합치면 플래그가 셋 붙고, 그 플래그를 잘못 준
 * 자리는 조용히 틀린다.
 */
function pathRelative(root,p){
  const s=String(p==null?'':p);
  const r=String(root==null?'':root);
  if(!r||!s) return s;
  if(!pathUnder(r,s)) return s;
  const sep=pathSep(s);
  const base=r.endsWith(sep)?r.slice(0,-sep.length):r;
  if(s===base||s===r) return pathBase(s);
  return s.slice(base.length+sep.length);
}
