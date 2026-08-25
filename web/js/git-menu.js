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

const GIT_MENUS={
  // 커밋 (FR-GIT-140~144). 저장소를 바꾸는 항목은 checkout 하나다.
  commit:[
    // FR-GIT-141: 생성 다이얼로그는 M5 묶음 P 다. 자리만 열어 두고 사유를 보인다.
    {id:'branch-from',label:'여기서 브랜치 생성…',disabled:()=>GIT_MENU_M5},
    {id:'copy-hash',   label:'커밋 해시 복사',run:t=>gitMenuPanel().copyText(t.oid)},
    {id:'copy-subject',label:'커밋 제목 복사',run:t=>gitMenuPanel().copyText(t.subject)},
    {sep:true},
    // FR-GIT-144: detached 가 됨을 사전 경고한다. dirty 면 M5 묶음 N 의 처리를
    // 따라야 하므로 M4 에서는 차단한다 — 강제를 기본으로 만들지 않는다 (O14).
    {id:'checkout-detached',label:'Checkout (detached)',warn:true,
     action:GIT_CHECKOUT_DETACHED_ACT,title:GIT_CHECKOUT_DETACHED_TITLE,
     targets:t=>[t.abbrev+(t.subject?' '+t.subject:'')],
     hint:()=>({note:GIT_DETACHED_NOTE,command:''}),
     disabled:()=>gitMenuPanel().isDirty()?GIT_MENU_DIRTY+' — '+GIT_MENU_M5:'',
     run:t=>gitMenuPanel().checkoutDetached(t.oid)},
  ],
  // 파일 (S1 목록 / History 상세 목록). 저장소를 바꾸는 항목이 하나도 없다
  // (FR-GIT-41) — 5단계의 GIT_CTX_ITEMS 를 그대로 옮긴 것이다.
  file:[
    {id:'openChanges',label:'Open Changes',run:t=>gitMenuPanel().openFileDiff(t)},
    {id:'openFile',   label:'Open File',   run:t=>app._gitOpenFile(gitMenuPanel().absPath(t))},
    {id:'copyPath',   label:'Copy Path',   run:t=>gitMenuPanel().copyText(gitMenuPanel().absPath(t))},
  ],
  // 브랜치·태그 (FR-GIT-154·FR-GIT-146). 실행은 M5 묶음 N·O 이고, M4 는 이름
  // 복사와 필터(사이드바 클릭)만 한다.
  branch:[
    {id:'copy-name',label:'브랜치 이름 복사',run:t=>gitMenuPanel().copyText(t.short)},
    {id:'checkout', label:'Checkout',disabled:()=>GIT_MENU_M5},
  ],
  tag:[
    {id:'copy-name',label:'태그 이름 복사',run:t=>gitMenuPanel().copyText(t.short)},
    {id:'checkout', label:'Checkout (detached)',disabled:()=>GIT_MENU_M5},
  ],
  // 미커밋 변경 행 (FR-GIT-127).
  uncommitted:[
    {id:'open-changes',label:'Changes 탭 열기',run:()=>gitMenuPanel().openView('changes')},
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
   * `GitConfirm.open` 이 요청과 무관하게 2단계로 올린다 — 목록에 없는 action 이
   * 확인 없이 지나가는 일이 없게 바닥을 1단계로 둔다.
   */
  static async _pick(it,target){
    GitMenu.close();
    if(typeof it.run!=='function') return;
    if(it.warn||it.destructive){
      const ok=await GitConfirm.open({
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
