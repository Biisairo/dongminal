/**
 * AgentPane — 에이전트 도구의 뷰 (M8_UNIFIED_SRS 묶음 T, FR-AGT-4·4a·5·9·11·12).
 *
 * xterm 의 자리에 대화 뷰가 선다 (D-U-4 (b)). 그 밖은 터미널 도구와 같다 — 탭·배치·
 * 포커스·백그라운드는 `toolId` 를 보는 코드가 그대로 닿고, 이 클래스는 `TerminalTool`
 * 과 같은 손잡이(`el`·`destroy`·`_slot`)만 낸다.
 *
 * 상태의 원천은 서버의 이벤트 로그다 (D-C-3): 열 때 `GET /api/agent/events` 로 재생하고
 * 라이브는 SSE `agent_event` 를 `seq` 로 이어 붙인다. 틈이 보이면 다시 받는다. 잘린 앞은
 * 요약 스냅샷 하나다 (FR-ABG-21). 프로세스가 없는 상태(휴면·오류, D-C-11)는 입력을 막고 재개
 * 버튼을 놓는다 — 같은 toolId 가 이어진다.
 * 문구는 전부 카탈로그 키다 (FR-U-5 · FR-B-10).
 */
class AgentPane {
  constructor(app, id, name) {
    this.app=app; this.id=id; this.name=name||'';
    this._slot=0;
    this.seq=0; this.state=null; this._destroyed=false;
    this._live=null;      // 진행 중 델타가 쌓이는 요소
    this._liveThink=null;
    this._toolCards=new Map(); // toolUseId → 카드
    this._dialog=null;    // 열린 승인 다이얼로그 {id, close}
    this._history=[]; this._histIdx=-1; this._draft='';
    this._loading=null;
    this._pending=null;   // 재생이 비행 중일 때 도착한 SSE — 재생 뒤에 이어 붙인다
    this._openIds=new Set(); // 열린 요청의 id — 개수는 이 집합의 크기다 (재생과 상태가 겹쳐도 한 번)

    const el=this.el=document.createElement('div');
    el.className='agent-pane'; el.dataset.toolid=id;

    // 상태 줄 — 라벨 · 활동 · 모델 · 권한 모드 · 컨텍스트 · 비용 · 메뉴
    const head=document.createElement('div'); head.className='agp-head';
    this.lblEl=document.createElement('span'); this.lblEl.className='agp-agent'; this.lblEl.textContent=this.name;
    /**
     * M9_SRS FR-M9-35 (M9-B16 의 ③, 사용자 결정): **그 도구의 cwd 와 저장소.**
     *
     * 접수한 말에 *"path, branch, upstream"* 이 들어 있다. 값은 있었으나 **다른
     * 길에서 온다** — 프로토콜이 아니라 도구의 것이다. 그래서 사용량과 같은 묶음이
     * 아니라 이름 옆에 서고, 출처는 `title` 이 말한다. 섞어 그리면 "에이전트가
     * 보고한 값" 으로 읽힌다.
     */
    this.cwdEl=document.createElement('span'); this.cwdEl.className='agp-cwd';
    this.repoEl=document.createElement('span'); this.repoEl.className='agp-repo';
    this.stateEl=document.createElement('span'); this.stateEl.className='agp-state';
    this.modelEl=document.createElement('span'); this.modelEl.className='agp-model';
    this.permEl=document.createElement('span'); this.permEl.className='agp-perm';
    this.ctxEl=document.createElement('span'); this.ctxEl.className='agp-ctx';
    this.costEl=document.createElement('span'); this.costEl.className='agp-cost';
    /**
     * M9_SRS FR-M9-34: **플랜 한도는 컨텍스트 채움과 다른 자리에 선다.**
     * 둘은 출처가 다르고(하나는 이 대화, 하나는 계정 전체), 나란히 같은 모양으로
     * 두면 사용자가 같은 것으로 읽는다. 그래서 이름을 주기로 달고 사유를 title 에 둔다.
     */
    this.limitsEl=document.createElement('span'); this.limitsEl.className='agp-limits';
    this.limitsEl.title=t('agent.limits_title'); this.limitsEl.hidden=true;
    this.openEl=document.createElement('span'); this.openEl.className='agp-open';
    const sp=document.createElement('span'); sp.className='agp-spacer';
    /**
     * M9_SRS FR-M9-36 (M9-B17): **보이는 진입점.** 접수한 말이 *"이 방식은 어떤
     * 경로에서 여는 건지도 모르고, 어떻게 여는지도 알기 힘들다"* 였다. 우클릭 둘은
     * 그대로 두고(`agent-pane` 메뉴 · 탭 메뉴) 여기에 하나를 **더한다.**
     *
     * 어댑터가 TUI 출구를 주지 않으면 서지 않는다 — `_applyState` 가 그 판정을 한다.
     */
    this.tuiBtn=UIKit.button({icon:'terminal',title:t('agent.open_terminal'),kind:'ghost',size:'sm',
      cls:'agp-tui-btn',onClick:()=>this.app.agentOpenTerminal(this.id)});
    this.tuiBtn.hidden=true;
    this.menuBtn=UIKit.button({icon:'menu',title:t('agent.menu_title'),kind:'ghost',size:'sm',cls:'agp-menu-btn',onClick:e=>this._openMenu(e)});
    for(const x of [this.lblEl,this.cwdEl,this.repoEl,this.stateEl,this.modelEl,this.permEl,this.ctxEl,this.costEl,this.limitsEl,this.openEl,sp,this.tuiBtn,this.menuBtn]) head.appendChild(x);
    el.appendChild(head);

    // 대화
    this.log=document.createElement('div'); this.log.className='agp-log';
    this.log.setAttribute('role','log'); this.log.setAttribute('aria-label',t('agent.view_label'));
    el.appendChild(this.log);

    // 입력
    const inp=document.createElement('div'); inp.className='agp-input';
    this.sugg=document.createElement('div'); this.sugg.className='agp-sugg'; this.sugg.hidden=true;
    inp.appendChild(this.sugg);
    const row=document.createElement('div'); row.className='agp-input-row';
    this.ta=document.createElement('textarea'); this.ta.className='agp-ta'; this.ta.rows=2;
    this.ta.placeholder=t('agent.prompt_placeholder'); this.ta.setAttribute('aria-label',t('agent.input_label'));
    this.ta.addEventListener('keydown',e=>this._onKey(e));
    this.ta.addEventListener('input',()=>this._suggest());
    row.appendChild(this.ta);
    this.stopBtn=UIKit.button({icon:'x',title:t('agent.interrupt'),kind:'ghost',cls:'agp-stop',onClick:()=>this.interrupt()});
    this.sendBtn=UIKit.button({icon:'play',title:t('agent.send'),kind:'primary',cls:'agp-send',onClick:()=>this.send()});
    row.appendChild(this.stopBtn); row.appendChild(this.sendBtn);
    inp.appendChild(row);
    el.appendChild(inp);
    this._setState('');
  }

  // ── 연결·재생 ──

  connect(){ this.resync() }

  /**
   * 재생. `since` 는 마지막으로 본 seq — 처음은 0 이라 전량이다. 틈이 보일 때와
   * SSE 가 다시 붙을 때도 같은 길이다 (FR-ABG-4 의 P3 몫).
   */
  async resync(){
    if(this._destroyed||this._loading) return;
    // 비행 중에 온 SSE 는 잡아 둔다. 그대로 적용하면 `this.state` 가 아직 없어
    // status(commands·models)가 떨어지고, 뒤이어 앉는 서버 상태는 그보다 오래된
    // 것이라 그 뒤로도 돌아오지 않는다 (재생이 0건이면 틈도 없어 다시 묻지 않는다).
    this._pending=[];
    this._loading=apiGet('/api/agent/events',{query:{tool:this.id,since:this.seq}});
    const r=await this._loading; this._loading=null;
    const pend=this._pending; this._pending=null;
    if(this._destroyed) return;
    if(!r.ok){
      if(r.status===404) this._exited();
      return;
    }
    const d=r.data||{};
    // FR-ABG-21 · D-C-13: 잘린 앞부분은 요약 스냅샷 하나 — 마지막 assistant 메시지를 한 번 그린다.
    if(d.truncated&&this.seq===0){
      this._line('agp-note',t('agent.truncated'));
      if(d.snapshot&&d.snapshot.lastMessage){ this._message(d.snapshot.lastMessage); this._endLive() }
    }
    if(d.state) this._applyState(d.state);
    for(const le of (d.events||[])) this._apply(le,true);
    // D-C-11·15: 프로세스가 없으면 휴면 또는 오류 — 이벤트 뒤에 놓아야 재개 버튼이 맨 아래다.
    // 재개할 수 있으면 그 길을 놓는다 (FR-ABG-20).
    const st=d.state||{};
    if(st.dormant) this._dormantState(st.dormant,st.reason||'',!!st.resumable);
    else if(this._dormant) this._revive();
    for(const a of pend) this.onEvent(a);
    this._scrollEnd();
  }

  /** SSE 한 건. seq 가 이어지지 않으면 재생으로 메운다. */
  onEvent(a){
    if(this._destroyed||!a) return;
    if(this._pending){ this._pending.push(a); return }
    const seq=Number(a.seq)||0;
    if(seq<=this.seq) return;
    if(seq!==this.seq+1){ this.resync(); return }
    this._apply({seq,at:a.at,ev:a.ev},false);
    this._scrollEnd();
  }

  _applyState(st){
    this.state=st;
    if(st.agent&&!this.name){this.name=st.agent; this.lblEl.textContent=st.agent}
    const s=st.status||{};
    this._setModel(s.model); this._setPerm(s.permissionMode);
    this._setUsage(st.usage||{});
    this._openIds=new Set((st.open||[]).map(o=>o.id));
    this._renderOpen();
    if(st.sessionId) this._sessionLine(st.sessionId);
    // 열린 요청은 그대로 보인다 (FR-ABG-5) — 프로세스가 없으면 답할 곳이 없으니 열지 않는다.
    const open=st.open||[];
    if(open.length&&!this._dialog&&!st.dormant) this._openApproval(open[0]);
    this.stopBtn.hidden=!(st.controls&&st.controls.interrupt);
    // FR-M9-36: 우클릭 메뉴와 **같은 조건**이다 (아래 `_openMenu` 의 `ctl.tuiResume`).
    // 두 자리가 다른 문장으로 답하면 그 차이가 곧 결함이다 (§2-21).
    this.tuiBtn.hidden=!(st.controls&&st.controls.tuiResume);
    this._refreshOrigin();
  }

  _apply(le,replay){
    const ev=le.ev||{};
    this.seq=le.seq;
    // 휴면·오류 뒤에 라이브로 exit 아닌 이벤트가 오면 재개된 것이다 (다른 브라우저가 재개했을 때).
    if(!replay&&this._dormant&&ev.kind!=='exit') this._revive();
    switch(ev.kind){
      case 'session': this._setState('idle'); this._mergeStatus(ev.status); this._sessionLine(ev.sessionId); break;
      case 'user': this._endLive(); this._msg('agp-user',ev.text||''); this._pushHistory(ev.text||''); break;
      case 'turn_start': this._setState('working'); break;
      case 'turn_end': this._endLive(); this._setState('done'); if(ev.isError) this._line('agp-note agp-err', ev.text==='aborted_streaming'?t('agent.turn_aborted'):t('agent.turn_error',{reason:ev.text||''})); break;
      case 'text_delta': this._liveText(ev.text||''); break;
      case 'thinking_delta': this._liveThinking(ev.text||''); break;
      case 'message': this._message(ev.message); break;
      case 'tool_start': this._toolCard(ev.toolUseId,ev.tool,null); break;
      case 'tool_end': this._toolResult(ev.toolUseId,ev.text||'',!!ev.isError); break;
      case 'approval_open': this._setState('waiting'); if(ev.approval){this._openIds.add(ev.approval.id); this._renderOpen(); if(!replay) this._announce(ev.approval); this._openApproval(ev.approval)} break;
      case 'approval_closed': this._setState('working'); if(ev.approval){this._openIds.delete(ev.approval.id); if(this._dialog&&this._dialog.id===ev.approval.id) this._dialog.close(); if(this.state&&this.state.open) this.state.open=this.state.open.filter(o=>o.id!==ev.approval.id)} this._renderOpen(); break;
      case 'usage': this._setUsage(ev.usage||{}); break;
      case 'status': this._mergeStatus(ev.status); if(ev.status&&ev.status.compacted) this._line('agp-note',t('agent.compacted')); break;
      case 'reset': this._line('agp-note',t('agent.reset',{sid:(ev.sessionId||'').slice(0,8)})); break;
      case 'error': this._line('agp-note agp-err',t('agent.error',{text:(ev.tool?ev.tool+': ':'')+(ev.text||'')})); break;
      case 'exit': this._exit(ev,replay); break;
      case 'raw': this._raw(ev); break;
    }
  }

  // ── 상태 줄 ──

  _setState(st){
    this._activity=st;
    const key={idle:'agent.state_idle',working:'agent.state_working',waiting:'agent.state_waiting',done:'agent.state_done',ended:'agent.state_ended',hibernated:'agent.state_hibernated',error:'agent.state_error'}[st];
    this.stateEl.textContent=key?t(key):'';
    this.stateEl.dataset.state=st||'';
    this.el.dataset.state=st||'';
  }
  /**
   * 상태 조각을 합친다 — 모델·권한은 머리에, 선택지(models·commands)는 `state.status` 에.
   * `session` 과 `status` 가 같은 함수를 지난다: claude 의 `initialize` 응답은 `session`
   * 으로 오는데(D-C-16) 종전에는 그 분기가 commands·models 를 버렸다 — 재생이 initialize
   * 보다 먼저 돌아온 판에서 슬래시 목록이 영영 비었다 (e2e TC-AGT-4, M8 P7 실측).
   */
  _mergeStatus(st){
    if(!st) return;
    this._setModel(st.model); this._setPerm(st.permissionMode);
    if(!this.state) return;
    if(st.models) this.state.status=Object.assign({},this.state.status,{models:st.models});
    if(st.commands) this.state.status=Object.assign({},this.state.status,{commands:st.commands});
  }
  _setModel(m){ if(m){ this._model=m; this.modelEl.textContent=t('agent.model_current',{model:m}) } }
  _setPerm(p){ if(p){ this._perm=p; this.permEl.textContent=t('agent.perm_mode_current',{mode:p}) } }
  _setUsage(u){
    this._usage=Object.assign({},this._usage||{},Object.fromEntries(Object.entries(u).filter(([,v])=>v)));
    const x=this._usage;
    /**
     * M9_SRS FR-M9-34 (사용자 지시 2026-09-14): **에이전트마다 모양이 다르다.**
     * 절대값(사용토큰/총토큰)을 주는 어댑터와 **비율만** 주는 어댑터가 둘 다 있다.
     * 종전에는 `x.tokens` 가 없으면 **아무것도 그리지 않았다** — 비율만 아는
     * 어댑터에서 이 자리가 영영 비었다.
     */
    if(x.tokens){
      this.ctxEl.textContent=x.contextWindow
        ? t('agent.ctx',{pct:Math.round(x.tokens/x.contextWindow*100),tokens:fmtTokens(x.tokens),window:fmtTokens(x.contextWindow)})
        : t('agent.ctx_unknown',{tokens:fmtTokens(x.tokens)});
    }else if(x.contextRatio){
      this.ctxEl.textContent=t('agent.ctx_ratio',{pct:Math.round(x.contextRatio*100)});
    }
    if(x.costUSD) this.costEl.textContent=t('agent.cost',{cost:x.costUSD.toFixed(4)});
    this._renderLimits(x.limits);
  }

  /**
   * FR-M9-34: 플랜 한도 목록. **주기의 수와 이름이 에이전트마다 다르므로** 목록을
   * 그대로 훑는다.
   *
   * 비어 있으면 **자리가 서지 않는다** — 한도를 말하지 않는 에이전트에서 빈 칸이
   * 보이면 "0%" 나 "고장" 으로 읽힌다 (FR-CBG-5: 모른다 ≠ 괜찮다).
   */
  _renderLimits(limits){
    const list=Array.isArray(limits)?limits:[];
    this.limitsEl.hidden=list.length===0;
    this.limitsEl.textContent=list.map(l=>{
      const name=this._limitLabel(l);
      // 총량을 주는 어댑터와 비율만 주는 어댑터가 다른 문장을 쓴다.
      return l.total
        ? t('agent.limit_abs',{name,used:fmtTokens(l.used||0),total:fmtTokens(l.total)})
        : t('agent.limit_pct',{name,pct:Math.round((l.ratio||0)*100)});
    }).join(' · ');
  }

  /**
   * D-M9-23 (사용자 결정): **주기 이름은 자유 문자열이다.** 아는 것만 번역하고
   * 모르는 것은 어댑터가 준 `label` 을 그대로 쓴다 — 열거로 굳히면 새 주기를 쓰는
   * 에이전트의 값이 조용히 사라진다.
   *
   * 카탈로그 밖의 문자열이 화면에 서는 자리이며, 그 사유가 이것이다: 그 문자열은
   * 우리 문구가 아니라 **에이전트가 준 데이터**다 (모델 이름·명령 목록과 같은 자격).
   */
  _limitLabel(l){
    switch(l&&l.kind){
      case 'five_hour': return t('agent.limit_five_hour');
      case 'seven_day': return t('agent.limit_seven_day');
      case 'monthly': return t('agent.limit_monthly');
      default: return (l&&(l.label||l.kind))||'';
    }
  }
  /**
   * FR-M9-35: 그 도구의 cwd 와 그것이 속한 저장소의 branch·upstream.
   *
   * **`source` 를 본다.** 두 종단 모두 도구를 모르면 **서버의 cwd 로 폴백**하고
   * 그 사실을 `source` 에 싣는다 (FR-ETR-31). 그것을 무시하면 남의 경로를
   * 사용자의 것으로 채우게 된다 — 조항이 그 사실을 응답에 넣은 이유가 그것이다.
   *
   * 저장소가 아니거나 cwd 를 모르면 **빈 채로 둔다.** `-` 나 `unknown` 으로 채우면
   * 그것이 값으로 읽힌다 (FR-CBG-5).
   */
  async _refreshOrigin(){
    if(this._destroyed) return;
    const c=await apiGet('/api/cwd',{query:{tool:this.id}});
    const cd=(c.ok&&c.data)||{};
    const cwd=cd.source==='tool'?(cd.cwd||''):'';
    if(this._destroyed) return;
    this.cwdEl.textContent=cwd?pathBase(cwd):'';
    this.cwdEl.title=cwd?t('agent.cwd_title')+'\n'+cwd:'';
    this.repoEl.textContent=''; this.repoEl.title='';
    if(!cwd) return;
    const at=await apiGet('/api/git/repo-at',{query:{tool:this.id}});
    const d=(at.ok&&at.data)||{};
    if(this._destroyed||d.source!=='tool'||!d.isRepo||!d.path) return;
    const st=await apiGet('/api/git/status',{query:{repo:d.path}});
    const g=(st.ok&&st.data)||{};
    if(this._destroyed||!g.branch) return;
    // 값은 git 의 것이다 — 번역하지 않는다. 문구는 `title` 에만 있다.
    this.repoEl.textContent=g.upstream?g.branch+' → '+g.upstream:g.branch;
    this.repoEl.title=t('agent.repo_title')+'\n'+d.path;
  }

  _renderOpen(){ const n=this._openIds.size; this.openEl.textContent=n>0?t('agent.open_requests',{n}):''; }
  _sessionLine(sid){ if(sid) this.el.dataset.sessionid=sid }

  // ── 대화 렌더 ──

  _scrollEnd(){ this.log.scrollTop=this.log.scrollHeight }

  _line(cls,text){
    const d=document.createElement('div'); d.className='agp-line '+cls; d.textContent=text; this.log.appendChild(d); return d;
  }
  _msg(cls,text){
    const d=document.createElement('div'); d.className='agp-msg '+cls;
    const who=document.createElement('div'); who.className='agp-who'; who.textContent=cls==='agp-user'?t('agent.user_label'):this.name;
    const body=document.createElement('div'); body.className='agp-body'; body.textContent=text;
    d.appendChild(who); d.appendChild(body); this.log.appendChild(d); return d;
  }
  _ensureLive(){
    if(this._live) return this._live;
    const d=this._msg('agp-assistant agp-live','');
    this._live=d; return d;
  }
  _liveText(s){ const d=this._ensureLive(); d.querySelector('.agp-body').textContent+=s }
  _liveThinking(s){
    const d=this._ensureLive();
    if(!this._liveThink){
      const det=document.createElement('details'); det.className='agp-think';
      const sum=document.createElement('summary'); sum.textContent=t('agent.thinking'); det.appendChild(sum);
      const pre=document.createElement('div'); pre.className='agp-think-body'; det.appendChild(pre);
      d.insertBefore(det,d.querySelector('.agp-body')); this._liveThink=pre;
    }
    this._liveThink.textContent+=s;
  }
  _endLive(){ if(this._live){ this._live.classList.remove('agp-live'); this._live=null; this._liveThink=null } }

  /** 에이전트 메시지 스냅샷 — 진행 중 블록을 이것으로 갈아 끼운다 (진실은 스냅샷이다). */
  _message(raw){
    // 와이어에서는 JSON 배열 그대로 온다(RawMessage 인라인). 문자열이면 파싱한다.
    let blocks=raw;
    if(typeof raw==='string'){ try{ blocks=JSON.parse(raw||'[]') }catch{ blocks=[] } }
    if(!Array.isArray(blocks)) return;
    const d=this._live||this._msg('agp-assistant agp-live','');
    this._live=d; this._liveThink=null;
    // 본문을 다시 그린다: who 만 남기고.
    for(const c of [...d.children]) if(!c.classList.contains('agp-who')) c.remove();
    let hasBody=false;
    for(const b of blocks){
      if(!b||typeof b!=='object') continue;
      if(b.type==='thinking'&&b.thinking){
        const det=document.createElement('details'); det.className='agp-think';
        const sum=document.createElement('summary'); sum.textContent=t('agent.thinking'); det.appendChild(sum);
        const pre=document.createElement('div'); pre.className='agp-think-body'; pre.textContent=b.thinking; det.appendChild(pre);
        d.appendChild(det);
      }else if(b.type==='text'){
        const body=document.createElement('div'); body.className='agp-body'; body.textContent=b.text||''; d.appendChild(body); hasBody=true;
      }else if(b.type==='tool_use'){
        const card=this._toolCard(b.id,b.name,b.input);
        if(card.parentNode!==d) d.appendChild(card);
      }
    }
    if(!hasBody){ const body=document.createElement('div'); body.className='agp-body'; d.appendChild(body) }
  }
  _toolCard(useId,tool,input){
    let card=useId?this._toolCards.get(useId):null;
    if(!card){
      card=document.createElement('div'); card.className='agp-tool';
      const h=document.createElement('div'); h.className='agp-tool-head'; h.textContent=t('agent.tool_call',{tool:tool||''});
      card.appendChild(h);
      if(useId) this._toolCards.set(useId,card);
      const host=this._live||this.log; host.appendChild(card);
    }
    if(input&&!card.querySelector('.agp-tool-in')){
      const pre=document.createElement('pre'); pre.className='agp-tool-in'; pre.textContent=agentDetail(tool,input); card.appendChild(pre);
    }
    return card;
  }
  _toolResult(useId,text,isErr){
    const card=this._toolCard(useId,'',null);
    const h=document.createElement('div'); h.className='agp-tool-res-head'+(isErr?' agp-err':''); h.textContent=isErr?t('agent.tool_result_error'):t('agent.tool_result');
    const pre=document.createElement('pre'); pre.className='agp-tool-res'; pre.textContent=text;
    card.appendChild(h); card.appendChild(pre);
    this._endLive();
  }
  _raw(ev){
    const det=document.createElement('details'); det.className='agp-raw';
    const sum=document.createElement('summary'); sum.textContent=t('agent.raw'); det.appendChild(sum);
    const pre=document.createElement('pre'); pre.textContent=ev.text||ev.raw||''; det.appendChild(pre);
    this.log.appendChild(det);
  }
  _exited(){
    if(this._ended) return; this._ended=true;
    this._endLive(); this._setState('ended');
    this._line('agp-note agp-exit',t('agent.exited'));
    this._disableInput();
  }
  _disableInput(){
    this.ta.disabled=true; this.sendBtn.disabled=true; this.stopBtn.disabled=true;
    if(this._dialog) this._dialog.close();
  }

  /**
   * exit 이벤트 — 사유가 갈린다 (D-C-15): hibernated → 휴면, died → 오류(사유 포함), closed → 종료.
   * 재생 중이면 상태는 뒤따르는 `_applyState` 가 세우므로 줄만 남긴다.
   */
  _exit(ev,replay){
    const reason=ev.text||'';
    if(reason==='closed'){ this._exited(); return }
    const kind=reason==='hibernated'?'hibernated':'error';
    this._endLive();
    if(kind==='error') this._line('agp-note agp-err',t('agent.died',{reason:ev.detail||''}));
    else this._line('agp-note agp-exit',t('agent.hibernated_line'));
    if(!replay){
      const sid=this.el.dataset.sessionid||(this.state&&this.state.sessionId);
      this._dormantState(kind,ev.detail||'',!!sid);
    }
  }

  /** 휴면·오류 상태 — 입력을 막고, 재개할 수 있으면 버튼을 놓는다 (FR-ABG-10·20). */
  _dormantState(kind,reason,resumable){
    this._dormant=kind; this._ended=true;
    this._endLive(); this._setState(kind);
    this._disableInput();
    if(this._resumeRow) this._resumeRow.remove();
    const row=document.createElement('div'); row.className='agp-line agp-note agp-dormant'; row.dataset.dormant=kind;
    const msg=document.createElement('span');
    msg.textContent=kind==='hibernated'?t('agent.hibernated_note'):t('agent.error_note',{reason:reason===''?t('agent.reason_unknown'):(reason==='server_restart'?t('agent.reason_server_restart'):reason)});
    row.appendChild(msg);
    if(resumable){
      const b=UIKit.button({label:t('agent.resume'),kind:'primary',size:'sm',cls:'agp-resume',onClick:()=>this.resume()});
      row.appendChild(b);
    }else{
      const hint=document.createElement('span'); hint.className='agp-dormant-hint'; hint.textContent=t('agent.not_resumable'); row.appendChild(hint);
    }
    this.log.appendChild(row); this._resumeRow=row;
    this._scrollEnd();
  }

  /** 재개됐다 — 입력을 다시 열고 상태 줄을 비운다. 이벤트가 상태를 다시 세운다. */
  _revive(){
    this._dormant=null; this._ended=false;
    if(this._resumeRow){ this._resumeRow.remove(); this._resumeRow=null }
    this.ta.disabled=false; this.sendBtn.disabled=false; this.stopBtn.disabled=false;
    this._setState('');
    this._line('agp-note',t('agent.resumed_line'));
  }

  async hibernate(){
    if(this._dormant||!this._canControl()) return;
    const r=await apiPost('/api/agent/hibernate',{toolId:this.id});
    if(!r.ok) Toast.show(apiErrText(r,t('agent.hibernate')),'err');
  }
  async resume(){
    if(!this._dormant||!this._canControl()) return;
    const r=await apiPost('/api/agent/resume',{toolId:this.id});
    if(!r.ok){ Toast.show(apiErrText(r,t('agent.resume')),'err'); return }
    // 응답보다 SSE 가 먼저 왔으면 이미 되살아났다 — 그때 다시 비우면 그 상태(idle)를 지운다.
    if(this._dormant) this._revive();
  }

  // ── 입력 (FR-AGT-4a) ──

  _canControl(){
    // FR-AGT-12: 소유자가 아닌 브라우저는 보기만 한다 — 터미널과 같은 규약. 클릭이
    // 소유권을 가져오므로(`.pn` 의 mousedown) 여기서는 막기만 한다.
    const pn=this.el.closest('.pn');
    return !(pn&&pn.classList.contains('pn-dimmed'));
  }
  _onKey(e){
    if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){ e.preventDefault(); this.send(); return }
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); this.interrupt(); return }
    if(e.key==='Tab'&&e.shiftKey){ e.preventDefault(); this.cyclePermission(); return }
    if(e.key==='Tab'&&!this.sugg.hidden){ e.preventDefault(); const b=this.sugg.querySelector('button'); if(b) b.click(); return }
    const atEdge=this.ta.selectionStart===this.ta.selectionEnd;
    if(e.key==='ArrowUp'&&atEdge&&!this.ta.value.slice(0,this.ta.selectionStart).includes('\n')){ if(this._histMove(-1)) e.preventDefault(); return }
    if(e.key==='ArrowDown'&&atEdge&&!this.ta.value.slice(this.ta.selectionEnd).includes('\n')){ if(this._histMove(1)) e.preventDefault(); return }
  }
  _pushHistory(text){
    if(!text) return;
    if(this._history[this._history.length-1]!==text) this._history.push(text);
    if(this._history.length>200) this._history.shift();
    this._histIdx=-1;
  }
  _histMove(dir){
    const h=this._history; if(!h.length) return false;
    if(this._histIdx===-1){ if(dir>0) return false; this._draft=this.ta.value; this._histIdx=h.length }
    const next=this._histIdx+dir;
    if(next<0) return true;
    if(next>=h.length){ this._histIdx=-1; this.ta.value=this._draft; return true }
    this._histIdx=next; this.ta.value=h[next];
    this.ta.selectionStart=this.ta.selectionEnd=this.ta.value.length;
    return true;
  }
  _suggest(){
    const v=this.ta.value;
    const cmds=(this.state&&this.state.status&&this.state.status.commands)||[];
    if(!v.startsWith('/')||v.includes(' ')||v.includes('\n')||!cmds.length){ this.sugg.hidden=true; this.sugg.textContent=''; return }
    const q=v.slice(1).toLowerCase();
    const hits=cmds.filter(c=>c.toLowerCase().startsWith(q)).slice(0,8);
    this.sugg.textContent='';
    if(!hits.length||(hits.length===1&&hits[0]===q)){ this.sugg.hidden=true; return }
    for(const c of hits){
      const b=document.createElement('button'); b.type='button'; b.className='ui-btn ui-btn-sm ui-btn-ghost agp-sugg-item'; b.textContent='/'+c;
      b.addEventListener('click',()=>{ this.ta.value='/'+c+' '; this.sugg.hidden=true; this.ta.focus() });
      this.sugg.appendChild(b);
    }
    this.sugg.hidden=false;
  }
  async send(){
    const text=this.ta.value.trim();
    if(!text||this._ended||!this._canControl()) return;
    this.ta.value=''; this.sugg.hidden=true; this._histIdx=-1;
    const r=await apiPost('/api/agent/prompt',{toolId:this.id,text});
    if(!r.ok){ Toast.show(apiErrText(r,t('agent.send')),'err'); this.ta.value=text }
  }
  async interrupt(){
    if(this._ended||!this._canControl()||this.stopBtn.hidden) return;
    const r=await apiPost('/api/agent/interrupt',{toolId:this.id});
    if(!r.ok) Toast.show(apiErrText(r,t('agent.interrupt')),'err');
  }
  async control(kind,value){
    if(this._ended||!this._canControl()) return;
    const r=await apiPost('/api/agent/control',{toolId:this.id,kind,value});
    if(!r.ok) Toast.show(apiErrText(r,t('agent.menu_title')),'err');
  }
  cyclePermission(){
    const modes=(this.state&&this.state.permissionModes)||[];
    if(!modes.length) return;
    const i=modes.indexOf(this._perm||'');
    this.control('set_permission_mode',modes[(i+1)%modes.length]);
  }

  // ── 메뉴 (FR-AGT-10·11) ──

  _openMenu(e){
    const st=this.state||{}; const s=st.status||{}; const ctl=st.controls||{};
    const items=[];
    if(ctl.control&&s.models&&s.models.length){
      items.push({label:t('agent.model'),static:true});
      for(const m of s.models) items.push({id:'model:'+m.value,label:m.displayName||m.value,title:m.description||'',cur:m.value===this._model,onClick:()=>this.control('set_model',m.value)});
    }
    if(ctl.control&&st.permissionModes&&st.permissionModes.length){
      items.push({sep:true},{label:t('agent.perm_mode'),static:true});
      for(const p of st.permissionModes) items.push({id:'perm:'+p,label:p,cur:p===this._perm,onClick:()=>this.control('set_permission_mode',p)});
      items.push({id:'perm-cycle',label:t('agent.perm_cycle'),onClick:()=>this.cyclePermission()});
    }
    if(ctl.control){
      items.push({sep:true},{id:'think',label:t('agent.thinking_budget'),onClick:()=>{
        const v=prompt(t('agent.thinking_budget'),'');
        if(v&&/^\d+$/.test(v.trim())) this.control('set_max_thinking_tokens',v.trim());
      }});
    }
    if(ctl.interrupt) items.push({sep:true},{id:'interrupt',label:t('agent.interrupt'),disabled:this._ended,onClick:()=>this.interrupt()});
    // FR-ABG-10·11: 휴면은 명시적이다 — 신원이 있을 때만 (D-C-16). 휴면·오류면 재개.
    if(this._dormant) items.push({sep:true},{id:'resume',label:t('agent.resume'),disabled:st.resumable?false:t('agent.not_resumable'),onClick:()=>this.resume()});
    else items.push({sep:true},{id:'hibernate',label:t('agent.hibernate'),disabled:(st.sessionId||this.el.dataset.sessionid)?false:t('err.agent_no_identity'),onClick:()=>this.hibernate()});
    if(ctl.tuiResume) items.push({sep:true},{id:'tui',label:t('agent.open_terminal'),onClick:()=>this.app.agentOpenTerminal(this.id)});
    if(!items.length) return;
    UIKit.menu(items,{at:{x:e.clientX||0,y:e.clientY||0},cls:'agp-menu'});
  }

  // ── 승인·질문 (FR-AGT-4·5·9) ──

  _announce(req){
    const key=req.kind==='question'?'agent.question_arrived':'agent.approval_arrived';
    Toast.show(t(key,{agent:this.name,tool:req.tool||''}),'',4000);
  }
  _openApproval(req){
    if(!req||this._dialog||this._ended) return;
    const body=document.createElement('div'); body.className='agp-appr';
    const isQ=req.kind==='question';
    if(!isQ){
      if(req.description){ const p=document.createElement('div'); p.className='agp-appr-desc'; p.textContent=req.description; body.appendChild(p) }
      const pre=document.createElement('pre'); pre.className='agp-appr-in'; pre.textContent=agentDetail(req.tool,req.input); body.appendChild(pre);
    }
    const answers={};
    const fields=[];
    if(isQ){
      for(const [qi,q] of (req.questions||[]).entries()){
        const fs=document.createElement('fieldset'); fs.className='agp-q';
        const lg=document.createElement('legend'); lg.textContent=(q.header?q.header+' — ':'')+q.question; fs.appendChild(lg);
        if(q.freeText){
          // 선택지 없는 질문 — 글로 답한다 (P4: omp 의 input·editor, codex 의 선택지 없는 질문).
          const inp=document.createElement('input'); inp.type='text'; inp.className='agp-q-text'; inp.setAttribute('aria-label',q.question);
          inp.addEventListener('input',()=>{ answers[q.question]=inp.value });
          answers[q.question]='';
          fs.appendChild(inp); body.appendChild(fs); fields.push(fs);
          continue;
        }
        for(const [oi,o] of (q.options||[]).entries()){
          const lab=document.createElement('label'); lab.className='agp-q-opt';
          const inp=document.createElement('input'); inp.type=q.multiSelect?'checkbox':'radio'; inp.name='agp-q-'+this.id+'-'+qi; inp.value=o.label;
          inp.addEventListener('change',()=>{
            if(q.multiSelect){
              const picked=[...fs.querySelectorAll('input:checked')].map(x=>x.value);
              answers[q.question]=picked.join(', ');
            }else answers[q.question]=o.label;
          });
          if(oi===0&&!q.multiSelect){ inp.checked=true; answers[q.question]=o.label }
          lab.appendChild(inp);
          const txt=document.createElement('span'); txt.textContent=o.label+(o.description?' — '+o.description:''); lab.appendChild(txt);
          fs.appendChild(lab);
        }
        body.appendChild(fs); fields.push(fs);
      }
    }
    const decide=async d=>{
      const r=await apiPost('/api/agent/approve',Object.assign({toolId:this.id,id:req.id},d));
      if(!r.ok) Toast.show(apiErrText(r,t('agent.answer')),'err');
    };
    const actions=[];
    if(isQ){
      actions.push({label:t('agent.choice_deny'),onClick:()=>decide({choice:'deny'})});
      actions.push({label:t('agent.answer'),kind:'primary',onClick:()=>decide({answers})});
    }else{
      // 선택지는 프로토콜이 준 그대로다 (FR-AGT-5). allow·deny 만 카탈로그 라벨을 쓴다.
      for(const o of (req.options||[])){
        const label=o.id==='allow'?t('agent.choice_allow'):o.id==='deny'?t('agent.choice_deny'):o.label;
        actions.push({label,kind:o.id==='allow'?'primary':(o.id==='deny'?'danger':undefined),cls:'agp-choice',dataset:{choice:o.id},onClick:()=>decide({choice:o.id})});
      }
    }
    const title=isQ?t('agent.question_title'):t('agent.approval_title',{tool:req.tool||''});
    const m=UIKit.modal({title,body,actions,cls:'agp-modal',closeTitle:t('agent.choice_deny'),onClose:()=>{ if(this._dialog&&this._dialog.id===req.id) this._dialog=null }});
    // 바깥 클릭·Esc 는 답이 아니다 — 요청은 열린 채 남고 다시 열 수 있다 (FR-APS-6).
    this._dialog={id:req.id,close:m.close};
    document.body.appendChild(m.el);
  }

  destroy(){
    this._destroyed=true;
    if(this._dialog) this._dialog.close();
    this.el.remove();
  }
}

function fmtTokens(n){ return n>=1000?(n/1000).toFixed(n>=100000?0:1)+'k':String(n) }

/** 도구 입력에서 보여줄 한 덩이 — 명령·경로가 있으면 그것, 없으면 JSON. */
function agentDetail(tool,input){
  let o=input;
  if(typeof input==='string'){ try{o=JSON.parse(input)}catch{return input} }
  if(!o||typeof o!=='object') return '';
  if(typeof o.command==='string') return o.command;
  if(typeof o.file_path==='string') return o.file_path;
  try{ return JSON.stringify(o,null,2) }catch{ return String(o) }
}
