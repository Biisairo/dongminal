/**
 * Remote Terminal — 레이아웃 트리·병합과 탭 이름의 출처
 *
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-6 (FEC-24): 옛 helpers.js 에서 주제별로 갈라 왔다. 본문은
 * 바꾸지 않았다. index.html 이 옛 helpers.js 자리에 같은 순서로 싣는다.
 */

// ── Layout helpers ──

function normalizeTab(tab) {
  if (!tab.type) tab.type = tab.toolId ? TAB_TYPE_TERMINAL : TAB_TYPE_EDITOR;
  return tab;
}

// FR-EM-13: 도구 타입별 능력. 백그라운드로 보낼 수 있는 도구는 서버(데몬)가
// 소유하는 실행 실체가 있는 것뿐이다 — editor 는 브라우저 메모리에만
// 존재하므로 탭에서 떼어낼 실체가 없다. git 탭도 같다 — PTY 가 없고, 애초에
// 닫히지도 않는 고정 탭이다 (FR-GIT-28).
const TOOL_CAPABILITIES = {
  terminal: { backgroundCapable: true },
  editor:   { backgroundCapable: false },
  git:      { backgroundCapable: false },
};
function toolBackgroundCapable(type) {
  const cap = TOOL_CAPABILITIES[type || TAB_TYPE_TERMINAL];
  return !!(cap && cap.backgroundCapable);
}
function normalizeLayout(n) {
  if (!n) return n;
  if (n.type === 'pane' && n.tabs) n.tabs.forEach(normalizeTab);
  if (n.type === 'split' && n.children) n.children.forEach(normalizeLayout);
  return n;
}

/**
 * FR-GIT-186: Git 창은 **닫힌 창**이다 (FR-GIT-179) — GIT_VIEWS 의 고정 탭뿐이고 분할이
 * 없다. 개정 이전 워크스페이스는 그 안에 터미널·편집기 탭과 분할 칸을 가질 수
 * 있으므로, 로드 시 **일반 창으로 옮긴다.** 조용히 버리지 않는다 — 사용자의
 * 작업 상태다.
 *
 * `mkWindow()` 는 받을 일반 창이 하나도 없을 때 부르는 콜백이고 새 창을 반환해야
 * 한다 (O19). 반환값은 옮긴 탭 수다.
 */
/**
 * REPO_TAB_UNIFY_SRS FR-RTU-70·75: **Git 창을 걷어낸다.**
 *
 * 종전에는 Git 창 안의 남의 탭(터미널·편집기)을 일반 창으로 옮기고 창은 남겼다
 * (FR-GIT-186). 이제 창 자체가 사라진다 — 저장소마다 Repo 창이 있고 git 뷰는
 * 그 본문의 탭이므로(FR-RTU-30) 이 창에는 갈 곳도 올 곳도 없다.
 *
 * **고정 뷰 탭은 버린다** (D-RTU-14). 전부 재현 가능하고 옮길 자리도 없다.
 * 남의 탭만 일반 창으로 건져 낸다 — 그쪽은 사용자가 만든 것이라 사라지면 안 된다.
 *
 * 돌려주는 값은 **옮긴 탭 수**다 (호출자가 "바뀐 것이 있나" 로 쓴다). 창을
 * 지운 것도 변화이므로 그것도 센다.
 */
function migrateGitWindows(windows,mkWindow){
  if(!Array.isArray(windows)) return 0;
  const panesOf=n=>!n?[]:(n.type==='pane'?[n]:(n.children||[]).flatMap(panesOf));
  let changed=0;
  for(let i=windows.length-1;i>=0;i--){
    const s=windows[i];
    if(!s||s.type!==WINDOW_TYPE_GIT) continue;
    const out=[];
    for(const p of panesOf(s.layout))
      for(const tab of (p.tabs||[])) if(tab&&tab.type!==TAB_TYPE_GIT) out.push(tab);
    if(out.length){
      // 받는 곳은 **일반 창**이다 — Repo 창에는 터미널 탭이 들어갈 수 없다
      // (FR-RTU-16).
      let dst=windows.find(w=>w&&w.type!==WINDOW_TYPE_GIT&&w.type!==WINDOW_TYPE_EDITOR&&w.layout);
      if(!dst) dst=mkWindow&&mkWindow();
      const dp=dst&&firstPane(dst.layout);
      if(dp){
        if(!Array.isArray(dp.tabs)) dp.tabs=[];
        for(const tab of out){dp.tabs.push(tab);changed++}
        if(!dp.activeTab&&dp.tabs.length) dp.activeTab=dp.tabs[0].id;
      }
    }
    windows.splice(i,1);
    changed++;
  }
  return changed;
}

function doSplit(n,rid,nrs,dir){
  // nrs: 단일 pane 또는 pane 배열
  const list=Array.isArray(nrs)?nrs:[nrs];
  if(n.type==='pane') return n.id===rid?{type:'split',direction:dir,children:[n,...list]}:n;
  if(n.children) n.children=n.children.map(c=>doSplit(c,rid,nrs,dir));
  return n;
}
function doRemove(n,rid){
  if(!n) return null;
  if(n.type==='pane') return n.id===rid?null:n;
  if(!n.children) return null;
  n.children=n.children.map(c=>doRemove(c,rid)).filter(Boolean);
  if(!n.children.length) return null;
  if(n.children.length===1) return n.children[0];
  return n;
}
// uuid 생성 단일 진입점 (WORKSPACE_IDENTITY_SRS FR-UNI-3/4/5).
//
// crypto.randomUUID() 는 **보안 컨텍스트 전용**이다. `start.sh --expose` /
// DONGMINAL_HOST=0.0.0.0 은 평문 HTTP 로 LAN 에 노출하므로 그 주소로 접속한
// 브라우저에서는 undefined 이고, 직접 호출하면 엔터티 생성이 TypeError 로 죽는다
// (SRS §2.7 (1)). crypto.getRandomValues() 는 비보안 컨텍스트에서도 쓸 수 있어
// 폴백 수단이 된다.
//
// Math.random() 으로 내려가지 않는다 — 조용히 비uuid·저엔트로피 id 를 발급하면
// SRS §2.2 가 닫은 충돌이 다시 열린다 (FR-UNI-4).
function newUUID(){
  if(typeof crypto==='undefined'||!crypto) throw new Error('newUUID: crypto 를 쓸 수 없다');
  if(typeof crypto.randomUUID==='function') return crypto.randomUUID();
  if(typeof crypto.getRandomValues!=='function') throw new Error('newUUID: crypto.getRandomValues 를 쓸 수 없다');
  const b=new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6]=(b[6]&0x0f)|0x40;  // version 4
  b[8]=(b[8]&0x3f)|0x80;  // variant 10
  const h=[];
  for(let i=0;i<256;i++) h.push((i+0x100).toString(16).slice(1));
  return h[b[0]]+h[b[1]]+h[b[2]]+h[b[3]]+'-'+h[b[4]]+h[b[5]]+'-'+h[b[6]]+h[b[7]]+'-'+
         h[b[8]]+h[b[9]]+'-'+h[b[10]]+h[b[11]]+h[b[12]]+h[b[13]]+h[b[14]]+h[b[15]];
}

// 엔터티 id 생성 (WORKSPACE_IDENTITY_SRS FR-WID-1).
//
// 카운터(`t${++this._t}`)는 로드된 워크스페이스의 최댓값에서 seeding 되므로 같은
// 상태를 본 두 클라이언트가 반드시 같은 다음 값을 냈다 — 충돌은 우연이 아니라
// 필연이었다. id 는 전 계층에서 opaque 문자열이라(SRS §2.5) 구 id 와 섞여도 무해하고
// 마이그레이션이 필요 없다.
function newEntityId(){return newUUID()}

// 도구 표시명 (FR-UNI-8). id 파생이 아니다 — 구분은 좌표와 cwd 가 담당한다.
const DEFAULT_TOOL_NAME='Shell';

function findPane(n,rid){
  if(!n) return null;
  if(n.type==='pane') return n.id===rid?n:null;
  if(n.children) for(const c of n.children){const f=findPane(c,rid);if(f)return f}
  return null;
}
function firstPane(n){
  if(!n) return null;
  if(n.type==='pane') return n;
  if(n.children) for(const c of n.children){const f=firstPane(c);if(f)return f}
  return null;
}
function allPids(n){
  if(!n) return [];
  // M8_UNIFIED_SRS D-C-1: "도구가 있는 탭" 이다 — 터미널과 에이전트 둘 다.
  if(n.type==='pane') return (n.tabs||[]).filter(tab=>tab.toolId).map(tab=>tab.toolId);
  if(n.children) return n.children.flatMap(c=>allPids(c));
  return [];
}
function findPath(n,rid){
  if(!n) return null;
  if(n.type==='pane') return n.id===rid?[n]:null;
  if(n.children) for(const c of n.children){const p=findPath(c,rid);if(p)return[n,...p]}
  return null;
}
function panesOf(n){
  if(!n) return [];
  if(n.type==='pane') return [n];
  return (n.children||[]).flatMap(panesOf);
}

/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-1 (FEC-21): 창 목록에서 `pred(tab,win,pane)` 가 참인
 * 첫 탭의 자리 `{win,pane,tab}`. 없으면 null. 탭 찾기마다 트리를 손으로 걷던 것을
 * `panesOf` 한 순회 위로 모은다 — 순서는 창 순서, 그 안에서 L→R·T→B 다.
 */
function findTabWhere(windows,pred){
  for(const win of windows||[]){
    if(!win||!win.layout) continue;
    for(const pane of panesOf(win.layout))
      for(const tab of (pane.tabs||[])) if(tab&&pred(tab,win,pane)) return {win,pane,tab};
  }
  return null;
}

/**
 * OPTIMISTIC_LAYOUT_SRS FR-OPL-1~8: **원격이 본 적 없는 로컬 레이아웃 변경을
 * 원격 스냅샷에 되얹는다.**
 *
 * 채택(`_applyRemoteWorkspace`)은 `this.ws=sv` 한 줄로 레이아웃을 통째로
 * 갈아끼운다. 방금 연 git 뷰 탭은 아직 로컬 배열에만 있으므로(`save` 는
 * 디바운스로 뒤따른다) 그 한 줄이 지운다 — `11 §5` 가 flaky 아홉 중 다섯을
 * 이 자리로 매핑했다.
 *
 * 지워도 되는 것은 **원격이 알았다가 없앤 것**뿐이다. `seen` 이 그 판정이며
 * 창 id 와 탭 id 두 벌이다 (FR-OPL-2). 합집합이 아닌 이유는 D-OPL-1 이다 —
 * 합집합은 다른 화면이 닫은 창을 되살려 영영 닫히지 않게 만든다.
 *
 * **`remote` 를 제자리에서 고친다** (NFR-OPL-2). 돌려주는 값은 병합 건수다.
 *
 * @param {any[]} local  이 화면의 창 배열 (`this.ws.windows`)
 * @param {any[]} remote 채택할 원격 창 배열 — 제자리에서 고쳐진다
 * @param {{windows:Set<string>,tabs:Set<string>}} seen 원격이 아는 것
 */
function mergeUnseenLayout(local,remote,seen){
  if(!Array.isArray(local)||!Array.isArray(remote)) return 0;
  const seenWins=(seen&&seen.windows)||new Set();
  const seenTabs=(seen&&seen.tabs)||new Set();
  const byId=new Map();
  const edByRoot=new Map();
  // FR-OPL-3 / D-OPL-2: 원격에 **어디에든** 있는 탭은 미관측이 아니다. 대응 창
  // 안만 보면 원격이 탭을 다른 창으로 옮긴 직후 그 탭이 둘이 된다.
  const remTabs=new Set();
  for(const w of remote){
    if(!w||!w.id) continue;
    if(!byId.has(w.id)) byId.set(w.id,w);
    if(w.type===WINDOW_TYPE_EDITOR){
      const r=(w.editor&&w.editor.root)||'';
      if(r&&!edByRoot.has(r)) edByRoot.set(r,w);
    }
    for(const p of panesOf(w.layout))
      for(const tab of (p.tabs||[])) if(tab&&tab.id) remTabs.add(tab.id);
  }
  let merged=0;
  for(const w of local){
    if(!w||!w.id) continue;
    // FR-OPL-4: id → (Editor 창이면) 루트. 재조정이 같은 루트의 창을 새 id 로
    // 세우므로(`_edReconcile` ④) id 만 보면 그 창의 탭을 전부 잃는다.
    let rw=byId.get(w.id)||null;
    if(!rw&&w.type===WINDOW_TYPE_EDITOR){
      const r=(w.editor&&w.editor.root)||'';
      if(r) rw=edByRoot.get(r)||null;
    }
    if(!rw){
      // 원격이 아는 창인데 스냅샷에 없다 = 삭제다. 되살리지 않는다.
      if(seenWins.has(w.id)) continue;
      remote.push(w);
      for(const p of panesOf(w.layout))
        for(const tab of (p.tabs||[])) if(tab&&tab.id) remTabs.add(tab.id);
      merged++;
      continue;
    }
    merged+=mergeUnseenTabs(w,rw,seenTabs,remTabs);
  }
  return merged;
}

/** FR-OPL-5~8: 대응이 있는 창 한 쌍의 탭을 맞춘다. */
function mergeUnseenTabs(lw,rw,seenTabs,remTabs){
  let rPanes=panesOf(rw.layout);
  const rById=new Map(rPanes.map(p=>[p.id,p]));
  let merged=0;
  for(const lp of panesOf(lw.layout)){
    const tabs=lp.tabs||[];
    for(let i=0;i<tabs.length;i++){
      const tab=tabs[i];
      if(!tab||!tab.id||remTabs.has(tab.id)||seenTabs.has(tab.id)) continue;
      // FR-OPL-6: 같은 id 의 칸 → 첫 칸 → 칸이 없으면 로컬 칸을 그대로 옮긴다.
      // 마지막 갈래는 `layout:null` 로 태어나는 Repo 창의 첫 탭이 정확히 그것이다
      // (FR-EDT-55 · `edEnsurePane`).
      let dst=rById.get(lp.id)||rPanes[0]||null;
      if(!dst){
        rw.layout=lp;
        rPanes=[lp];
        rById.set(lp.id,lp);
        for(const x of tabs) if(x&&x.id) remTabs.add(x.id);
        merged++;
        break;
      }
      if(!Array.isArray(dst.tabs)) dst.tabs=[];
      // FR-OPL-7 / D-OPL-4: 로컬에서 **바로 앞에 있던 탭**이 앵커다. 인덱스를
      // 그대로 쓰면 원격이 앞에 탭을 더한 경우 자리가 어긋난다.
      let at=dst.tabs.length;
      for(let k=i-1;k>=0;k--){
        const a=tabs[k];
        if(!a||!a.id) continue;
        const j=dst.tabs.findIndex(x=>x&&x.id===a.id);
        if(j>=0){at=j+1;break}
      }
      dst.tabs.splice(at,0,tab);
      remTabs.add(tab.id);
      merged++;
      // FR-OPL-8: 되얹은 것이 로컬의 활성 탭이었으면 그 자리도 살린다.
      if(lp.activeTab===tab.id) dst.activeTab=tab.id;
    }
  }
  return merged;
}

function clean(n,ok){
  if(!n) return null;
  if(n.type==='pane'){
    if(n.tabs) n.tabs=n.tabs.filter(tab=>{
      // 서버 도구에 매인 탭만 검사한다. editor·git·run 탭은 toolId 가 없어
      // 그대로 두지 않으면 로드마다 사라진다 (FR-GIT-25, FR-RVZ-9).
      //
      // `!t.toolId` 로 일반화하지 않는 이유는 toolId 없는 terminal 탭
      // (저장 중 끊긴 손상 워크스페이스)이 그때 영원히 남기 때문이다 —
      // 클릭해도 아무것도 열리지 않는 그 유령 탭을 버리는 것이 clean() 의 목적이다.
      if(tab.type===TAB_TYPE_EDITOR||tab.type===TAB_TYPE_RUN||tab.type===TAB_TYPE_GIT) return true;
      return ok.has(tab.toolId);
    });
    if(!n.tabs||!n.tabs.length) return null;
    if(!n.tabs.find(tab=>tab.id===n.activeTab)) n.activeTab=n.tabs[0].id;
    return n;
  }
  if(!n.children) return null;
  n.children=n.children.map(c=>clean(c,ok)).filter(Boolean);
  if(!n.children.length) return null;
  if(n.children.length===1) return n.children[0];
  return n;
}

// ── 탭 이름의 출처 (CONVENIENCE_SRS 묶음 N) ──

// 새 터미널 탭의 이름이자 auto/manual 판정의 기준값이다 (FR-TAN-4). 탭 레코드를 만드는
// 자리는 전부 이것을 쓴다 (FEC-31). `DEFAULT_TOOL_NAME` 과 값이 같은 것은 우연이다 —
// 저쪽은 탭 없는 도구의 표시 이름(FR-UNI-8)이라 한쪽을 바꿔도 다른 쪽은 그대로여야 한다.
const TAB_NAME_DEFAULT='Shell';
const NAME_SOURCE_AUTO='auto';
const NAME_SOURCE_MANUAL='manual';

/**
 * 탭 이름의 출처 (FR-TAN-1). `auto` 인 탭만 전경 프로세스에서 파생한 이름을
 * 받는다.
 *
 * 저장된 값이 없으면 **읽는 자리에서** 정한다 (FR-TAN-4). 마이그레이션을
 * 워크스페이스에 써 넣지 않는 이유는 FR-TAN-16 과 같다 — `nameSource` 는
 * 사용자가 실제로 이름을 준 순간에만 생겨야 하고, 로드가 그것을 지어내면
 * 지어낸 값이 영속된다.
 *
 * 이 규칙은 완전하지 않다 — 예전에 사용자가 탭 이름을 직접 `Shell` 로
 * 지정했다면 auto 로 강등된다. SRS 가 그 손실을 회복 가능한 것으로 보고
 * 수용했다. 더 정교하게 만들지 않는다.
 */
function tabNameSource(tab){
  if(!tab) return NAME_SOURCE_AUTO;
  // FR-TAN-3: editor·run·git 탭의 이름은 콘텐츠에서 파생된다 — 본 묶음의
  // 대상이 아니므로 manual 로 고정한다.
  if(tab.type===TAB_TYPE_EDITOR||tab.type===TAB_TYPE_RUN||tab.type===TAB_TYPE_GIT) return NAME_SOURCE_MANUAL;
  if(tab.nameSource===NAME_SOURCE_MANUAL||tab.nameSource===NAME_SOURCE_AUTO) return tab.nameSource;
  return tab.name===TAB_NAME_DEFAULT?NAME_SOURCE_AUTO:NAME_SOURCE_MANUAL;
}

/**
 * 탭이 화면에 내는 이름 (FR-TAN-15). 파생 이름을 받을 수 있는 것은
 * `nameSource==='auto'` 인 탭뿐이며, `manual` 은 어떤 경우에도 덮이지 않는다.
 * 설정이 꺼져 있으면 아무도 파생을 받지 않는다 (FR-TAN-20).
 *
 * `fgNames` 는 toolId → 파생 이름의 런타임 Map 이다. 워크스페이스에 들어가지
 * 않는다 — 파생 이름은 현재 상태의 표시이지 이력이 아니다 (FR-TAN-16).
 */
function tabName(tab,fgNames){
  if(!tab) return '';
  return toolDisplayName(tab.toolId,fgNames,tab,tab.name);
}

/**
 * 도구 하나의 표시 이름 (UX_REVISION_SRS FR-NAM-1~4).
 *
 * 지금까지 파생 이름을 아는 자리는 탭 하나뿐이었다 — 백그라운드 모달과 주의
 * 알림은 `Shell` 이라고만 말했다 (FR-NAM-5·6). 탭은 **있을 수도 없을 수도**
 * 있으므로(백그라운드 도구에는 탭이 없다) 탭을 선택 인자로 받는다.
 *
 * 우선순위: 탭이 manual 이면 그 이름 → 파생 이름 → fallback → `Shell`.
 * manual 을 앞에 두는 것이 FR-TAN-15 다 — 사람이 준 이름은 덮이지 않는다.
 */
function toolDisplayName(toolId,fgNames,tab,fallback){
  if(tab&&(!fgTabNames||tabNameSource(tab)!==NAME_SOURCE_AUTO)) return tab.name;
  const fg=(fgTabNames&&fgNames&&toolId)?fgNames.get(toolId):'';
  return fg||(tab&&tab.name)||fallback||DEFAULT_TOOL_NAME;
}
