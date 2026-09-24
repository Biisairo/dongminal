/**
 * Dongminal — Changes 탭의 커밋 영역 (GIT_SRS §3A.2 / FR-GIT-74~85)
 *
 * 5단계가 세운 `.git-commit` 자리를 살린다. **파일 목록 스크롤과 독립된 고정
 * 영역**이라는 성질(FR-GIT-39)은 5단계의 flex 구조가 보장하므로 여기서는 그
 * 안쪽만 채운다.
 *
 * 폴링은 초당 한 번 `paint` 를 부른다. 그래서 **입력값을 paint 가 건드리지
 * 않는다** — 사용자가 타이핑하는 중에 값이 되돌아가면 안 된다. 값을 바꾸는 것은
 * 리포 전환·amend 토글·커밋 성공·undo 뿐이다.
 *
 * 옵션(sign-off / no-verify / commit all)은 기억하지 않는다 (FR-GIT-79) —
 * no-verify 가 기억되면 훅이 조용히 계속 꺼진다.
 */
class GitCommit {
  constructor(panel){
    this.panel=panel;
    this.app=panel.app;
    this._el=null;
    this._msg=null;
    this._repo=null;      // 화면에 채워 둔 리포. 바뀌면 전부 되돌린다
    this._pf=null;        // /api/git/preflight 의 응답 (template·gpgSign·warnings)
    this._pfRepo=null;
    this._st=null;        // 마지막 status. 비활성 사유 판정이 딛는다 (FR-GIT-84)
    this._amend=false;
    // REPO_FIX 05 F-7.2: amend 메시지 슬롯 — 메모리에만 둔다(저장·동기화하지 않는다).
    this._amendText='';
    this._opts={signoff:false,noVerify:false,all:false};
    this._menuOpen=false;
    this._blocks=null;    // 409 preflight_blocked 의 blocks (FR-GIT-88)
    this._err=null;
    this._busy=false;
    this._saveT=null;     // draft 디바운스
    this._saveRepo=null; this._saveV='';  // 디바운스가 쓸 (저장소, 값) — F-7.5 flush 의 몫
    this._headKey=null;   // F-7.1: 마지막 관측의 HEAD (oid·branch·detached)
    this._undo=null;      // {repo,token,el,timer}
    this._tmplRepo=null;  // template 을 이미 채운 리포 (FR-GIT-76)
    this._h=undefined;    // 경계 드래그로 정한 높이 (기기별)
  }

  // 골격은 `.git-commit` 이 다시 만들어질 때마다 한 번 세운다. 리스너도 그때
  // 한 번만 붙는다 — paint 는 칠하기만 한다.
  mount(el){
    if(!el) return;
    this._el=el;
    el.innerHTML=
      // 입력창은 폭을 다 쓰고, 옵션과 실행은 그 아래 한 줄에 **왼쪽으로 모아**
      // 선다 (FR-GIT-213). 옆에 세우면 입력창 높이에 따라 둘 사이 간격이 계속
      // 달라지고, 양끝으로 밀면 서로 상관없는 것처럼 멀어진다.
      '<div class="git-commit-main">'+
        '<textarea class="git-commit-msg ui-scroll"></textarea>'+
        '<div class="git-commit-bar">'+
          '<label class="git-commit-amend"><input type="checkbox"><span></span></label>'+
          '<span class="git-commit-gpg"></span>'+
          '<div class="git-commit-go ui-split">'+
            '<button class="ui-btn ui-btn-primary git-commit-btn"></button>'+
            '<button class="ui-btn ui-btn-primary git-commit-more"></button>'+
            '<div class="git-commit-menu"></div>'+
          '</div>'+
          '<span class="git-commit-spacer"></span>'+
        '</div>'+
      '</div>'+
      '<div class="git-commit-why"></div>'+
      '<div class="git-preflight"></div>'+
      '<div class="git-commit-resize"></div>';
    this._msg=el.querySelector('.git-commit-msg');
    this._msg.placeholder=GIT_COMMIT_PLACEHOLDER;
    el.querySelector('.git-commit-amend span').textContent=GIT_COMMIT_AMEND;
    el.querySelector('.git-commit-btn').textContent=GIT_COMMIT_BTN;
    const more=el.querySelector('.git-commit-more');
    more.textContent=GIT_COMMIT_MORE; more.title=GIT_COMMIT_MORE_TITLE;
    const menu=el.querySelector('.git-commit-menu');
    for(const o of GIT_COMMIT_OPTS){
      const lab=document.createElement('label');
      lab.className='git-commit-opt'; lab.dataset.opt=o.key;
      const i=document.createElement('input'); i.type='checkbox';
      const s=document.createElement('span'); s.textContent=o.label;
      i.addEventListener('change',()=>{this._opts[o.key]=i.checked;this._paint()});
      lab.appendChild(i); lab.appendChild(s); menu.appendChild(lab);
    }
    this._msg.addEventListener('input',()=>this._input());
    el.querySelector('.git-commit-amend input')
      .addEventListener('change',ev=>this._amendToggle(ev.target.checked));
    el.querySelector('.git-commit-btn').addEventListener('click',()=>this._commit());
    el.querySelector('.git-commit-more').addEventListener('click',()=>{
      this._menuOpen=!this._menuOpen; this._paint();
    });
    this._bindResize(el.querySelector('.git-commit-resize'));
    // 골격이 새로 세워졌으므로 다음 paint 가 리포 상태를 다시 채워야 한다.
    this._repo=null;
  }

  // 리포가 없어 `.git-commit` 자체가 사라진 경우. 인스턴스는 살아 있다 — 리포는
  // 다시 선택될 수 있다.
  unmount(){
    this._el=null; this._msg=null; this._repo=null;
    this._undoHide();
  }

  paint(st){
    if(!this._el||!this._msg) return;
    this._st=st;
    const repo=this.panel.repo;
    if(repo!==this._repo) this._reset(repo);
    // REPO_FIX 05 F-7.1: HEAD 가 바뀐 관측이면 preflight 를 다시 받는다 — detached 경고와
    // 진행 중 작업 차단이 현재 HEAD 를 따른다 (FR-GIT-87).
    const hk=st?[st.oid||'',st.branch||'',st.detached?1:0].join('\u0000'):'';
    if(repo&&this._headKey!==null&&hk!==this._headKey) this._loadPreflight(repo);
    this._headKey=hk;
    this._paint();
  }

  // ── 높이 (FR-GIT-74) ──

  // 경계 드래그로 정한 높이는 기기별 취향이라 localStorage 에 남는다. 0 이면
  // 기본 줄 수를 쓴다.
  _height(){
    if(this._h===undefined){
      let v=null; try{v=localStorage.getItem(GIT_COMMIT_HEIGHT_KEY)}catch{}
      const n=parseInt(v,10);
      this._h=(Number.isFinite(n)&&n>0)?n:0;
    }
    return this._h;
  }

  // box-sizing 이 border-box 이므로 높이에 여백과 테두리가 포함된다.
  _rowsPx(n){
    const cs=getComputedStyle(this._msg);
    const lh=parseFloat(cs.lineHeight)||GIT_COMMIT_LINE_PX;
    const pad=(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0);
    return Math.round(n*lh+pad+this._borderPx());
  }

  _borderPx(){
    const cs=getComputedStyle(this._msg);
    if(cs.boxSizing!=='border-box') return 0;
    return (parseFloat(cs.borderTopWidth)||0)+(parseFloat(cs.borderBottomWidth)||0);
  }

  // 입력마다 내용 높이로 맞추고 상한을 넘으면 내부 스크롤로 넘긴다 (FR-GIT-74).
  // 드래그로 정한 높이는 하한이 된다 — 사용자가 정한 크기가 입력 때문에 줄지 않는다.
  _grow(){
    const ta=this._msg; if(!ta) return;
    const base=this._height()||this._rowsPx(GIT_COMMIT_ROWS);
    const max=Math.max(base,this._rowsPx(GIT_COMMIT_MAX_ROWS));
    ta.style.height='0px';
    const need=ta.scrollHeight+this._borderPx();
    ta.style.height=Math.max(base,Math.min(need,max))+'px';
  }

  /**
   * UI_KIT_SRS FR-HSZ-1·10: 여섯 핸들이 `UIKit.drag` 한 골격을 쓴다.
   *
   * 이 핸들만 **세로축**이며(`axis:'y'`) 위쪽이 커밋 입력, 아래쪽이 그 뒤에 오는
   * 파일 목록이다. 양쪽 다 터미널이 아니므로 `C×R` 줄은 붙지 않는다 (FR-HSZ-5).
   *
   * 종전의 리스너가 `capture` 단계였다 — 커밋 입력 위에서 시작하는 드래그를
   * 텍스트 선택이 먼저 삼키기 때문이다. 골격은 버블 단계이지만 손잡이 자신에
   * 걸리고 `preventDefault` 를 하므로 같은 결과가 된다.
   */
  _bindResize(h){
    if(!h) return;
    UIKit.drag(h,{
      axis:'y',
      start:()=>{
        const ta=this._msg;
        if(!ta) return false;
        const side=h.closest('.ed-side')||h.closest('.git-view')||h.parentElement;
        return {ta,side,h0:ta.getBoundingClientRect().height,min:this._rowsPx(1)};
      },
      move:(ctx,ev)=>{
        this._h=Math.round(Math.max(ctx.min,ctx.h0+(ev.clientY-ctx.sy0)));
        ctx.ta.style.height=this._h+'px';
      },
      sides:(ctx)=>{
        const th=ctx.ta.getBoundingClientRect().height;
        const tot=ctx.side?ctx.side.getBoundingClientRect().height:th;
        return [
          {px:th,pct:tot?th/tot*100:null},
          {px:Math.max(0,tot-th),pct:tot?(tot-th)/tot*100:null},
        ];
      },
      end:()=>{
        try{localStorage.setItem(GIT_COMMIT_HEIGHT_KEY,String(this._height()))}catch{}
        this._grow();
      },
    });
  }

  // ── preflight (FR-GIT-76·85·87) ──

  // 커밋 차단은 서버가 커밋 시점에 다시 판정한다 (FR-GIT-86). 이 조회는 화면에
  // 필요한 것 — template·서명 표시·detached 경고 — 을 얻기 위한 것이다.
  async _loadPreflight(repo){
    const res=await gitFetch('/api/git/preflight',{repo},
      {stale:()=>this.panel.repo!==repo,echo:{repo}});
    if(res.stale||!res.ok||!res.data.preflight) return;
    this._pf=res.data.preflight; this._pfRepo=repo;
    this._applyTemplate(repo);
    this._paint();
  }

  // draft 가 있으면 덮지 않는다 (FR-GIT-76). 한 리포에 한 번만 채운다 — 지운
  // 템플릿이 다음 폴링에 되살아나면 지울 수 없다.
  _applyTemplate(repo){
    if(this._tmplRepo===repo) return;
    const t=(this._pf&&this._pf.template)||'';
    if(!t||this._msg.value||this._draftGet(repo)) return;
    this._tmplRepo=repo;
    this._setValue(t);
  }

  _warning(code){
    const ws=(this._pfRepo===this._repo&&this._pf&&this._pf.warnings)||[];
    return ws.find(w=>w&&w.code===code)||null;
  }

  // ── 칠하기 ──

  _paint(){
    const el=this._el; if(!el) return;
    const pf=this._pfRepo===this._repo?this._pf:null;
    this._msg.disabled=!this._repo;
    const gpg=el.querySelector('.git-commit-gpg');
    const sign=!!(pf&&pf.gpgSign);
    gpg.textContent=sign?GIT_COMMIT_GPG:'';
    gpg.classList.toggle('vis',sign);
    el.querySelector('.git-commit-amend input').checked=this._amend;
    for(const o of GIT_COMMIT_OPTS){
      const i=el.querySelector('.git-commit-opt[data-opt="'+o.key+'"] input');
      if(i) i.checked=!!this._opts[o.key];
    }
    el.querySelector('.git-commit-menu').classList.toggle('vis',this._menuOpen);
    el.querySelector('.git-commit-more').classList.toggle('active',this._menuOpen);
    // 왜 못 누르는지 보인다 (FR-GIT-84). 버튼 옆 한 줄과 title 둘로 알린다.
    //
    // FR-TIP-2·3: 두 자리가 **다른 말**을 쓴다 — 보이는 줄은 한국어 그대로이고
    // 툴팁만 영어다. 그래서 `_why()` 는 코드를 답하고 표가 그것을 옮긴다.
    const why=this._why();
    const btn=el.querySelector('.git-commit-btn');
    btn.disabled=!!why||this._busy;
    btn.title=why?(GIT_COMMIT_WHY_TITLE[why]||''):'';
    const whyText=why?(GIT_COMMIT_WHY_TEXT[why]||''):'';
    const w=el.querySelector('.git-commit-why');
    w.textContent=this._busy?GIT_COMMIT_RUNNING:(this._err||whyText||'');
    w.classList.toggle('vis',!!w.textContent);
    w.classList.toggle('err',!this._busy&&!!this._err);
    this._paintBlocks();
  }

  // 사유 **코드**를 답한다 (FR-TIP-2·3) — 문구는 부르는 쪽이 표에서 고른다.
  _why(){
    if(!this._repo) return GIT_COMMIT_WHY_NO_REPO;
    if(this.panel._remote().busy(GIT_JOB_SLOT_INDEX)) return GIT_COMMIT_WHY_JOB_CODE;
    if(!this._msg.value.trim()) return GIT_COMMIT_WHY_EMPTY_CODE;
    // 서버와 같은 판정이다 — `-a` 는 tracked 변경을 스스로 담으므로 staged 가
    // 없어도 커밋할 것이 있다 (FR-GIT-84). REPO_FIX 01 §7.7: amend 면 메시지를
    // 고치는 것이 커밋할 것이다 — 메시지가 직전과 같은지는 서버가 판정한다.
    const staged=(this._st&&this._st.staged&&this._st.staged.length)||0;
    if(!staged&&!this._opts.all&&!this._amend) return GIT_COMMIT_WHY_NOTHING_CODE;
    return '';
  }

  // 차단 사유는 **무엇이 왜 막혔고 어떻게 푸는지**를 함께 보인다 (FR-GIT-88).
  // Fix 는 복사할 수 있다 — 옮겨 적게 하지 않는다.
  _paintBlocks(){
    const box=this._el.querySelector('.git-preflight');
    const blocks=this._blocks||[];
    box.classList.toggle('vis',!!blocks.length);
    const sig=blocks.map(b=>b&&b.code).join(',');
    if(box.dataset.sig===sig) return;
    box.dataset.sig=sig;
    box.innerHTML='';
    if(!blocks.length) return;
    const h=document.createElement('div');
    h.className='git-preflight-head'; h.textContent=GIT_PREFLIGHT_TITLE;
    box.appendChild(h);
    for(const b of blocks){
      const d=document.createElement('div');
      d.className='git-preflight-block'; d.dataset.code=(b&&b.code)||'';
      const r=document.createElement('div');
      r.className='git-preflight-reason'; r.textContent=(b&&b.reason)||'';
      const f=document.createElement('div'); f.className='git-preflight-fix';
      const lab=document.createElement('span');
      lab.className='git-preflight-fix-label'; lab.textContent=GIT_PREFLIGHT_FIX;
      const code=document.createElement('code');
      code.className='git-preflight-cmd'; code.textContent=(b&&b.fix)||'';
      const cp=document.createElement('button');
      cp.className='ui-btn ui-btn-sm git-preflight-copy'; cp.textContent=GIT_PREFLIGHT_COPY;
      cp.title=GIT_TIP_PREFLIGHT_COPY;
      cp.addEventListener('click',()=>this.panel.copyText((b&&b.fix)||''));
      f.appendChild(lab); f.appendChild(code); f.appendChild(cp);
      d.appendChild(r); d.appendChild(f);
      box.appendChild(d);
    }
  }

  // ── 커밋 (FR-GIT-77·79·80·87·88) ──

  async _commit(){
    if(this._busy) return;
    const repo=this._repo; if(!repo) return;
    const msg=this._msg.value;
    if(this._why()) return;
    // 경고 판정은 preflight 에 의존한다. 서버는 detached 를 막지 않으므로(그것이 옳다) 이
    // 경고를 보장하는 것은 여기뿐이다 (FR-GIT-87).
    // REPO_FIX 05 F-7.1: **커밋 직전에 늘 다시 받는다.** 이전: 한 번 받은 것을 계속 써서
    // 그 사이 HEAD 가 detached 로 바뀌어도 경고 없이 커밋됐다(#33).
    await this._loadPreflight(repo);
    if(this._repo!==repo||this._busy) return;
    // detached 는 막지 않되 결과를 명시적으로 경고한다 (FR-GIT-87). 파괴적이
    // 아니므로 1단계 확인이다.
    const det=this._warning(GIT_WARN_DETACHED);
    if(det){
      const ok=await GitDialog.confirm({
        action:GIT_ACT_DETACHED,title:GIT_DETACHED_TITLE,targets:[det.reason||''],
        hint:{note:GIT_DETACHED_NOTE,command:t('git.detached_command')},
        stages:1,
      });
      if(!ok||this._repo!==repo) return;
    }
    const amend=this._amend;
    this._busy=true; this._blocks=null; this._err=null; this._paint();
    const res=await this.panel.post('/api/git/commit',{
      repo,message:msg,amend,
      signoff:this._opts.signoff,noVerify:this._opts.noVerify,all:this._opts.all,
    });
    const d=res.data||{};
    /**
     * REPO_FIX 05 F-7.4: 뒷정리는 **커밋을 시작한 저장소 키**로 한다 — 잡이 도는 사이 화면이
     * 다른 저장소로 옮겼어도 이긴 커밋의 메시지는 그 저장소 draft 에서 지운다. 입력칸은
     * 지금 화면이 그 저장소일 때만 비운다. 실패·취소·결과 미상이면 draft 를 둔다.
     *   이전 동작: 저장소가 바뀌었으면 아무것도 하지 않아, 돌아오면 이미 커밋된 메시지가
     *             draft 로 남아 다시 커밋될 수 있었다(N3)
     */
    if(res.ok&&!amend){
      if(this._saveRepo===repo){TIMERS.cancel(this._saveT);this._saveT=null;this._saveRepo=null}
      this._draftSet(repo,'');
    }
    if(this._repo!==repo){this._paint();return}
    this._busy=false;
    if(d.error===GIT_ERR_PREFLIGHT){
      this._blocks=(d.preflight&&d.preflight.blocks)||[];
      this._paint(); return;
    }
    if(!res.ok){
      this._err=this.panel.writeError(res);
      this.panel.applyWriteFail(res);
      this._paint(); return;
    }
    // FR-GIT-80: 상태를 갱신하고 입력을 비운다(draft 는 위에서 지웠다). amend 커밋이었으면
    // amend 슬롯만 비우고 원 draft 를 보인다 (F-7.2).
    this.panel.adopt(d);
    this._setValue(amend?this._draftGet(repo):'');
    this._amend=false; this._amendText=''; this._tmplRepo=repo;
    // 옵션을 기억하지 않는다 (FR-GIT-79) — 다음 커밋이 조용히 훅을 끄지 않는다.
    this._opts={signoff:false,noVerify:false,all:false};
    this._menuOpen=false;
    this._undoShow(repo,d.undoToken);
    this._paint();
  }

  // REPO_FIX 01 §6.4 재부착: 다른 탭·새로고침 전에 띄운 커밋이 이겼다 — 그 저장소의
  // 초안을 비우고, 창이 남았으면 undo 를 보인다(창은 서버가 강제한다).
  adoptJobDone(jb){
    const repo=this._repo;
    if(!repo||this._busy||(jb.repo!==repo&&jb.repo!==((this.panel._status||{}).repo))) return;
    this._setValue(''); this._draftSet(repo,'');
    this._undoShow(repo,jb.result&&jb.result.undoToken);
    this._paint();
  }

  // ── undo 토스트 (FR-GIT-81·82·83, O7) ──

  // 5초 뒤 진입점이 DOM 에서 사라진다. 서버 토큰도 같은 순간 만료되므로 두 겹으로
  // 막힌다 — 탭을 멈춰 두어도 만료된 undo 는 실행되지 않는다.
  _undoShow(repo,token){
    this._undoHide();
    if(!token) return;
    /**
     * ACCESSIBILITY_BASELINE_SRS FR-A11Y-19 (`UX-8`): **`Toast` 를 지난다.**
     *
     * 종전에는 여기서 자기 DOM·타이머·자리를 갖고 `document.body` 에 직접 붙였다.
     * 그러면 알림 채널이 하나 늘고, 라이브 리전도 하나 더 필요하다 — 리전이 넷이면
     * 보조기술이 넷을 각각 감시하고 다음 사람이 다섯 번째를 잊는다.
     *
     * **되돌릴 수 있다는 사실이 읽혀야 한다.** 5초 안에 눌러야 하는 기회를 못 보는
     * 사용자에게는 그 기회가 없는 것과 같다.
     *
     * `id`·클래스 셋을 그대로 두는 것은 신원이다 — `#git-undo`·`.git-undo-btn` 은
     * e2e 가 짚는 이름이고, `.git-undo-toast` 는 이 알림의 모양을 정한다.
     */
    const h=Toast.show(GIT_UNDO_TEXT,'',GIT_UNDO_MS,{
      id:'git-undo', cls:'git-undo-toast', textCls:'git-undo-text',
      actions:[{label:GIT_UNDO_LABEL,title:GIT_TIP_UNDO,cls:'git-undo-btn',
                onClick:()=>this._undoRun()}],
    });
    this._undo={repo,token,close:h.close};
  }

  _undoHide(){
    const u=this._undo; if(!u) return;
    this._undo=null;
    // 타이머도 `Toast` 가 갖는다 — `close` 가 둘을 함께 끝낸다.
    if(u.close) u.close();
  }

  async _undoRun(){
    const u=this._undo; if(!u) return;
    // 진입점을 먼저 없앤다 — 한 번의 커밋에 한 번의 undo 다.
    this._undoHide();
    const res=await this.panel.post('/api/git/undo-last',{repo:u.repo,undoToken:u.token});
    const d=res.data||{};
    if(!res.ok){
      this._err=d.error===GIT_ERR_UNDO_EXPIRED?GIT_UNDO_FAIL:this.panel.writeError(res);
      this._paint(); return;
    }
    this.panel.adopt(d);
    // 메시지를 커밋 직전으로 되돌린다 (FR-GIT-82).
    if(u.repo===this._repo){
      this._setValue(d.message||'');
      this._draftSet(u.repo,this._msg.value);
    }
    this._paint();
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitCommit=GitCommit;
