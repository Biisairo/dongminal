// 사이드바 상단 탭 — windows(창) / repo(저장소) / chat(채팅) (GIT_SIDEBAR_TABS_SRS 묶음 T · REPO_TAB_UNIFY_SRS · CHAT_WINDOW_SRS).
//
// 탭은 서술자의 배열로 정의된다 (FR-SBT-18/19). 배열 순서가 표시 순서이자 직행 키
// 번호이며, 새 탭을 더하는 비용은 서술자 1개다 (FR-SBT-21) — index.html·단축키 맵·
// 순회 디스패치를 다시 열지 않는다.
//
// 로드 순서 계약: shortcuts.js **뒤**(단축키 맵을 여기서 늘린다), renderer.js **앞**
// (렌더러가 활성 탭 상태를 읽는다).
//
// 서술자의 훅은 `app` 을 인자로 받는다. 배열이 **모듈 수준의 상수**여야 단축키
// 등록(아래)이 App 인스턴스보다 먼저 돌 수 있기 때문이다 — index.html 의 로드
// 순서상 이 파일은 app.js 보다 앞에 있다.

const SB_TAB_KEY='sidebarTab'; // FR-SBT-6: 보는 방식은 클라이언트의 것이다 (D-1)

/**
 * FR-SBT-19 의 서술자 계약.
 *
 *   id          안정 식별자. 영속(FR-SBT-6)·직행 키 라벨의 키
 *   label       탭 헤더에 보이는 이름
 *   icon        접힌 사이드바(레일)에서 라벨 대신 보이는 글자 하나
 *               (SIDEBAR_COLLAPSE_SRS FR-SBC-13). 없으면 라벨의 첫 글자다
 *   panelId     이 탭이 보이게 할 패널 래퍼 id (§3.9.1)
 *   badge(app)  헤더 배지 값. 0·null 이면 표시하지 않는다 (FR-SBT-12/13)
 *   visible(app)탭 자체의 표시 여부 (FR-SBT-8)
 *   onActivate(app)     활성화 시의 콘텐츠 창 전환 (FR-SBT-22)
 *   onEnter(app)        탭이 보이게 된 직후. `silent` 여부와 **무관하게** 돈다
 *                       (FR-GOB-9) — 콘텐츠 전환이 아니라 "이제 이 패널이
 *                       화면에 있다" 는 사실에 딸린 일이 여기 온다
 *   onLeave(app)        다른 탭으로 옮긴 직후 (OPTIMIZE_REFACTOR_SRS FR-OPT-4-3) —
 *                       `onEnter` 가 쥔 것을 놓는 자리다
 *   cycle(app,dir)      순회 키가 이 탭에서 무엇을 순회하는지 (FR-SBT-31)
 *
 * 필드는 **창 목록이 실제로 하는 일**에서 뽑았다 — 쓰이지 않는 훅은 만들지 않는다.
 */
/**
 * ISSUE_AGENT_TREE_SRS FR-WGR-20: 그룹 머리 행. 접기 표시는 CSS(`.si-group.folded`)가 그린다.
 * 열기 = 접고 펴기, 이름 고치기 = 그룹 이름, 지우기 = 그룹만 지우고 창은 남긴다.
 */
function groupRow(app,e){
  const g=e.group,n=e.windows.length;
  const tree=g.tree?t('sidebar.group_tree',{ref:g.tree.repo+'#'+g.tree.root}):'';
  return {
    name:g.name,
    title:tn('sidebar.group_title',n,{name:g.name})+(tree?' · '+tree:''),
    cls:['si-group',e.folded?'folded':'',g.tree?'si-group-tree':''].filter(Boolean).join(' '),
    attn:app.groupHasAttn(e),
    badge:{text:String(n),cls:'si-group-count'},
    removable:true,
    removeTitle:t('sidebar.group_remove'),
    dataset:{groupId:g.id},
    onOpen:a=>a.wgFoldToggle(g.id),
    onRemove:a=>a.deleteGroup(g.id),
    onRename:(a,el)=>a.rename(g,el),
  };
}

const SB_TAB_DEFS=[
  {
    id:'windows',label:t('sidebar.tab_windows'),icon:'app-window',  // UX_AUDIT_FIX_SRS FR-UXF-100: 이전 `terminal`(Background 와 닮았다)
    panelId:'sb-panel-windows',
    // FR-TIP-1·2: 무슨 탭인지 영어로 알린다. 라벨만으로는 이 목록이
    // **무엇의** 목록인지 처음 보는 사용자에게 보이지 않는다.
    title:'Terminal windows in this workspace',
    // FR-SBT-13: 알람이 있는 창 수. `.si.attn` 이 목록 안에서만 알리던 것을 탭까지 끌어올린다.
    badge:app=>app.plainWindows().filter(s=>app.windowHasAttn(s)).length,
    // FR-SBT-22·23: 마지막으로 활성이었던 일반 창. 대상 계산은 `gitBackTarget`
    // 한 자리다 (FR-SBT-36).
    onActivate:app=>{const w=app.gitBackTarget();if(w)app.switchWindow(w.id)},
    // UX_REVISION_SRS FR-BLP-1~3: 목록의 서술자. 그리는 일도 순회도 SidebarList 가
    // 한다 — 이 탭이 주는 것은 **타깃뿐**이다.
    list:{
      containerId:'windows',
      // FR-BLP-6: 기존 클래스는 보존한다 — e2e 와 CSS 가 그 위에 서 있다.
      itemClass:'si',dotClass:'si-dot',nameClass:'si-name',xClass:'si-x',
      actions:['add-window','add-preset','add-group'],
      // FR-GIT-182: Git 창은 이 목록에 없다 — 진입점은 GIT 탭의 리포 항목뿐이다.
      // ISSUE_AGENT_TREE_SRS FR-WGR-20: 그룹 머리가 같은 목록의 행으로 섞인다.
      items:app=>app.sidebarWindowEntries(),
      key:s=>s.kind==='group'?WG_KEY+s.group.id:s.id,
      // FR-BLP-15~18: 순회. 규약은 블루프린트가 갖고, 여기는 타깃만 준다.
      cycle:{
        // 그룹 머리는 순회 대상이 아니다 — 창만 돈다.
        filter:s=>s.kind!=='group',
        currentKey:app=>app.ws.activeWindow,
        open:(app,s)=>app.switchWindow(s.id),
      },
      // FR-MOV-1: 창 항목은 탭을 받는다. 지금 보고 있는 창은 받을 이유가 없다 —
      // 같은 창 안의 이동은 분할 칸의 탭 바가 이미 한다.
      tabDrop:{
        accepts:(app,r)=>r.key!==app.ws.activeWindow&&!String(r.key).startsWith(WG_KEY),
        drop:(app,r,dr)=>app.moveTabToWindow(dr.srcPaneId,dr.tabId,r.key),
      },
      row:(app,s)=>s.kind==='group'?groupRow(app,s):({
        name:s.name,
        cls:s.groupId?'si-in-group':'',
        active:s.id===app.ws.activeWindow,
        // FR-PAN-16: 알람이 있는 창을 사이드바에서 구분 표시.
        attn:app.windowHasAttn(s),
        work:app.windowWorkDot(s),   // UX_AUDIT_FIX_SRS FR-UXF-62
        // SANDBOX_WINDOW_SRS: 격리된 창임을 목록에서 구분한다. 어느 창이
        // 샌드박스인지 알 수 없으면 사용자가 격리를 신뢰할 근거가 없다.
        // SANDBOX_PICK_COPY_SRS FR-SPK-21·22: 작업 폴더가 복사본인 창은 그
        // 사실을 함께 적는다 — 컨테이너 안의 변경이 호스트로 돌아오지 않는다는
        // 것은 창을 여는 순간에만 말하고 끝낼 성질이 아니다. 폴더를 실제로 받은
        // 창에만 붙는다 (복사한 것이 없으면 뜻이 없다).
        // UX_AUDIT_FIX_SRS FR-UXF-100: 앞의 표식은 아이콘 `box` 다(이전 글자 `▣`).
        badge:s.sandbox?{icon:'box',text:s.sandbox+(s.sandboxCopy?' · '+SANDBOX_COPY_BADGE:''),
          cls:'si-sbx',
          title:t('sbx.window_badge_title')
            +(s.sandboxCopy?String.fromCharCode(10)+SANDBOX_COPY_BADGE_TITLE:'')}:null,
        removable:true,
        dataset:{sid:s.id,windowType:s.type||WINDOW_TYPE_TERMINAL},
        onOpen:app=>app.switchWindow(s.id),
        onRemove:app=>app.delWindow(s.id),
        onRename:(app,el)=>app.rename(s,el),
      }),
      reorder:{
        type:'window',
        // ISSUE_AGENT_TREE_SRS FR-WGR-24: 그룹 안팎·그룹 통째 이동은 순서 함수가 정한다
        // (FR-WGR-4 의 불변식을 끌어 놓기도 지킨다).
        apply:(app,dr)=>app.sidebarReorder(dr),
        // FR-WGR-24 (개정): 그룹의 첫 창 위·마지막 창 아래에서 포인터가 행의 가로 가운데보다 왼쪽(패널 왼쪽 밖 포함)이면 그룹 밖이다.
        //   이전: 들여쓰기(22px) 왼쪽일 때만 — 그 띠에 포인터를 정확히 올리기 어려웠다
        outside:(app,key,el,x,before)=>{
          const r=el.getBoundingClientRect();
          return el.classList.contains('si-in-group')&&x<r.left+r.width/2&&!!app.wgEdgeGroup(key,before);
        },
        // 창 순서는 클라이언트가 workspace.json 에 쓴다 — 서버 확정이 없다.
        // FR-AGG-3: agents 패널의 그룹 순서는 이 배열에서 파생하므로(D-9) 같은
        // 자리에서 다시 그린다 — 폴링을 기다리면 방금 만든 순서를 한 박자 늦게 본다.
        commit:app=>{app.save();if(app.agentsRender)app.agentsRender()},
      },
    },
  },
  {
    /**
     * REPO_TAB_UNIFY_SRS FR-RTU-1: **`Git` 과 `Editor` 를 대신하는 하나의 탭.**
     *
     * 둘을 합치는 근거는 목록이 이미 같은 집합이라는 것이다 (§2.1) — `git.pinned`
     * 와 `editors.list` 는 서버 연동이 한 번의 저장 안에서 함께 바꾼다. 화면만
     * 둘로 그리고 있었고, 그래서 `+ Add` 한 번이 두 목록에 나타나는 것을 사용자가
     * 두 가지 일로 읽었다.
     *
     * 배열 순서가 곧 직행 키 번호이므로 이 탭은 `Ctrl+Shift+Digit2` 다.
     * `sidebarTab3` 은 파생이 사라지면서 함께 사라진다 (FR-RTU-7).
     */
    id:REPO_TAB_ID,label:REPO_TAB_LABEL,icon:'git-branch',panelId:REPO_PANEL_ID,
    title:'Repositories and folders opened as editor windows',
    // FR-EDT-120: 목록의 원천은 `/api/editors` 다 — 그것이 없으면 행을 만들 수
    // 없다. **git 이 없는 것은 사유가 되지 않는다** (FR-RTU-9 / D-RTU-12):
    // 탐색기와 편집기는 git 없이 성립하고, 그때 Changes 사이드가 사유를 보인다.
    visible:app=>app.edOn(),
    // FR-RTU-6: 헤더 배지는 두지 않는다 — 근거 없는 숫자를 남기지 않는다는
    // FR-GOB-13 의 판단이 그대로다. 개수는 행마다 붙는다.
    // FR-EDT-7: 탭을 고르면 콘텐츠 창까지 바뀐다.
    onActivate:app=>{const w=app.edActivateTarget();if(w)app.switchWindow(w.id)},
    // FR-GOB-9: 들어간 순간 등록된 리포 전부를 관측한다. 다음 폴링(3초)을
    // 기다리면 사용자는 낡은 배지를 먼저 본다.
    //
    // 둘 다 합치는 줄(`gitReposKick`)로 보낸다 — 들고 나기를 빨리 되풀이하면 `observe=1`
    // 과 `observe=0` 이 동시에 떠 서버에 뒤바뀐 순서로 닿고, 임대가 남거나 사라진다.
    onEnter:app=>{if(app.gitReposKick)app.gitReposKick()},
    // OPTIMIZE_REFACTOR_SRS FR-OPT-4-3: 떠나면 핀 임대를 놓는다 (`observe=0`).
    onLeave:app=>{if(app.gitReposKick)app.gitReposKick()},
    list:{
      containerId:REPO_LIST_ID,
      // FR-EDT-14 / FR-NOT-10: 고정 항목(root·메모장)의 자리는 **패널 최하단**이다.
      fixedContainerId:REPO_ROOT_ID,
      itemClass:'ed-entry',dotClass:'ed-entry-dot',
      nameClass:'ed-entry-name',xClass:'ed-entry-x',badgeClass:'git-badge',
      actions:[REPO_ADD_ID],
      // 첫 응답 전에는 "없다" 를 말하지 않는다.
      ready:app=>!!app.editors,
      emptyText:REPO_ENTRIES_NONE,emptyClass:'ed-entries-none',
      items:app=>app.edEntries(),
      key:e=>'ed:'+e.path,
      fixed:app=>app.edFixed(),
      // FR-RTU-8: 순회 대상은 `items` 뒤에 `fixed` 를 이어 붙인 순서다 — 고정 행이
      // 마지막 자리로 **포함된다.** 제외하면 키만으로는 거기 갈 수 없다.
      cycle:{
        currentKey:app=>{
          const w=app.aw();
          return app.isEditorWin(w)?('ed:'+app.edRootOf(w)):null;
        },
        open:(app,e)=>app.edOpenWindow(e.path),
      },
      row:(app,e)=>{
        const w=app.edWindowFor(e.path);
        // FR-NOT-10: 고정 행 둘(`~`·메모장)은 지울 수 없고 재배치의 출발점도
        // 대상도 아니다. 가르는 것은 클래스뿐이며 CSS 가 그것을 딛는다.
        const pinned=!!e.root||!!e.notes;
        // FR-RTU-6: 변경 개수는 **git 쪽 관측**에서 온다. 두 목록이 같은 집합이므로
        // 경로로 짝지으면 되고, 저장소가 아닌 행에는 배지가 없다.
        const b=app.gitBadgeFor(e.path);
        const stale=!!b&&gitBadgeStale(b);
        /**
         * FR-RMS-11·17: 저장소였던 자리가 **사라졌다면** 행이 그 사실을 말한다.
         *
         * 옛 `Git` 목록의 행이 하던 일이며 두 탭을 합칠 때 빠졌다 (실측). 사유는
         * 코드가 아니라 사람이 읽는 문구로 옮긴다 — `repo_missing` 을 날것으로
         * 보이면 사용자는 그것이 무엇인지 모른다.
         *
         * **저장소가 아닌 것과 사라진 것은 다르다.** 저장소가 아닌 경로는 이제
         * 정당한 행이므로(FR-RTU-9 / D-RTU-12) 사유를 적지 않는다 — 핀 항목이
         * 있고 그 항목이 실패를 실어 왔을 때만이다.
         */
        const pin=app.gitPinEntry(e.path);
        const gone=!!pin&&pin.isRepo===false&&!!pin.reason;
        const why=gone?(GIT_WRITE_ERR[pin.reason]||pin.reason):'';
        const cls=[e.root?'ed-root':(e.notes?'ed-notes':''),gone?'norepo':'']
          .filter(Boolean).join(' ');
        return {
          // FR-EDT-10 / FR-NOT-9: 표시 이름은 경로의 마지막 조각, 툴팁은 절대경로.
          name:app.edName(e.path),
          title:why?e.path+' — '+why:e.path,
          active:!!w&&w.id===app.ws.activeWindow,
          cls,
          /**
           * 배지는 서버의 마지막 관측값이다. 0 을 보일 이유는 없다 (FR-GIT-14).
           *
           * WORDING_COLOR_SRS FR-WRD-81~83 (SAFETY_CORRECTNESS_SRS FR-SAF-21 의
           * 남은 절반):
           *   이전 동작: `total` 을 **정확한 수처럼** 그렸다. git 의 출력이 1MiB
           *             상한에서 잘린 저장소에서 그 수는 하한인데 화면은 그것을
           *             말하지 않았다 — `web/` 에서 `outputTruncated` 를 읽는
           *             자리가 **0** 이었다
           *   새  동작: 잘렸으면 `N+` 로 그리고 툴팁이 사유를 말한다
           *   이유:     틀린 수를 확정적으로 말하는 것이 모르는 것보다 나쁘다
           *
           * `+` 는 새 기호가 아니다 — 잘린 그룹 머리글(`git-group-count`,
           * FR-GDT-24)과 편집기 검색(`editor-search.js`)이 이미 같은 표기를 쓴다.
           * **잘렸다는 사실이 개수의 뜻을 바꾸므로 그 설명이 낡음보다 앞선다**
           * (`git-changes.js` 가 같은 순서를 쓴다).
           */
          badge:(b&&b.total>0)?{
            text:String(b.total)+(b.outputTruncated?'+':''),
            cls:stale?'stale':'',
            title:b.outputTruncated?t('git.badge_truncated')
              :(stale?t('git.badge_stale',{at:new Date(b.observedAtUnixMs).toLocaleTimeString()}):''),
          }:null,
          // CLAUDE_ACCOUNTS_SRS FR-CAC-96: 저장소 루트에 적용되는 폴더 연결의 계정.
          chip:app.claudeRepoChip?app.claudeRepoChip(e.path):null,
          fixed:pinned,
          removable:!pinned,
          dataset:{edRoot:e.path,gitRepo:e.path},
          onOpen:app=>app.edOpenWindow(e.path),
          // FR-RTU-5 의 대칭: 제거도 하나다 — `/api/editors/remove` 가 연동으로
          // 핀까지 함께 지운다 (FR-EDT-34).
          onRemove:pinned?null:(app=>app.edRemove(e.path)),
        };
      },
      // FR-EDT-12·27: 순서는 서버가 권위다 — (src,target,before) 델타다.
      reorder:{
        type:'editor',
        apply:(app,dr)=>{
          const arr=(app.editors||{}).list;
          if(!Array.isArray(arr)) return false;
          const key=p=>'ed:'+p;
          const si=arr.findIndex(x=>key(x)===dr.src); if(si<0) return false;
          const[moved]=arr.splice(si,1);
          let ti=arr.findIndex(x=>key(x)===dr.target);
          if(ti<0) arr.push(moved); else { if(!dr.before) ti++; arr.splice(ti,0,moved) }
          app.edMirror();
          return true;
        },
        commit:(app,dr)=>app.edReorder(dr),
      },
    },
  },
  SB_CHAT_TAB, // CHAT_WINDOW_SRS FR-CW-20: 셋째 탭 — 서술자는 sidebar-tab-chat.js
];

/**
 * FR-SBT-26·28·30: 직행 키를 서술자 배열의 인덱스에서 파생시킨다.
 *
 * 니모닉 키(`G`=Git)라면 탭이 늘 때마다 키를 발명하고 충돌을 검사해야 한다. 번호는
 * 자동으로 나오므로 새 탭을 더할 때 단축키를 고민하지 않는다 (D-9·D-10).
 *
 * **네 자리를 함께 채운다** — 기본값 맵·라벨 맵·현재 바인딩·영속. 하나만 고치면
 * 설정 화면에서 사라진다. `shortcuts` 까지 여기서 채우는 이유는 shortcuts.js 가
 * 이 파일보다 먼저 로드되어 `{...SHORTCUT_DEFAULTS}` 를 이미 떠 갔기 때문이다.
 */
function sbTabAction(i){return 'sidebarTab'+(i+1)}
for(let i=0;i<SB_TAB_DEFS.length&&i<SB_JUMP_MAX;i++){
  const k=sbTabAction(i);
  SHORTCUT_DEFAULTS[k]='Ctrl+Shift+Digit'+(i+1);
  SHORTCUT_LABELS[k]=t('shortcut.sidebar_tab',{label:SB_TAB_DEFS[i].label});
  shortcuts[k]=SHORTCUT_DEFAULTS[k];
}
/**
 * REPO_TAB_UNIFY_SRS FR-RTU-7: **탭이 줄면 파생도 줄어야 한다.**
 *
 * 탭 셋이 둘이 되면서 `sidebarTab3` 이 갈 곳을 잃었다. 그런데 그 값은 사용자의
 * 설정 파일에 이미 저장돼 있을 수 있고(`settings.json` 의 `shortcuts`), 그대로
 * 두면 설정 화면에 **아무 데도 가지 않는 단축키**가 남는다 — 눌러도 아무 일이
 * 없는 항목은 고장으로 읽힌다.
 */
for(let i=SB_TAB_DEFS.length;i<SB_JUMP_MAX;i++){
  const k=sbTabAction(i);
  delete SHORTCUT_DEFAULTS[k];
  delete SHORTCUT_LABELS[k];
  delete shortcuts[k];
}

/**
 * 사이드바 탭 줄의 입구 (REFACTOR3_FE_BASE_SRS FR-FEB-21 · INV-F2). 하는 일은 `SidebarTabBar`(sidebar-tab-bar.js)가 맡고,
 * 이 객체는 렌더러·App 이 부르던 이름을 그 인스턴스(`app.sbPanel().tabs`)에 넘긴다. 이름을 지우는 일은 단계 9 다.
 */
const SidebarTabs={
  bar(app){ return app.sbPanel().tabs },
  visible(app){ return this.bar(app).visibleDefs() },
  def(app,id){ return this.bar(app).def(id) },
  labelForWindow(app,w){ return this.bar(app).labelForWindow(w) },
  restore(){ return TabBar.restoreFrom(SB_TAB_KEY,SB_TAB_DEFS) },
  setTab(app,id,opts){ this.bar(app).select(id,opts) },
  syncToWindow(app){ this.bar(app).syncToWindow() },
  jumpTo(app,n){ this.bar(app).jump(n) },
  paint(app){ this.bar(app).paint() },
  build(app,d){ return this.bar(app).buildTab(d) },
  updateBadges(app){ this.bar(app).paintBadges() },
  panelOf(id){ return SidebarTabBar.panelOf(id) },
};
