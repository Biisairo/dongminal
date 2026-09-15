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
    /**
     * M11_SRS FR-M11-6 (M11-B3): **계정·플랜.** 프로토콜이 `initialize` 에 실어
     * 주고 어댑터가 `ProtoStatus.Account` 로 날라 왔는데 **화면이 버리고 있었다** —
     * 접수한 하단이 비어 보인 까닭의 하나다. 턴 전에도 아는 값이다.
     */
    this.acctEl=document.createElement('span'); this.acctEl.className='agp-acct';
    /**
     * M9_SRS FR-M9-34: **플랜 한도는 컨텍스트 채움과 다른 자리에 선다.**
     * 둘은 출처가 다르고(하나는 이 대화, 하나는 계정 전체), 나란히 같은 모양으로
     * 두면 사용자가 같은 것으로 읽는다. 그래서 이름을 주기로 달고 사유를 title 에 둔다.
     */
    this.limitsEl=document.createElement('span'); this.limitsEl.className='agp-limits';
    this.limitsEl.title=t('agent.limits_title');
    // FR-M9-34 가 나르기 시작한 값 — 그리는 자리는 여기다.
    this.cacheEl=document.createElement('span'); this.cacheEl.className='agp-cache';
    // 세션 신원은 종전에 `dataset` 에만 있었다 (화면에 없었다).
    this.sessEl=document.createElement('span'); this.sessEl.className='agp-sess';
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
    /**
     * M9_SRS FR-M9-39 (M9-B20, 사용자 결정 2026-09-14): **머리에는 셋만 남는다.**
     *
     *   이전 동작: 값 열 개가 머리에 한 줄로 늘어섰다 — 좁고, 늘어날수록 읽기 어렵다
     *   새  동작: 이름·상태·(버튼) 만 남기고 **전부 하단 대시보드로 내린다**
     *   이유:     접수한 말이 *"채팅 하단에 보기 좋게 대시보드로"* 이고, 중복을
     *             어떻게 할지 물었을 때 *"상단에것을 없애고 전부 하단으로 내린다"*
     *             였다. 같은 값이 두 자리에 서지 않는다
     */
    for(const x of [this.lblEl,this.stateEl,sp,this.tuiBtn,this.menuBtn]) head.appendChild(x);
    el.appendChild(head);

    // 대화
    // FR-M11-2: 스크롤 규약은 `ui-scroll` 하나다 (`style-kit.css`). GUI 만 그것을
    // 쓰지 않아 브라우저 기본 스크롤바가 서 있었다 — 새 모양을 만들지 않는다.
    this.log=document.createElement('div'); this.log.className='agp-log ui-scroll';
    this.log.setAttribute('role','log'); this.log.setAttribute('aria-label',t('agent.view_label'));
    el.appendChild(this.log);

    // 입력
    const inp=document.createElement('div'); inp.className='agp-input';
    this.sugg=document.createElement('div'); this.sugg.className='agp-sugg'; this.sugg.hidden=true;
    inp.appendChild(this.sugg);
    const row=document.createElement('div'); row.className='agp-input-row';
    this.ta=document.createElement('textarea'); this.ta.className='agp-ta ui-scroll'; this.ta.rows=2;
    this.ta.placeholder=t('agent.prompt_placeholder'); this.ta.setAttribute('aria-label',t('agent.input_label'));
    this.ta.addEventListener('keydown',e=>this._onKey(e));
    this.ta.addEventListener('input',()=>{ this._suggest(); this._growInput() });
    row.appendChild(this.ta);
    this.stopBtn=UIKit.button({icon:'x',title:t('agent.interrupt'),kind:'ghost',cls:'agp-stop',onClick:()=>this.interrupt()});
    this.sendBtn=UIKit.button({icon:'play',title:t('agent.send'),kind:'primary',cls:'agp-send',onClick:()=>this.send()});
    row.appendChild(this.stopBtn); row.appendChild(this.sendBtn);
    inp.appendChild(row);
    el.appendChild(inp);

    /**
     * FR-M9-39·40: **채팅 하단의 대시보드.** 참조는 사용자 화면의 `claude-dashboard`
     * (statusline) 이며 자리도 같다 — 대화와 입력 **아래**다.
     *
     * 담는 것은 **우리가 실제로 가진 값**이다. 없는 것은 추정으로 채우지 않으며
     * (D-M9-22 의 근거가 여기에도 선다), 값이 없는 항목은 자리를 차지하지 않는다 —
     * 각 갱신 함수가 빈 문자열을 쓰면 `:empty` 로 사라진다.
     */
    const dash=document.createElement('div'); dash.className='agp-dash';
    // 바 둘은 **출처가 다르다** (FR-M9-34): 컨텍스트는 이 대화의 채움, 한도는 계정
    // 전체. 이름과 단위를 다르게 두는 규약이 여기서도 선다.
    this.ctxBar=this._mkBar('agp-ctxbar',t('agent.ctx_bar_label'));
    dash.appendChild(this.ctxBar.el); dash.appendChild(this.ctxEl);
    // FR-M11-19 개정 (M11-B30): 게이지는 **주기 칸 안**에 산다 (`_mkLimitCell`).
    // FR-M11-33 (M11-B31): **비용은 그리지 않는다** — 자리와 값 모두 없앴다.
    dash.appendChild(this.limitsEl);
    for(const x of [this.cacheEl,this.modelEl,this.permEl,
      this.acctEl,this.cwdEl,this.repoEl,this.sessEl,this.openEl]) dash.appendChild(x);
    el.appendChild(dash);
    this._dashUnknown();
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
    /**
     * M9_SRS FR-M9-41 (M9-B23): **기록을 가져오지 못했으면 그렇게 말한다.**
     *
     * 접수한 말이 *"세션 기록이 그대로 넘어가야하는데 아무것도 안보인다"* 였다.
     * 조용히 빈 화면은 "세션이 안 이어졌다" 로 읽힌다 — 실제로는 이어져 있고
     * 그리지 못한 것이 재료뿐인데도 그렇다. 그래서 부재를 문장으로 낸다
     * (FR-APS-4). 빈 값은 **묻지 않았다**(재개가 아니다)이므로 아무것도 내지 않는다.
     */
    if(this.seq===0&&(d.state||{}).history==='unavailable') this._line('agp-note',t('agent.history_unavailable'));
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
    // FR-M11-26: **넣기 전에** 바닥이었는지 묻고, 그랬을 때만 따라간다.
    const stick=this._atBottom();
    this._apply({seq,at:a.at,ev:a.ev},false);
    if(stick) this._scrollEnd();
  }

  _applyState(st){
    this.state=st;
    if(st.agent&&!this.name){this.name=st.agent; this.lblEl.textContent=st.agent}
    const s=st.status||{};
    this._setModel(s.model); this._setPerm(s.permissionMode); this._setAccount(s.account);
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
    this._setModel(st.model); this._setPerm(st.permissionMode); this._setAccount(st.account);
    if(!this.state) return;
    if(st.models) this.state.status=Object.assign({},this.state.status,{models:st.models});
    if(st.commands) this.state.status=Object.assign({},this.state.status,{commands:st.commands});
  }
  _setModel(m){ if(m){ this._model=m; this.modelEl.textContent=t('agent.model_current',{model:m}) } }
  _setPerm(p){ if(p){ this._perm=p; this.permEl.textContent=t('agent.perm_mode_current',{mode:p}) } }
  // FR-M11-6: 어댑터가 합친 한 줄을 그대로 낸다 — 모델 이름·명령 목록과 같은 자격의
  // **에이전트가 준 데이터**이므로 카탈로그 밖 문자열이다 (D-M9-23 과 같은 근거).
  _setAccount(a){ if(a){ this._account=a; this.acctEl.textContent=t('agent.account',{account:a}) } }
  /**
   * M9_SRS FR-M9-40 (M9-B22): **바는 장식이 아니라 값이다.**
   *
   * 접수한 말: *"context window 는 bar 가 차는 모양으로도 같이 보고싶어."*
   * **숫자와 함께**이므로 옆의 텍스트는 그대로 남는다.
   *
   * `role="progressbar"` 와 `aria-valuenow` 를 다는 이유가 그것이다 — 화면을 보지
   * 않는 사람에게도 이 요소는 값이어야 한다.
   */
  /**
   * FR-M11-16 (M11-B13): **자리는 항상 선다 — 값이 없으면 모름을 적는다.**
   *
   * 접수: *"첫 메세지를 보내기전에는 기본값 설정하고 이후 맞추면 되잖아. 없애지 말고
   * 모르는걸로 해서 보여줘."* **앞선 결정의 번복**이다 (*"있는 것만 더 그린다"*).
   *
   * 여기가 그 규약이 사는 **한 자리**다 — 각 세터는 값이 오면 덮어쓸 뿐이고, 값이
   * 오지 않는 자리는 여기서 적은 문구가 그대로 남는다. `initialize` 응답에 비용·
   * 토큰·한도의 수가 **아예 없으므로**(M11_SRS §2.5) 그 넷은 첫 턴까지 이 문구다.
   *
   * 0 으로 채우지 않는다 — **모름을 모름이라고 적는 것**이며 `FR-CBG-5` 그대로다.
   * 열린 요청은 **세어서 아는 값**이므로 여기서도 0 으로 적는다.
   */
  _dashUnknown(){
    const u=t('core.unknown_paren');
    this.ctxEl.textContent=t('agent.ctx_unknown',{tokens:u});
    this.cacheEl.textContent=t('agent.cache_unknown');
    this._renderLimits([]);
    this.modelEl.textContent=t('agent.model_current',{model:u});
    this.permEl.textContent=t('agent.perm_mode_current',{mode:u});
    this.acctEl.textContent=t('agent.account',{account:u});
    this.sessEl.textContent=t('agent.session_label',{sid:u});
    this.cwdEl.textContent=t('agent.cwd_unknown');
    this.repoEl.textContent=t('agent.repo_unknown');
    this.openEl.textContent=t('agent.open_requests',{n:0});
  }

  _mkBar(cls,label){
    const el=document.createElement('div'); el.className='agp-bar '+cls;
    el.setAttribute('role','progressbar');
    // **이름이 있어야 값이다.** `role` 과 수치만 달면 화면을 보지 않는 사람에게는
    // "무엇의" 비율인지가 없다 — 접근성 검사가 그 누락을 잡았다(TC-AGT-5 외 5건).
    el.setAttribute('aria-label',label);
    el.setAttribute('aria-valuemin','0'); el.setAttribute('aria-valuemax','100');
    const fill=document.createElement('div'); fill.className='agp-bar-fill';
    el.appendChild(fill);
    return {el,fill};
  }

  /**
   * FR-M11-16 (M11-B13): **트랙은 항상 서고, 모르면 값을 달지 않는다.**
   *
   *   이전: 모르면 바를 **숨겼다** (`hidden`) — FR-M9-40 의 *"모르면 그리지 않는다"*
   *   새로: 트랙은 서고, 채움이 0 폭이며 `aria-valuenow` 가 **없다**
   *   이유: 접수는 *"없애지 말고 모르는걸로 해서 보여줘"* 다. 화면에서 채움 0 은 실제
   *         0% 와 같아 보이며 **그것을 알고 고른 결정**이다 (사용자 2026-09-15) —
   *         가르는 자리를 **읽히는 쪽**에 둔다. `aria-valuenow` 가 없으면
   *         indeterminate 이고, 0 이면 "0%" 다. `FR-CBG-5` 는 그대로 지켜진다.
   *
   * 0 은 여전히 값이다 — 가르는 것은 숫자인가다.
   */
  _setBar(bar,ratio){
    const ok=typeof ratio==='number'&&isFinite(ratio)&&ratio>=0;
    if(!ok){ bar.fill.style.width='0'; bar.el.removeAttribute('aria-valuenow'); return }
    const pct=Math.min(100,Math.round(ratio*100));
    bar.fill.style.width=pct+'%';
    bar.el.setAttribute('aria-valuenow',String(pct));
  }

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
    // FR-M9-40: 컨텍스트 바 — 절대값을 알면 그것으로, 아니면 비율로.
    this._setBar(this.ctxBar,
      (x.tokens&&x.contextWindow)?x.tokens/x.contextWindow
        :(typeof x.contextRatio==='number'?x.contextRatio:null));
    // FR-M9-34 가 나르기 시작한 cache 를 그린다.
    this.cacheEl.textContent=(x.cacheRead||x.cacheWrite)
      ? t('agent.cache',{read:fmtTokens(x.cacheRead||0),write:fmtTokens(x.cacheWrite||0)})
      : t('agent.cache_unknown');
    this._renderLimits(x.limits);
  }

  /**
   * FR-M9-34: 플랜 한도 목록. **주기의 수와 이름이 에이전트마다 다르므로** 목록을
   * 그대로 훑는다.
   *
   * FR-M11-16 (M11-B13): 비어 있으면 **모름이라고 적는다.** 종전에는 자리를 숨겼고
   * (`hidden`), 그 빈 자리가 *"그런 항목이 아예 없다"* 로 읽힌 것이 접수였다. 빈 칸을
   * 두는 것과는 다르다 — 빈 칸은 "0%" 나 "고장" 으로 읽히지만 **모름은 모름으로
   * 읽힌다** (FR-CBG-5: 모른다 ≠ 괜찮다).
   */
  _renderLimits(limits){
    const list=Array.isArray(limits)?limits:[];
    this.limitsEl.textContent='';
    // **주기를 모르면 개수도 모른다** — 칸 하나만 세우고 값은 달지 않는다 (FR-M11-16).
    for(const l of (list.length?list:[null])) this.limitsEl.appendChild(this._mkLimitCell(l));
  }

  /**
   * FR-M11-19 개정 (M11-B30): **주기 하나가 한 칸이다** — 이름·수치·게이지가 함께 든다.
   *
   * 접수: *"5시간옆에 5시간 게이지를 주간 옆에 주간게이지를 넣어야한다."* 첫 구현은
   * 게이지를 한 칸에 몰아 두고 수치는 그 옆에 따로 두었다 — `aria-label` 은 어느
   * 주기인지 말하지만 그것은 **읽히는 쪽**이고, 보는 쪽에는 이을 근거가 없었다.
   *
   * **원본은 게이지를 컨텍스트에만 둔다** (§2.10 (1) 실측 — 한도는 `5h: 24% (3h11m)`
   * 처럼 글로만 말한다). 게이지를 더하는 것은 사용자 결정이며(*"limit 에 추가한건
   * 좋은거같아"*), `D-M11-3` 이 말한 **더하는 편의**다 — 원본의 글을 지우지 않는다.
   */
  _mkLimitCell(l){
    const cell=document.createElement('span'); cell.className='agp-limit';
    const txt=document.createElement('span'); txt.className='agp-limit-txt';
    const name=l?this._limitLabel(l):'';
    // 총량을 주는 어댑터와 비율만 주는 어댑터가 다른 문장을 쓴다.
    txt.textContent=l
      ? (l.total
        ? t('agent.limit_abs',{name,used:fmtTokens(l.used||0),total:fmtTokens(l.total)})
        : t('agent.limit_pct',{name,pct:Math.round((l.ratio||0)*100)}))
      : t('agent.limits_unknown');
    const bar=this._mkBar('agp-limbar',
      l?t('agent.limit_bar_label_of',{name}):t('agent.limit_bar_label'));
    cell.appendChild(txt); cell.appendChild(bar.el);
    this._setBar({el:bar.el,fill:bar.fill},
      l?(typeof l.ratio==='number'?l.ratio:(l.total?(l.used||0)/l.total:null)):null);
    return cell;
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
    // FR-M11-35 (M11-B33): **경로 그대로.** 마지막 칸만으로는 같은 이름의 폴더를
    // 가리지 못하고, `title` 은 가리켜야 보이므로 "적혀 있다" 가 아니다.
    this.cwdEl.textContent=cwd||t('agent.cwd_unknown');
    this.cwdEl.title=cwd?t('agent.cwd_title')+'\n'+cwd:'';
    this.repoEl.textContent=t('agent.repo_unknown'); this.repoEl.title='';
    if(!cwd) return;
    const at=await apiGet('/api/git/repo-at',{query:{tool:this.id}});
    const d=(at.ok&&at.data)||{};
    if(this._destroyed) return;
    /**
     * **아는 '아님' 은 모름이 아니다** — `FR-CBG-5` 의 반대 방향이다 (FR-M11-16).
     * 그 작업 폴더가 저장소가 아니라는 것을 우리가 **안다면** 그렇게 적는다. 물어보지
     * 못한 경우(응답이 이 도구의 것이 아니거나 경로가 없다)만 모름으로 남는다.
     */
    if(d.source==='tool'&&d.isRepo===false){ this.repoEl.textContent=t('agent.repo_none'); return }
    if(d.source!=='tool'||!d.isRepo||!d.path) return;
    const st=await apiGet('/api/git/status',{query:{repo:d.path}});
    /**
     * FR-M11-34 (M11-B32): **`branch` 는 `status` 안에 있다.** 종전에는 한 겹 위를
     * 읽어 `!g.branch` 에서 **언제나** 되돌아섰다. 그 갈래가 빈 문자열을 남기면
     * `:empty` 가 자리를 지웠으므로 화면에 아무것도 없어 아무도 몰랐고, `FR-M11-16`
     * 이 자리를 세우자 *"알 수 없음"* 으로 드러났다 (실측: 운영 `/api/git/status`).
     */
    const g=(st.ok&&st.data&&st.data.status)||{};
    if(this._destroyed||!g.branch) return;
    // 값은 git 의 것이다 — 번역하지 않는다. 문구는 `title` 에만 있다.
    this.repoEl.textContent=g.upstream?g.branch+' → '+g.upstream:g.branch;
    this.repoEl.title=t('agent.repo_title')+'\n'+d.path;
  }

  /**
   * FR-M11-16: **세어서 아는 0 은 0 으로 적는다.** 이 수는 프로토콜이 주는 것이 아니라
   * 우리가 세는 것이므로 모름이 아니다 — 모름으로 덮으면 `FR-CBG-5` 를 반대편에서
   * 어긴다. 종전에는 0 일 때 자리를 비웠다.
   */
  _renderOpen(){ const n=this._openIds.size; this.openEl.textContent=t('agent.open_requests',{n}); }
  _sessionLine(sid){
    if(!sid) return;
    this.el.dataset.sessionid=sid;
    // FR-M9-39: 종전에는 `dataset` 에만 있어 화면에 없었다. 전체 uuid 는 자리를
    // 먹으므로 앞 여덟 자만 — 되짚을 때 쓰는 것은 그 접두다.
    this.sessEl.textContent=t('agent.session_label',{sid:sid.slice(0,8)});
  }

  // ── 대화 렌더 ──

  _scrollEnd(){ this.log.scrollTop=this.log.scrollHeight }

  /**
   * FR-M11-26 (M11-B24): **바닥을 보고 있는가.**
   *
   * 접수: *"새 글이 있으면 무조건 스크롤을 아래로 내린다. 현재위치 고정해야한다.
   * 스크롤은 사용자만 조작한다."* 사용자 결정(§2.6b)은 **바닥 판정**이다 — 바닥에
   * 붙어 있으면 따라가고, 한 칸이라도 올렸으면 그 자리를 지킨다.
   *
   * **붙기 전에 물어야 한다.** 새 내용이 들어간 뒤에 재면 아래가 이미 늘어나 있어
   * 언제나 "바닥이 아니다" 가 된다.
   */
  _atBottom(){
    const el=this.log;
    return el.scrollHeight-el.scrollTop-el.clientHeight<=AGENT_BOTTOM_SLACK_PX;
  }

  /**
   * FR-M11-17 (M11-B14): **떼기 전의 대화 자리.**
   *
   * 접수: *"gui 에서 다른곳에 다녀오면 스크롤이 최상단으로 이동해. 유지해야해."*
   * 요소가 문서에서 떨어지면 브라우저가 `scrollTop` 을 버리므로, 돌아왔을 때 0 이다.
   *
   * **규약은 이미 있었고 이 자리만 쓰지 않았다** — `_keepScroll()` 은 git 패널을
   * 훑고, 터미널은 `_keepTermScroll()` 로, 편집기는 `keepView()` 로 갈무리하는데
   * 에이전트 패널이 그 셋 어디에도 없었다. 이름과 판정 문장을 편집기의 것과 같게
   * 둔다 (FR-VSR-2) — 새 관용구를 만들면 두 벌이 되고, 두 벌은 한쪽만 고쳐진다.
   *
   * **떼기 전에** 불려야 한다. 계기는 render 머리의 `_keepScroll()` 하나이며, 떼는
   * 자리 셋(`_hideOthers`·`_domGC`·`_place`)보다 앞선 유일한 시점이다.
   */
  keepView(){
    if(!this.el.isConnected||!this.el.classList.contains('vis')) return;
    this._logY=this.log.scrollTop;
  }

  /**
   * FR-M11-17: 적어 둔 자리를 되돌린다. **붙은 뒤에** 불린다.
   *
   * 적어 둔 것이 없으면 아무것도 하지 않는다 — 처음 열린 패널이 스스로 잡은 자리를
   * 덮지 않는다 (편집기의 `restoreView` 와 같은 근거).
   */
  restoreView(){
    if(typeof this._logY!=='number') return;
    this.log.scrollTop=this._logY;
  }

  _line(cls,text){
    const d=document.createElement('div'); d.className='agp-line '+cls; d.textContent=text; this.log.appendChild(d); return d;
  }
  _msg(cls,text){
    const d=document.createElement('div'); d.className='agp-msg '+cls;
    const who=document.createElement('div'); who.className='agp-who'; who.textContent=cls==='agp-user'?t('agent.user_label'):this.name;
    who.appendChild(this._mkRawToggle(d));
    const body=this._mkBody(text);
    d.appendChild(who); d.appendChild(body); this.log.appendChild(d); return d;
  }

  /**
   * FR-M11-23 (M11-B21): **출력은 md 로 그린다.**
   *
   * 접수: *"출력그 그냥 줄글로 나오는데 md 에 맞춰서 보여주면 좋겠다. 출력이 주로
   * md 다."* 원본도 md 를 **렌더한다** — 표를 박스 드로잉으로 그린다 (§2.10 (8)).
   *
   * **손을 새로 만들지 않는다.** `doc-render.js` 가 이미 `markdown-it` 을 세우고
   * `DOMPurify` 훅을 걸어 두었다 (FR-DRV-13b·20). 여기 오는 문자열은 **에이전트가
   * 준 것**이므로 정화를 지나지 않는 경로를 만들지 않는다.
   *
   * 원문은 `dataset.raw` 에 남는다 — 토글이 그것을 되돌린다.
   */
  _mkBody(text){
    const body=document.createElement('div'); body.className='agp-body';
    this._paintBody(body,text||'');
    return body;
  }

  _paintBody(body,text){
    body.dataset.raw=text;
    const raw=body.closest('.agp-msg')&&body.closest('.agp-msg').dataset.raw==='1';
    if(raw||!text||typeof docRenderLibsReady!=='function'||!docRenderLibsReady()){
      body.textContent=text; return
    }
    docPurifyHook();
    let html='';
    // 흐름 제어에 try/catch 를 쓰지 않는다 — 여기 catch 는 **라이브러리의 실패**를
    // 받는 자리이고, 그때는 원문을 그대로 보이는 것이 맞다.
    try{ html=DOMPurify.sanitize(docMarkdown().render(text),{ADD_ATTR:['target']}) }
    catch(e){ body.textContent=text; return }
    body.innerHTML=html;
  }

  /**
   * FR-M11-23: **원문 토글.** md 가 아닌 출력(로그·표·ASCII 아트)이 왔을 때 되돌릴
   * 길이 없으면 사용자는 깨진 화면만 본다 — 사용자 결정(§2.6b)이 이 짝을 요구했다.
   */
  _mkRawToggle(msgEl){
    const b=document.createElement('button');
    b.className='agp-raw-toggle'; b.type='button';
    b.textContent=t('agent.show_raw'); b.title=t('agent.show_raw');
    b.addEventListener('click',()=>{
      const on=msgEl.dataset.raw==='1';
      msgEl.dataset.raw=on?'':'1';
      b.textContent=on?t('agent.show_raw'):t('agent.show_rendered');
      b.title=b.textContent;
      for(const el of msgEl.querySelectorAll('.agp-body')) this._paintBody(el,el.dataset.raw||'');
    });
    return b;
  }
  _ensureLive(){
    if(this._live) return this._live;
    const d=this._msg('agp-assistant agp-live','');
    this._live=d; return d;
  }
  /**
   * 스트리밍 중에는 **글자를 그대로 잇는다.** 조각마다 md 를 다시 그리면 반쯤 닫힌
   * 문법이 매번 다르게 해석되어 화면이 떨린다. 완성된 모양은 `_message()` 의
   * 스냅샷이 그린다 — 진실은 스냅샷이다.
   */
  _liveText(s){
    const b=this._ensureLive().querySelector('.agp-body');
    b.dataset.raw=(b.dataset.raw||'')+s;
    b.textContent=b.dataset.raw;
  }
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
        d.appendChild(this._mkBody(b.text||'')); hasBody=true;
      }else if(b.type==='tool_use'){
        const card=this._toolCard(b.id,b.name,b.input);
        if(card.parentNode!==d) d.appendChild(card);
      }
    }
    if(!hasBody) d.appendChild(this._mkBody(''));
  }
  /**
   * FR-M11-4: **도구 카드는 접힌 채 선다.**
   *
   *   이전 동작: 입력과 결과가 항상 펼쳐져 화면을 먹는다
   *   새  동작: `details`/`summary` 로 서고 기본이 접힘. 머리에 도구 이름이 남는다
   *   이유:     대화를 읽는 것이 목적이다. `agp-raw` 가 이미 같은 관용구를 쓰므로
   *             새 모양이 아니다 — 오류만 예외로 펼친다 (`_toolResult`)
   */
  _toolCard(useId,tool,input){
    let card=useId?this._toolCards.get(useId):null;
    if(!card){
      card=document.createElement('details'); card.className='agp-tool';
      const h=document.createElement('summary'); h.className='agp-tool-head';
      // 머리는 **제목과 엿보기 둘**로 나뉜다 — 한 덩이로 두면 하나를 고칠 때
      // 다른 하나가 지워진다 (`textContent` 는 자식을 통째로 바꾼다).
      const ttl=document.createElement('span'); ttl.className='agp-tool-title';
      ttl.textContent=this._toolHead(tool,input);
      h.appendChild(ttl);
      card.appendChild(h);
      if(useId) this._toolCards.set(useId,card);
      const host=this._live||this.log; host.appendChild(card);
    }
    if(input&&!card.querySelector('.agp-tool-in')){
      const pre=document.createElement('pre'); pre.className='agp-tool-in ui-scroll'; pre.textContent=agentDetail(tool,input); card.appendChild(pre);
      /**
       * **인자는 늦게 온다.** `content_block_start` 가 빈 `input` 으로 카드를 먼저
       * 세우고, 실제 인자는 그 뒤 스냅샷에 실린다 — 그때 머리를 갱신하지 않으면
       * 도구 이름만 남아 같은 도구가 여러 번 설 때 어느 것이 무엇인지 가릴 수 없다
       * (FR-M11-27).
       */
      const ttl=card.querySelector('.agp-tool-title');
      if(ttl&&tool) ttl.textContent=this._toolHead(tool,input);
    }
    return card;
  }
  /**
   * FR-M11-27 (M11-B25): **머리는 무엇을 했는지 말한다.**
   *
   * 원본은 `Bash(sed -i '' 's/world/WORLD/g' sample.txt && cat …)` 처럼 **인자를 잘라
   * 싣는다** (§2.10 (2)). 도구 이름만 있으면 같은 도구가 여러 번 설 때 어느 것이
   * 무엇인지 가릴 수 없다.
   */
  _toolHead(tool,input){
    const name=t('agent.tool_call',{tool:tool||''});
    const arg=input?String(agentDetail(tool,input)||'').replace(/\s+/g,' ').trim():'';
    if(!arg) return name;
    const cut=arg.length>AGENT_TOOL_HEAD_ARG_MAX
      ? arg.slice(0,AGENT_TOOL_HEAD_ARG_MAX)+'…' : arg;
    return name+' ('+cut+')';
  }

  /**
   * FR-M11-27 (M11-B25): **접힌 채로도 무엇인지 보인다.**
   *
   * 접수: *"접히는 출력에서 요약정도(앞뒤 일부를 보이거나하는등)은 해줘라 뭔지는
   * 알아야지. n 줄 이내면 그냥 출력해도좋다."* 사용자 결정(§2.6b)이 그 수를 정했다 —
   * **5줄 이내는 그대로, 넘으면 앞뒤 2줄씩**.
   *
   * **끝줄을 함께 보이는 것이 요점이다.** 도구 출력은 결론이 끝에 있는 경우가 많아
   * 앞만 보이면 성패를 모른다.
   */
  _peekText(text){
    const lines=String(text||'').replace(/\s+$/,'').split('\n');
    if(lines.length<=AGENT_PEEK_FULL_LINES) return lines.join('\n');
    const n=AGENT_PEEK_EDGE_LINES;
    const head=lines.slice(0,n), tail=lines.slice(-n);
    const hidden=lines.length-n*2;
    return head.join('\n')+'\n'+t('agent.peek_more',{n:hidden})+'\n'+tail.join('\n');
  }

  _toolResult(useId,text,isErr){
    const card=this._toolCard(useId,'',null);
    const h=document.createElement('div'); h.className='agp-tool-res-head'+(isErr?' agp-err':''); h.textContent=isErr?t('agent.tool_result_error'):t('agent.tool_result');
    const pre=document.createElement('pre'); pre.className='agp-tool-res ui-scroll'; pre.textContent=text;
    card.appendChild(h); card.appendChild(pre);
    /**
     * FR-M11-27: 접힌 채로 보이는 엿보기. **`summary` 안에 산다** — `details` 는
     * 닫히면 `summary` 밖의 자식을 숨기므로, 카드에 그냥 붙이면 접힌 상태에서
     * 보이지 않는다 (그것이 이 검사가 처음 잡은 것이다). 펼치면 CSS 가 물린다.
     */
    const head=card.querySelector('.agp-tool-head');
    let peek=head&&head.querySelector('.agp-tool-peek');
    if(head&&!peek){ peek=document.createElement('span'); peek.className='agp-tool-peek'; head.appendChild(peek) }
    if(peek) peek.textContent=this._peekText(text);
    // FR-M11-4: **오류는 펼친 채 선다.** 읽으라고 있는 것을 접으면 접수한 증상이
    // 그대로 돌아온다 — 무엇이 잘못됐는지 한 번 더 눌러야 보인다.
    if(isErr) card.open=true;
    card.dataset.res=isErr?'err':'ok';
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
  /**
   * FR-M11-22 (M11-B20): **좌우 이동은 터미널과 같은 손이다.**
   *
   * 접수는 *"ctrl + 좌우화살표"* 로 왔고 **사용자가 `cmd` 로 정정했다.** 같은 화면의
   * 두 입력이 다른 손을 쓰면 그 자체가 결함이므로, `term-pane.js` 가 세운 규약을
   * 그대로 쓴다 — `Cmd+좌우`는 줄 처음·끝, `Alt+좌우`는 단어 이동이다.
   *
   * macOS 의 `Ctrl+좌우` 는 **OS 가 가져간다** — 붙여도 서지 않으므로 두지 않는다.
   *
   * 브라우저가 이것을 스스로 하는 자리도 있으나(플랫폼·엔진마다 다르다) **여기서
   * 정한다**: 터미널과 같은지가 요구이고, 그 답을 환경에 맡길 수 없다.
   */
  _moveCaret(toEnd,byWord){
    const v=this.ta.value, at=this.ta.selectionStart;
    let i;
    if(byWord){
      // **단어의 시작·끝으로 간다.** 사이의 공백을 먼저 건너뛰고 그 단어를 지난다 —
      // 공백까지 삼키면 캐럿이 단어 앞 빈칸에 서고, 그것은 한 칸 모자란 자리다.
      if(toEnd){
        const m=/^\s*\S+/.exec(v.slice(at));
        i=at+(m?m[0].length:0);
      }else{
        const m=/\S+\s*$/.exec(v.slice(0,at));
        i=at-(m?m[0].length:0);
      }
    }else{
      // 줄의 처음·끝 — 여러 줄 입력이므로 **그 줄**이다 (터미널의 Ctrl-A·Ctrl-E 와 같다).
      const nl=toEnd?v.indexOf('\n',at):v.lastIndexOf('\n',at-1);
      i=toEnd?(nl<0?v.length:nl):(nl<0?0:nl+1);
    }
    this.ta.setSelectionRange(i,i);
  }

  /**
   * FR-M11-21 (M11-B19): **입력창은 내용 따라 자라고, 패널의 1/3 에서 멈춘다.**
   *
   * 접수: *"gui 입력창 크기가 고정인데 너무 작다. 탭 크기의 1/3 까지는 커지게 하고
   * 그 이후로 스크롤."* 두 줄 고정으로는 긴 프롬프트의 앞을 볼 수 없고, 상한이
   * 없으면 반대로 대화가 밀려난다 — **사용자가 그 상한을 지정했다.**
   *
   * 재기 전에 `height` 를 비우는 것이 요점이다. 그러지 않으면 `scrollHeight` 가
   * **지금 높이에 갇혀** 줄을 지워도 줄어들지 않는다.
   */
  _growInput(){
    const el=this.ta;
    if(!el.isConnected) return;
    const cap=Math.max(0,Math.round(this.el.clientHeight*AGENT_INPUT_MAX_RATIO));
    el.style.height='auto';
    const want=el.scrollHeight;
    const h=cap?Math.min(want,cap):want;
    el.style.height=h+'px';
    // 상한에 닿았을 때만 스크롤이 선다 — 그 전에는 내용이 전부 보인다.
    el.style.overflowY=(cap&&want>cap)?'auto':'hidden';
  }

  _onKey(e){
    if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){ e.preventDefault(); this.send(); return }
    // FR-M11-22: 터미널과 같은 규약. 수식키 조합이 겹치지 않게 **하나만** 눌린 것을 본다.
    if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&!e.shiftKey){
      const toEnd=e.key==='ArrowRight';
      if(e.metaKey&&!e.ctrlKey&&!e.altKey){ e.preventDefault(); this._moveCaret(toEnd,false); return }
      if(e.altKey&&!e.ctrlKey&&!e.metaKey){ e.preventDefault(); this._moveCaret(toEnd,true); return }
    }
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
  /**
   * M9_SRS FR-M9-45 (M9-B26): **`/` 명령은 이름만이 아니다.**
   *
   * 접수한 말: *"단순 스킬이 아닌 / 명령어들의 경우 컨트롤 할 수 없다 …
   * (config, model 등의 명령어)"*.
   *
   *   이전 동작: 이름만 보였다 — `/config` 하나. 무엇을 넣어야 하는지 알 길이 없다
   *   새  동작: **인자 문법과 한 줄 설명**을 함께 보인다 (`/config key=value`)
   *   이유:     못 하는 것은 명령을 **보내는** 일이 아니라 **무엇을 보낼지 아는**
   *             일이다. 그 답은 프로토콜이 이미 보내는데 우리가 버리고 있었다
   *
   * 인자를 받지 않는 명령은 **그 자리를 비운다** — 빈 힌트를 `<args>` 로 채우면
   * 없는 문법을 지어내는 것이다 (FR-CBG-5). 힌트가 없으면 고른 뒤 공백도 붙이지
   * 않는다: 인자가 없는 명령 뒤의 공백은 사용자가 지워야 할 것이다.
   */
  _suggest(){
    const v=this.ta.value;
    const cmds=(this.state&&this.state.status&&this.state.status.commands)||[];
    if(!v.startsWith('/')||v.includes(' ')||v.includes('\n')||!cmds.length){ this.sugg.hidden=true; this.sugg.textContent=''; return }
    const q=v.slice(1).toLowerCase();
    const hits=cmds.filter(c=>c&&c.name&&c.name.toLowerCase().startsWith(q)).slice(0,8);
    this.sugg.textContent='';
    if(!hits.length||(hits.length===1&&hits[0].name===q&&!hits[0].argumentHint)){ this.sugg.hidden=true; return }
    for(const c of hits){
      const b=document.createElement('button'); b.type='button'; b.className='ui-btn ui-btn-sm ui-btn-ghost agp-sugg-item';
      const nm=document.createElement('span'); nm.className='agp-sugg-name'; nm.textContent='/'+c.name; b.appendChild(nm);
      if(c.argumentHint){ const h=document.createElement('span'); h.className='agp-sugg-hint'; h.textContent=c.argumentHint; b.appendChild(h) }
      if(c.description){ b.title=c.description }
      b.addEventListener('click',()=>{ this.ta.value='/'+c.name+(c.argumentHint?' ':''); this.sugg.hidden=true; this.ta.focus() });
      this.sugg.appendChild(b);
    }
    this.sugg.hidden=false;
  }
  async send(){
    const text=this.ta.value.trim();
    if(!text||this._ended||!this._canControl()) return;
    this.ta.value=''; this.sugg.hidden=true; this._histIdx=-1; this._growInput();
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
      const pre=document.createElement('pre'); pre.className='agp-appr-in ui-scroll'; pre.textContent=agentDetail(req.tool,req.input); body.appendChild(pre);
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
