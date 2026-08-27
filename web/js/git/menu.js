/**
 * Dongminal — Git 컨텍스트 메뉴 프레임워크 (GIT_SRS §3C.2 / FR-GIT-146)
 *
 * 표면 지도 S4 의 46개 항목이 이 위에 선형으로 얹힌다. 대상 종류별로 항목 집합을
 * **선언**하면 렌더·키보드 조작·닫기가 공통 경로를 탄다 — 항목이 늘어도 새 메뉴
 * 코드가 늘지 않는다.
 *
 * 5단계가 만든 파일 우클릭 메뉴(`.git-ctxmenu`)를 이것이 흡수했다. 같은 것을 두 번
 * 만들지 않는다.
 *
 * 항목의 모양:
 *   {id, label, run(target), disabled(target)→사유|'', warn, destructive,
 *    action, title, targets(target)→[문자열], hint(target)→{note,command}}
 *   {sep:true}
 *
 * 확인은 **항목이 따로 쓰지 않는다** — `warn:true` 는 1단계, `destructive:true` 는
 * 9단계 `GitConfirm` 의 2단계 확인을 프레임워크가 자동으로 거친다.
 */

// 항목의 run·disabled 는 패널을 통해 동작한다 — 메뉴는 대상과 항목만 알고, 무엇을
// 실행하는지는 패널이 안다.
function gitMenuPanel(){return (window.app&&app.gitPanel)||null}

// FR-GIT-250.2: 파괴적 태그 항목의 확인 문구에 실을 **지우기 전 oid**. 값을 모르면
// 지어내지 않는다 — 서버가 실행 전에 진짜 oid 로 hint 를 남긴다 (FR-GIT-92).
function gitTagOid(t){
  return GitTag.oidOf(gitMenuPanel(),t)||GIT_TAG_OID_UNKNOWN;
}

/**
 * FR-GIT-252: 진행 중 작업이 있으면 **새 작업을 시작할 수 없다.**
 *
 * merge·rebase·cherry-pick·revert 가 멈춘 상태에서 또 하나를 시작하면 git 이
 * 거부하고, 그 거부는 exit 128 의 문구로만 온다. 항목을 막되 **사유를 보인다** —
 * 왜 못 누르는지 보이지 않으면 사용자는 고장으로 읽는다 (FR-GIT-180).
 *
 * 판정 근거는 관측 하나다 (`status.operation`, FR-GIT-251) — 항목마다 다시 세면
 * 한 곳이 빠져도 조용히 지나간다.
 */
function gitOpBusy(){
  const p=gitMenuPanel(); if(!p||typeof p.statusOf!=='function') return '';
  const op=(p.statusOf()||{}).operation;
  const kind=(op&&op.kind)||'';
  if(!kind) return '';
  return GIT_MENU_OP_BUSY.replace('%s',GIT_OP_LABEL[kind]||kind);
}

/**
 * FR-GIT-222: 행 더블클릭이 고르는 후보다. 순서가 우선순위이고, 비활성이 아닌
 * 첫 항목이 그 행의 기본 동작이 된다.
 *
 * **태그는 없다.** 태그 체크아웃은 detached 가 되는 동작이라 경고가 필요하고
 * (FR-GIT-144), 경고가 필요한 것을 가벼운 제스처에 싣지 않는다.
 */
const GIT_MENU_PRIMARY={
  branch:['checkout','checkout-local'],
};

const GIT_MENUS={
  // 커밋 (FR-GIT-140~144). 저장소를 바꾸는 항목은 checkout 하나다.
  commit:[
    // FR-GIT-141: 18단계의 생성 다이얼로그를 시작점만 이 커밋으로 고정해 연다 —
    // 이름 검증(FR-GIT-159)까지 그것이 이미 안다.
    {id:'branch-from',label:'여기서 브랜치 생성…',
     run:t=>gitMenuPanel().createBranchFrom(t.oid)},
    // FR-GIT-260: 태그 생성의 **같은 다이얼로그**를 대상만 이 커밋으로 고정해 연다
    // — 이름 검증도 종류 선택도 그것이 이미 안다.
    {id:'tag-from',label:GIT_TAG_CREATE_AT,
     run:t=>gitMenuPanel().createTag(t.oid)},
    {id:'copy-hash',   label:'커밋 해시 복사',run:t=>gitMenuPanel().copyText(t.oid)},
    {id:'copy-subject',label:'커밋 제목 복사',run:t=>gitMenuPanel().copyText(t.subject)},
    {sep:true},
    // FR-GIT-144: detached 가 됨을 사전 경고하고, dirty 면 묶음 N 의 3선택을
    // 거친다 — 태그 메뉴와 같은 경로다. 판정을 두 벌로 만들지 않는다.
    {id:'checkout-detached',label:'Checkout (detached)',warn:true,
     action:GIT_CHECKOUT_DETACHED_ACT,title:GIT_CHECKOUT_DETACHED_TITLE,
     targets:t=>[t.abbrev+(t.subject?' '+t.subject:'')],
     hint:()=>({note:GIT_DETACHED_NOTE,command:''}),
     run:t=>gitMenuPanel().checkoutRef(t.oid,{detach:true})},
  ],
  // 파일 (S1 목록 / History 상세 목록). 저장소를 바꾸는 항목이 하나도 없다
  // (FR-GIT-41) — 5단계의 GIT_CTX_ITEMS 를 그대로 옮긴 것이다.
  file:[
    {id:'openChanges',label:'Open Changes',run:t=>gitMenuPanel().openFileDiff(t)},
    // FR-GIT-236: 행 인라인 동작과 같은 자리를 지난다 — 두 벌로 두면 한쪽만 고쳐진다.
    {id:'openFile',   label:'Open File',   run:t=>gitMenuPanel()._run('openFile',[t])},
    // FR-GIT-274: 워킹 트리가 아니라 `HEAD:<path>` 의 내용이다. 여는 자리는
    // Open File 과 같다 — Git 창이 아닌 창이다 (FR-GIT-179·185).
    {id:'openFileHead',label:GIT_FILE_OPEN_HEAD,run:t=>gitMenuPanel().openFileAtHead(t)},
    {id:'copyPath',   label:'Copy Path',   run:t=>gitMenuPanel().copyText(gitMenuPanel().absPath(t))},
    {sep:true},
    // FR-GIT-275: path 필터가 이미 있으므로(FR-GIT-129) 그것을 채워 탭을 여는 것이
    // 전부다 — 새 조회를 만들지 않는다.
    {id:'fileHistory',label:GIT_FILE_HISTORY,run:t=>gitMenuPanel().openFileHistory(t)},
    // FR-GIT-273: **git 실행이 아니라 파일 쓰기다.** 저장소 루트의 `.gitignore`
    // 하나만 대상이며, 경로가 그 안인지는 서버가 다시 본다.
    {id:'ignore',     label:GIT_FILE_IGNORE,run:t=>gitMenuPanel().ignorePath(t)},
  ],
  // 브랜치·태그 (FR-GIT-154·155·156·160). 로컬과 원격은 **뜻이 다른 두 항목**이다 —
  // 원격 ref 로 그냥 옮겨 가면 detached 가 되므로 같은 이름의 로컬을 만들며 추적을
  // 설정한다 (FR-GIT-156). 어느 쪽이 왜 막혔는지는 사유로 알린다.
  branch:[
    {id:'copy-name',label:'브랜치 이름 복사',run:t=>gitMenuPanel().copyText(t.short)},
    {id:'checkout', label:'Checkout',
     disabled:t=>t.kind===GIT_REF_KIND_REMOTE?GIT_MENU_REMOTE_REF:(t.isHead?GIT_MENU_CURRENT:''),
     run:t=>gitMenuPanel().checkoutRef(t.short,{})},
    {id:'checkout-local',label:GIT_BR_CHECKOUT_LOCAL,
     disabled:t=>t.kind===GIT_REF_KIND_REMOTE?'':GIT_MENU_LOCAL_ONLY,
     run:t=>gitMenuPanel().checkoutRemote(t.short)},
  ],
  // 태그 (FR-GIT-260~262). 생성은 대상을 묻지 않고 열린다 — 비우면 HEAD 다.
  //
  // **삭제가 둘인 것이 이 메뉴의 요점이다** (FR-GIT-261): 로컬과 원격은 다른
  // 항목이고 하나가 다른 하나를 자동으로 하지 않는다. 둘 다 `destructive:true`
  // 이므로 2단계 확인은 프레임워크가 거치고, 항목은 **되살리는 명령**만 선언한다
  // — 그 명령은 지우기 전 oid 를 싣는다 (FR-GIT-92·250.2).
  tag:[
    {id:'create',label:GIT_TAG_NEW,run:()=>gitMenuPanel().createTag('')},
    {id:'copy-name',label:'태그 이름 복사',run:t=>gitMenuPanel().copyText(t.short)},
    // 태그는 브랜치가 아니므로 옮겨 가면 detached 다 — 사전 경고를 1단계 거친다
    // (FR-GIT-144 와 같은 규약).
    {id:'checkout', label:'Checkout (detached)',warn:true,
     action:GIT_CHECKOUT_DETACHED_ACT,title:GIT_CHECKOUT_DETACHED_TITLE,
     targets:t=>[t.short],
     hint:()=>({note:GIT_DETACHED_NOTE,command:''}),
     run:t=>gitMenuPanel().checkoutRef(t.short,{detach:true})},
    {sep:true},
    // push 는 파괴적이 아니다 — 원격에 없던 ref 를 더할 뿐이다. 원격 작업이므로
    // job 경로를 탄다 (FR-GIT-262·101~104).
    {id:'push',    label:GIT_TAG_PUSH,    run:t=>gitMenuPanel().tagPush(t.short)},
    {id:'push-all',label:GIT_TAG_PUSH_ALL,run:()=>gitMenuPanel().tagPushAll()},
    {sep:true},
    {id:'delete',label:GIT_TAG_DELETE,destructive:true,
     action:GIT_ACT_TAG_DELETE,title:GIT_TAG_DELETE_TITLE,
     targets:t=>[t.short],
     hint:t=>({note:GIT_TAG_DELETE_NOTE,
       command:'git tag '+t.short+' '+gitTagOid(t)}),
     run:t=>gitMenuPanel().tagDelete(t.short)},
    {id:'delete-remote',label:GIT_TAG_DELETE_REMOTE,destructive:true,
     action:GIT_ACT_REMOTE_REF_DELETE,title:GIT_TAG_DELETE_REMOTE_TITLE,
     targets:t=>[t.short],
     hint:t=>({note:GIT_TAG_DELETE_REMOTE_NOTE,
       command:'git push '+GitTag.remoteOf(gitMenuPanel())+' '+gitTagOid(t)+
         ':refs/tags/'+t.short}),
     run:t=>gitMenuPanel().tagDeleteRemote(t.short)},
  ],
  // stash (FR-GIT-162~164·168). drop 만 파괴적이며 확인은 프레임워크가 거친다 —
  // 항목이 확인 코드를 따로 쓰지 않는다.
  stash:[
    {id:'apply',      label:GIT_STASH_APPLY,      run:t=>gitMenuPanel().stashApply(t.index,false)},
    {id:'apply-index',label:GIT_STASH_APPLY_INDEX,run:t=>gitMenuPanel().stashApply(t.index,true)},
    {id:'pop',        label:GIT_STASH_POP,        run:t=>gitMenuPanel().stashPop(t.index)},
    {sep:true},
    {id:'drop',label:GIT_STASH_DROP,destructive:true,
     action:GIT_ACT_STASH_DROP,title:GIT_STASH_DROP_TITLE,
     targets:t=>[GitStash.label(t)],
     // hint 는 지워질 stash 의 sha 로 만든다 — 안내문만 남기면 되살릴 수 없다
     // (FR-GIT-92·168). 서버도 실행 전에 같은 것을 HintLog 에 남긴다.
     hint:t=>({note:GIT_STASH_DROP_NOTE,
       command:'git stash store -m '+gitShQuote(t.message||'')+' '+(t.oid||'')}),
     run:t=>gitMenuPanel().stashDrop(t.index)},
    {sep:true},
    // FR-GIT-272: 그 stash 를 새 브랜치에 적용하며 옮겨 간다. **파괴적이 아니다**
    // — git 은 적용이 끝난 뒤에만 stash 를 지운다.
    {id:'branch-from',label:GIT_STASH_BRANCH,run:t=>gitMenuPanel().stashBranch(t)},
    {id:'copy-name',  label:GIT_STASH_COPY_NAME,run:t=>gitMenuPanel().copyText(GitStash.ref(t.index))},
    {id:'copy-hash',  label:GIT_STASH_COPY_HASH,run:t=>gitMenuPanel().copyText(t.oid)},
  ],
  // 미커밋 변경 행 (FR-GIT-127·277).
  uncommitted:[
    {id:'open-changes',label:'Changes 탭 열기',run:()=>gitMenuPanel().openView('changes')},
    {sep:true},
    // FR-GIT-277: 생성 다이얼로그를 그대로 다시 쓴다 — 두 벌로 두면 한쪽만 고쳐진다.
    {id:'stash',label:GIT_UNC_STASH,
     disabled:()=>gitMenuPanel().dirtyCount()?'':GIT_UNC_NOTHING,
     run:()=>gitMenuPanel().stashCreate()},
    // mixed 다 — index 만 HEAD 로 되돌리고 워킹 트리는 그대로 둔다. 파괴적이
    // 아니므로 확인을 붙이지 않는다 (FR-GIT-97).
    {id:'reset',label:GIT_UNC_RESET,run:()=>gitMenuPanel().uncommittedReset()},
    // **파괴적이다** (FR-GIT-277). 되살릴 수 없으므로 hint 는 되돌리는 명령이
    // 아니라 먼저 담아 두는 명령이다.
    {id:'clean',label:GIT_UNC_CLEAN,destructive:true,
     action:GIT_ACT_CLEAN_UNTRACKED,title:GIT_UNC_CLEAN_TITLE,
     disabled:()=>gitMenuPanel().untrackedPaths().length?'':GIT_UNC_NOTHING,
     targets:()=>gitMenuPanel().untrackedPaths(),
     hint:()=>({note:GIT_UNC_CLEAN_NOTE,command:GIT_UNC_CLEAN_CMD}),
     run:()=>gitMenuPanel().uncommittedClean()},
  ],
};

class GitMenu {
  /**
   * open 은 항목 집합을 렌더하고 키보드 조작을 붙인다. 한 번에 하나만 열린다 —
   * 겹치면 어느 대상의 메뉴인지 알 수 없다.
   *
   * ev 는 좌표만 쓴다 (`clientX`/`clientY`) — 합성 객체로도 열 수 있어야 검증이
   * 프레임워크만 볼 수 있다 (V52).
   */
  /**
   * FR-GIT-222: 행의 **기본 동작**. 더블클릭이 메뉴와 같은 경로로 가도록 항목을
   * 여기서 고른다 — 조건을 두 곳에 적으면 두 진입점의 뜻이 갈라진다.
   *
   * 후보를 순서대로 보고 **비활성이 아닌 첫 항목**을 고른다. 후보가 없거나
   * (태그처럼) 전부 비활성이면 아무 일도 하지 않는다 — 더블클릭이 메뉴보다
   * 관대해지면 사용자가 메뉴에서 막힌 것을 제스처로 통과시킬 수 있다.
   */
  static primary(kind,target){
    const ids=GIT_MENU_PRIMARY[kind]; if(!ids) return null;
    const items=GIT_MENUS[kind]||[];
    for(const id of ids){
      const it=items.find(x=>!x.sep&&x.id===id);
      if(!it||(it.disabled&&it.disabled(target))) continue;
      return it;
    }
    return null;
  }

  // 확인 게이트(_pick)를 그대로 지난다 — 더블클릭이 확인을 건너뛰지 않는다.
  static runPrimary(kind,target){
    const it=GitMenu.primary(kind,target);
    if(!it) return false;
    GitMenu._pick(it,target);
    return true;
  }

  static open(kind,target,ev){
    GitMenu.close();
    const items=GIT_MENUS[kind]; if(!items||!items.length) return;
    const m=document.createElement('div');
    m.className='git-menu'; m.dataset.kind=kind;
    for(const it of items){
      if(it.sep){
        const s=document.createElement('div'); s.className='git-menu-sep';
        m.appendChild(s); continue;
      }
      const b=document.createElement('div');
      b.className='git-menu-item'; b.dataset.id=it.id;
      b.textContent=it.label;
      // disabled 는 사유를 title 에 보인다 — 왜 못 누르는지 보이지 않으면
      // 사용자는 고장으로 읽는다.
      const why=it.disabled?(it.disabled(target)||''):'';
      if(why){b.classList.add('disabled'); b.title=why}
      else b.addEventListener('click',()=>GitMenu._pick(it,target));
      m.appendChild(b);
    }
    document.body.appendChild(m);
    // 화면 경계에서 위치를 뒤집는다.
    const x=(ev&&ev.clientX)||0, y=(ev&&ev.clientY)||0;
    const w=m.offsetWidth, h=m.offsetHeight;
    m.style.left=Math.max(0,x+w>window.innerWidth?x-w:x)+'px';
    m.style.top=Math.max(0,y+h>window.innerHeight?y-h:y)+'px';
    GitMenu._cur={el:m,target,i:-1};
    // 이 메뉴를 띄운 contextmenu 는 이미 지나갔으므로 지금 붙여도 자기 이벤트로
    // 닫히지 않는다. Esc·바깥 클릭·스크롤·리사이즈로 닫힌다.
    GitMenu._off=e=>{if(!m.contains(e.target))GitMenu.close()};
    GitMenu._key=e=>GitMenu._onKey(e);
    GitMenu._away=()=>GitMenu.close();
    document.addEventListener('mousedown',GitMenu._off,true);
    document.addEventListener('keydown',GitMenu._key,true);
    window.addEventListener('scroll',GitMenu._away,true);
    window.addEventListener('resize',GitMenu._away,true);
  }

  static close(){
    const c=GitMenu._cur; if(!c) return;
    GitMenu._cur=null;
    c.el.remove();
    document.removeEventListener('mousedown',GitMenu._off,true);
    document.removeEventListener('keydown',GitMenu._key,true);
    window.removeEventListener('scroll',GitMenu._away,true);
    window.removeEventListener('resize',GitMenu._away,true);
  }

  // ↑/↓ 이동, Enter 실행, Esc 닫힘. disabled 항목은 건너뛴다 — 멈춰 서면 사용자는
  // 키보드가 고장난 것으로 읽는다.
  static _onKey(e){
    const c=GitMenu._cur; if(!c) return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();GitMenu.close();return}
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault(); e.stopPropagation();
      const list=[...c.el.querySelectorAll('.git-menu-item:not(.disabled)')];
      if(!list.length) return;
      const all=[...c.el.querySelectorAll('.git-menu-item')];
      const cur=list.indexOf(all[c.i]);
      const next=e.key==='ArrowDown'
        ?(cur+1)%list.length
        :(cur<=0?list.length-1:cur-1);
      c.i=all.indexOf(list[next]);
      for(const el of all) el.classList.toggle('active',el===list[next]);
      return;
    }
    if(e.key==='Enter'){
      e.preventDefault(); e.stopPropagation();
      const all=[...c.el.querySelectorAll('.git-menu-item')];
      const el=all[c.i]; if(!el||el.classList.contains('disabled')) return;
      const items=(GIT_MENUS[c.el.dataset.kind]||[]).filter(x=>!x.sep);
      const it=items.find(x=>x.id===el.dataset.id);
      if(it) GitMenu._pick(it,c.target);
    }
  }

  /**
   * 실행 전 확인은 여기 한 곳에만 있다 (계약 §4.2) — 항목이 확인 코드를 따로
   * 쓰면 새 항목마다 방어를 다시 만들어야 하고, 한 곳이 빠지면 조용히 사라진다.
   *
   * `stages:1` 을 늘 넘긴다. 파괴적 목록(서버 `/api/git/policy`)에 든 action 은
   * `GitConfirm` 이 요청과 무관하게 2단계로 올린다 — 목록에 없는 action 이
   * 확인 없이 지나가는 일이 없게 바닥을 1단계로 둔다.
   */
  static async _pick(it,target){
    GitMenu.close();
    if(typeof it.run!=='function') return;
    if(it.warn||it.destructive){
      const ok=await GitDialog.confirm({
        action:it.action||it.id,
        title:it.title||it.label,
        targets:it.targets?it.targets(target):[],
        hint:it.hint?it.hint(target):null,
        stages:1,
      });
      if(!ok) return;
    }
    await it.run(target);
  }
}

GitMenu._cur=null;

// 고전 스크립트의 class·const 선언은 window 의 속성이 되지 않는다 — GitPanel 과
// e2e 가 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitMenu=GitMenu;
window.GIT_MENUS=GIT_MENUS;
window.GIT_MENU_PRIMARY=GIT_MENU_PRIMARY;
window.gitOpBusy=gitOpBusy;
