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
 *   {id, label, run(target,targets), disabled(target)→사유|'', warn, destructive,
 *    action, title, targets(target)→[문자열], hint(target)→{note,command},
 *    busy: 동작 ID(GIT_ACTION) | 그 배열 | (target)→그것 — 1층 답,
 *    act: 동작 ID — 메뉴를 열 때 묻는 2층 답(`target.answers`)}
 *
 * `busy` 는 그 항목이 기대는 **서버 동작의 ID** 다(SERVER_DRIVEN_ACTIONS_SRS GR-1e). 그 답이
 * 거짓이면 항목은 비활성 + 서버의 사유다.
 *   {sep:true}
 *
 * 확인은 **항목이 따로 쓰지 않는다** — `warn:true` 는 1단계, `destructive:true` 는
 * 9단계 `GitConfirm` 의 확인을 프레임워크가 자동으로 거친다.
 */

class GitMenu {
  // 열 때 묻는 메뉴의 세대 — 늦게 온 앞선 답이 지금 메뉴를 덮지 않는다.
  static _askSeq=0;
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
      if(!it||GitMenu._why(it,target)) continue;
      return it;
    }
    return null;
  }

  // 확인 게이트(_pick)를 그대로 지난다 — 더블클릭이 확인을 건너뛰지 않는다. 열 때 묻는
  // 메뉴면 더블클릭도 먼저 서버에 묻는다 (SERVER_DRIVEN_ACTIONS_SRS GT-f) — 메뉴보다
  // 관대해지면 메뉴에서 막힌 것을 제스처로 통과시킨다.
  static async runPrimary(kind,target){
    const ask=GIT_MENU_ASK[kind];
    let tg=target;
    if(ask){
      const p=gitMenuPanel(); if(!p||!p.repo) return false;
      const res=await gitFetch(GIT_API.actions,Object.assign({repo:p.repo},ask(target)));
      tg=Object.assign({},target,{answers:(res.ok&&res.data&&res.data.actions)||{}});
    }
    const it=GitMenu.primary(kind,tg);
    if(!it) return false;
    GitMenu._pick(it,tg);
    return true;
  }

  /**
   * 대상 하나의 판정이 필요한 메뉴는 **열 때 서버에 묻고**, 답을 받은 뒤 그린다
   * (SERVER_DRIVEN_ACTIONS_SRS FR-SDA-5 · GT-f). 답이 늦으면(NFR-SDA-1) 항목을 `loading`
   * 으로 먼저 그리고, 답이 오면 같은 자리에 다시 그린다.
   */
  static open(kind,target,ev){
    const ask=GIT_MENU_ASK[kind];
    if(!ask){GitMenu.openList(GIT_MENUS[kind],kind,target,ev);return}
    GitMenu._openAsked(kind,target,ev,ask(target));
  }

  static async _openAsked(kind,target,ev,q){
    const p=gitMenuPanel(); if(!p||!p.repo) return;
    const seq=++GitMenu._askSeq;
    const at={clientX:(ev&&ev.clientX)||0,clientY:(ev&&ev.clientY)||0};
    const early=TIMERS.after(GIT_MENU_ASK_LOADING_MS,()=>{
      if(seq===GitMenu._askSeq) GitMenu.openList(GIT_MENUS[kind],kind,Object.assign({},target,{answers:null}),at);
    },{owner:GitMenu,label:'menu-ask'});
    const res=await gitFetch(GIT_API.actions,Object.assign({repo:p.repo},q),{stale:()=>seq!==GitMenu._askSeq});
    TIMERS.cancel(early);
    if(res.stale) return;
    const answers=(res.ok&&res.data&&res.data.actions)||{};
    GitMenu.openList(GIT_MENUS[kind],kind,Object.assign({},target,{answers}),at);
  }

  /**
   * openList 는 **항목을 인자로** 받는다 — 리포 목록처럼 선언으로 고정할 수 없는
   * 것을 위한 자리다 (FR-GIT-282).
   *
   * open 과 같은 _pick 을 지난다. 확인 게이트를 두 벌로 두면 한쪽만 고쳐진다.
   */
  static openList(items,kind,target,ev){
    GitMenu.close();
    if(!items||!items.length) return;
    /**
     * CONTEXT_MENU_UNIFY_SRS FR-CMU-6 / D-CMU-1: **어댑터**다. 항목 표의 어휘
     * (`run`·`disabled(target)`·`tip`·`cur`)를 키트 항목으로 옮기고 `UIKit.menu` 를
     * 부른다 — DOM·키 이동·닫힘은 키트의 것이다. 옛 이름(`git-menu*`)은 함께
     * 붙는다 (FR-CMU-5, e2e 가 짚는다). 확인 게이트 `_pick` 만 여기 남는다.
     */
    const kit=items.map(it=>{
      if(it.sep) return {sep:true};
      const why=GitMenu._why(it,target);
      return {
        id:it.id,label:GitMenu._val(it.label,target),cur:!!it.cur,
        // 사유가 있으면 그것이 title 이고, 없으면 툴팁(`tip`)이다 — `title` 은
        // 확인 다이얼로그의 제목으로 이미 쓰인다.
        disabled:why||false,title:why?'':(it.tip||''),
        onClick:()=>GitMenu._pick(it,target),
      };
    });
    const m=UIKit.menu(kit,{
      at:{x:(ev&&ev.clientX)||0,y:(ev&&ev.clientY)||0},
      cls:'git-menu',itemCls:'git-menu-item',sepCls:'git-menu-sep',
    });
    m.dataset.kind=kind;
  }

  /**
   * BRANCH_MENU_UNIFY_SRS FR-BMU-16b: 항목의 값이 **대상을 볼 수 있다.**
   *
   * `disabled`·`targets`·`hint` 는 이미 `t=>...` 꼴이었고 `label`·`title`·
   * `action` 만 상수였다. 그래서 한 항목이 문맥에 따라 다른 것을 지우게 만들 수
   * 없었다 — 규약을 하나로 맞춘다. 상수는 그대로 상수로 지난다.
   */
  static _val(v,target){return typeof v==='function'?v(target):v}

  /**
   * 항목의 비활성 사유 — 항목 자신의 사유가 먼저, 없으면 그 항목이 기대는 서버 동작의
   * 답이다 (SERVER_DRIVEN_ACTIONS_SRS GR-1e · FR-SDA-6). 칸 규칙은 서버에 있고, 화면은
   * 1층 답(`panel.actionOf`)을 그린다.
   *   이전 동작: 화면이 요청 키 → 칸 규칙(`gitJobSlotsOf`)으로 스스로 판정했다
   */
  static _why(it,target){
    const own=it.disabled?(it.disabled(target)||''):'';
    if(own) return own;
    // 2층: 대상의 답. `answers` 가 null 이면 아직 묻는 중이다 (FR-SDA-6).
    if(it.act){
      const a=target&&target.answers;
      return actionState(a?(a[GitMenu._val(it.act,target)]||null):null,false).why;
    }
    if(!it.busy) return own;
    const p=gitMenuPanel();
    if(!p||!p.actionOf) return '';
    for(const id of [].concat(GitMenu._val(it.busy,target))){
      const s=actionState(p.actionOf(id),false);
      if(!s.enabled) return s.why;
    }
    return '';
  }

  static close(){UIKit.closeMenu()}

  /**
   * 실행 전 확인은 여기 한 곳에만 있다 (계약 §4.2) — 항목이 확인 코드를 따로
   * 쓰면 새 항목마다 방어를 다시 만들어야 하고, 한 곳이 빠지면 조용히 사라진다.
   *
   * `stages:1` 을 늘 넘긴다. 파괴적 목록(서버 `/api/git/policy`)에 든 action 은
   * `GitConfirm` 이 요청과 무관하게 확인을 세운다 — 목록에 없는 action 이
   * 확인 없이 지나가는 일이 없게 바닥을 1단계로 둔다.
   *
   * REPO_FIX 05 §3A-2 (F-1): 대상은 **확인 전에 한 번** 계산해 확인창에 보이고
   * 그 배열을 그대로 `run(target,targets)` 에 넘긴다.
   *	이전 동작: 확인창은 `targets(t)`, 실행은 선택 상태를 다시 읽었다 — Delete both
   *	           가 확인창의 한 쌍이 아니라 다중 선택 전체를 지웠다(#1)
   *	새 동작: 실행은 확인창에 보인 배열만 쓴다
   *	이유: 보인 것과 지워지는 것이 다르면 확인이 무의미하다
   */
  static async _pick(it,target){
    GitMenu.close();
    if(typeof it.run!=='function') return;
    const targets=it.targets?it.targets(target):[];
    if(it.warn||it.destructive){
      const ok=await GitDialog.confirm({
        action:GitMenu._val(it.action,target)||it.id,
        title:GitMenu._val(it.title,target)||GitMenu._val(it.label,target),
        targets,
        hint:it.hint?it.hint(target):null,
        stages:1,
      });
      if(!ok) return;
    }
    await it.run(target,targets);
  }
}


// 고전 스크립트의 class·const 선언은 window 의 속성이 되지 않는다 — GitPanel 과
// e2e 가 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitMenu=GitMenu;
window.GIT_MENUS=GIT_MENUS;
window.GIT_MENU_PRIMARY=GIT_MENU_PRIMARY;
