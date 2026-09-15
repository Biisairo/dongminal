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
    this._live=null;      // 진행 중 턴의 말 컨테이너 (FR-M11-24)
    this._liveBody=null;  // 그 안에서 지금 열린 말 블록
    this._think=null;     // 지금 열린 추론 (FR-M11-28)
    this._toolCards=new Map(); // toolUseId → 카드
    this._dialog=null;    // 열린 승인 다이얼로그 {id, close}
    this._history=[]; this._histIdx=-1; this._draft='';
    this._queue=[];       // 턴 중에 쌓인 프롬프트 (FR-M11-29 · D-M11-6 — 화면의 것이다)
    this._atts=[];        // 붙여넣은 이미지 (FR-M11-30)
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
    /**
     * FR-M11-42: **클릭한 자리가 포커스를 받아야 키가 패널을 지난다.**
     *
     * `div` 는 기본적으로 포커스를 받지 못한다 — 대화를 클릭하면 포커스가 `body` 에
     * 남고, 그러면 `Esc` 의 이벤트 경로에 이 패널이 **아예 들어오지 않는다** (실측:
     * 핸들러를 패널에 걸고도 요청이 0건이었다).
     *
     * `tabindex="-1"` 은 **탭 순회에 넣지 않으면서** 클릭·프로그램 포커스만 받게 한다.
     * 스크롤 영역이 포커스를 받는 것은 키보드 접근성 쪽에서도 권장되는 모양이다.
     */
    this.log.tabIndex=-1;
    /**
     * FR-M11-39 (M11-B39): **바닥으로 돌아가는 손.**
     *
     * 스크롤이 자동으로 끌려가지 않는 것이 `FR-M11-26` 의 요구인데, 그러면 긴 대화에서
     * 내려오는 품이 곧 다음 접수가 된다. **바닥이 아닐 때만** 서고 누르면 내려간다 —
     * 늘 떠 있으면 그것이 대화를 가린다.
     *
     * 대화 위에 뜨므로 감싸는 자리가 하나 필요하다.
     */
    const logWrap=document.createElement('div'); logWrap.className='agp-log-wrap';
    logWrap.appendChild(this.log);
    this.botBtn=UIKit.button({icon:'chevron-down',title:t('agent.to_bottom'),kind:'ghost',size:'sm',
      cls:'agp-to-bottom',onClick:()=>this._scrollEnd()});
    this.botBtn.hidden=true;
    logWrap.appendChild(this.botBtn);
    this.log.addEventListener('scroll',()=>this._syncBottomBtn());
    el.appendChild(logWrap);

    // 입력
    const inp=document.createElement('div'); inp.className='agp-input';
    /**
     * FR-M11-29 (M11-B27 · B15 · B35): **쌓인 프롬프트는 보인다.**
     *
     * 원본은 대기 중인 것을 입력창 **위에** `❯ <본문>` 으로 줄줄이 세운다
     * (§2.10 (5) 실측) — 무엇이 기다리는지 화면이 언제나 말한다. 자리가 여기인 것도
     * 원본 그대로다: 다음에 나갈 것들이 입력창에 잇닿아 선다.
     */
    this.queueEl=document.createElement('div'); this.queueEl.className='agp-queue'; this.queueEl.hidden=true;
    this.queueEl.setAttribute('role','list'); this.queueEl.setAttribute('aria-label',t('agent.queue_label'));
    inp.appendChild(this.queueEl);
    this.sugg=document.createElement('div'); this.sugg.className='agp-sugg'; this.sugg.hidden=true;
    inp.appendChild(this.sugg);
    const row=document.createElement('div'); row.className='agp-input-row';
    this.ta=document.createElement('textarea'); this.ta.className='agp-ta ui-scroll'; this.ta.rows=2;
    this.ta.placeholder=t('agent.prompt_placeholder'); this.ta.setAttribute('aria-label',t('agent.input_label'));
    this.ta.addEventListener('keydown',e=>this._onKey(e));
    /**
     * FR-M11-42 (M11-B42 · B47): **끊는 키는 패널 전체에서 산다.**
     *
     * 접수: *"뭔가 특정 동작을 하는중에 interrupt 가 안되는거같아"* · *"esc는 포커스하면
     * 걸리게"*. 실측(§2.12)이 갈랐다 — 동작의 종류가 아니라 **포커스**였다: 핸들러가
     * `this.ta` 하나에만 걸려 있어 도구가 도는 동안 대화를 클릭하면 그때부터 키가
     * 닿지 않는다.
     *
     * **글자를 만지는 키는 옮기지 않는다** (좌우 이동·이력·자동완성). 끊기는 *지금 도는
     * 것*에 대한 명령이라 입력창의 상태와 무관하고, 캐럿을 옮기는 키는 캐럿이 있는
     * 곳의 일이다 — 둘을 한 자리에 두었던 것이 결함이다.
     */
    el.addEventListener('keydown',e=>this._onPaneKey(e));
    this.ta.addEventListener('input',()=>{ this._suggest(); this._growInput() });
    // FR-M11-30 (M11-B28): 원본과 같은 손 — 붙여넣기다 (§2.10 (6)).
    this.ta.addEventListener('paste',e=>this._onPaste(e));
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
    // 따라가지 않았으면 바닥에서 멀어진 것이다 — 돌아갈 손이 그때 선다 (FR-M11-39).
    else this._syncBottomBtn();
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
    /**
     * FR-M11-49 (M11-B49): **남의 것은 남의 자리에 그린다.**
     *
     * 서브에이전트의 진행은 같은 스트림으로 오고 `parentToolUseId` 가 그것을 가른다
     * (실측 §2.13). 그대로 두면 서브에이전트의 프롬프트가 **사용자가 친 말**로 서고
     * 그 도구가 **부모의 도구**로 선다 — `FR-M11-25`(자기가 하지 않은 말을 자기
     * 기록에서 읽는다)와 같은 부류다.
     *
     * 사용자 결정(2026-09-15): **부모 도구 카드 안에 넣는다.**
     */
    if(ev.parentToolUseId){ this._applySub(ev.parentToolUseId,ev,replay); return }
    // 휴면·오류 뒤에 라이브로 exit 아닌 이벤트가 오면 재개된 것이다 (다른 브라우저가 재개했을 때).
    if(!replay&&this._dormant&&ev.kind!=='exit') this._revive();
    switch(ev.kind){
      case 'session': this._setState('idle'); this._mergeStatus(ev.status); this._sessionLine(ev.sessionId); break;
      case 'user': {
        this._endLive();
        const m=this._msg('agp-user',ev.text||'');
        // FR-M11-40: 고르는 화면이 서면 이 말풍선은 지운다 — 무엇을 지울지는 여기서
        // 잡아 두고, **폼이 실제로 열린 뒤** 그때 지운다.
        if(this._awaitConfig&&AGENT_CONFIG_CMD_RE.test(ev.text||'')) this._cfgEcho=m;
        this._pushHistory(ev.text||'');
        break;
      }
      case 'turn_start': this._setState('working'); break;
      case 'turn_end': this._endLive(); this._setState('done'); if(!replay) this._drainQueue(); if(ev.isError) this._line('agp-note agp-err', ev.text==='aborted_streaming'?t('agent.turn_aborted'):t('agent.turn_error',{reason:ev.text||''})); break;
      case 'text_delta': this._liveText(ev.text||''); break;
      case 'thinking_delta': this._liveThinking(ev.text||'',ev.thinkingTokens||0,!replay); break;
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

  /**
   * FR-M11-49: 서브에이전트 한 묶음. 부모 도구 카드 안에 자기 자리를 갖는다.
   *
   * **본 대화의 렌더를 다시 쓰지 않는다** — 여기 오는 것은 진행 요약이고, 자세한
   * 것은 그 카드를 펼쳐 본다. 말·도구·결과를 줄로 적되 부모의 상태(`_setState`)·
   * 사용량·큐는 **건드리지 않는다**: 그것들은 본 대화의 것이다.
   */
  _subOf(pid){
    if(!this._subs) this._subs=new Map();
    let sub=this._subs.get(pid);
    if(sub) return sub;
    // 부모 카드가 아직 없으면 세운다 — 도구 시작보다 자식이 먼저 오는 판이 있다.
    const card=this._toolCard(pid,'',null);
    const box=document.createElement('div'); box.className='agp-sub';
    const head=document.createElement('div'); head.className='agp-sub-head';
    head.textContent=t('agent.sub_head');
    const body=document.createElement('div'); body.className='agp-sub-body ui-scroll';
    box.appendChild(head); box.appendChild(body); card.appendChild(box);
    sub={card,box,head,body,tools:0,live:null};
    this._subs.set(pid,sub);
    return sub;
  }
  _subLine(sub,cls,text){
    const d=document.createElement('div'); d.className='agp-sub-line '+cls; d.textContent=text;
    sub.body.appendChild(d); return d;
  }
  _applySub(pid,ev,replay){
    const sub=this._subOf(pid);
    switch(ev.kind){
      case 'user':
        // 서브에이전트가 **받은** 프롬프트다 — 사용자가 친 말이 아니다.
        if(ev.text) this._subLine(sub,'agp-sub-prompt',ev.text);
        break;
      case 'text_delta':
        if(!sub.live) sub.live=this._subLine(sub,'agp-sub-text','');
        sub.live.textContent+=ev.text||'';
        break;
      case 'message': sub.live=null; break;
      case 'tool_start':
        sub.tools++;
        this._subLine(sub,'agp-sub-tool',this._toolHead(ev.tool,null));
        break;
      case 'tool_end':
        sub.live=null;
        if(ev.isError) this._subLine(sub,'agp-sub-err',this._peekText(ev.text||''));
        break;
      case 'error':
        this._subLine(sub,'agp-sub-err',ev.text||'');
        break;
    }
    sub.head.textContent=t('agent.sub_head_n',{n:sub.tools});
    if(!replay&&this._atBottom()) this._scrollEnd();
  }

  // ── 상태 줄 ──

  _setState(st){
    const was=this._activity;
    this._activity=st;
    const key={idle:'agent.state_idle',working:'agent.state_working',waiting:'agent.state_waiting',done:'agent.state_done',ended:'agent.state_ended',hibernated:'agent.state_hibernated',error:'agent.state_error'}[st];
    this.stateEl.textContent=key?t(key):'';
    this.stateEl.dataset.state=st||'';
    this.el.dataset.state=st||'';
    this._syncBusy(was,st);
  }

  /**
   * FR-M11-51 (M11-B52): **도는 중이면 화면이 움직인다.**
   *
   * 접수: *"지금이 idel, waiting 이 아니고 뭔가를 하고있을 떄 tui 에서는 애니메이션이
   * 있잖아. 그런거."* 원본은 `✢ Tinkering… 60` · `✶ Tempering… (38s · ↓ 1.4k tokens)`
   * 으로 **스피너 · 경과 · 받은 토큰**을 함께 돌린다 (§2.10 (4)·(5)).
   *
   * **모양은 옮기지 않는다** (사용자 결정 2026-09-15 — *"모양을 또같이 할 필요는
   * 없다"*). 원본의 무작위 동사(`Baked`·`Brewed`…)는 claude 가 가진 사전이고 우리에겐
   * 없다 — 지어내면 카탈로그 밖의 글자가 된다. 우리가 **아는 것**은 경과 시간이며
   * 그것은 관측한 값이다.
   *
   * 도는 자리는 `working` 하나다 — `waiting` 은 **사람을 기다리는** 것이라 움직이면
   * 거짓이 된다 (접수가 그 둘을 이름으로 갈랐다).
   */
  _syncBusy(was,st){
    const busy=st==='working';
    if(busy===(was==='working')&&this._busyJob) return;
    if(this._busyJob){ this._busyJob.stop(); this._busyJob=null }
    if(!busy){
      // 끝났으면 **그 턴이 얼마였는지** 남긴다 — 원본의 `Brewed for 14s` 자리다.
      if(was==='working'&&this._busyAt&&st==='done'){
        this._line('agp-note agp-took',t('agent.turn_took',{secs:((Date.now()-this._busyAt)/1000).toFixed(1)}));
      }
      this._busyAt=0;
      this.el.dataset.busy='';
      return;
    }
    this._busyAt=Date.now();
    this.el.dataset.busy='1';
    this._paintBusy();
    this._busyJob=TIMERS.every({id:'agp-busy:'+this.id,owner:this,every:AGENT_BUSY_TICK_MS,
      when:()=>!this._destroyed&&this._activity==='working',
      run:()=>this._paintBusy()});
  }
  /** 경과를 적는다. 스피너는 CSS 가 돌린다 — 프레임마다 DOM 을 만지지 않는다. */
  _paintBusy(){
    if(!this._busyAt) return;
    this.stateEl.textContent=t('agent.state_working_for',
      {secs:Math.round((Date.now()-this._busyAt)/1000)});
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

  _scrollEnd(){ this.log.scrollTop=this.log.scrollHeight; this._syncBottomBtn() }

  /**
   * FR-M11-39: 바닥 버튼은 **바닥이 아닐 때만** 선다. 판정은 `_atBottom()` 하나를
   * 쓴다 — 따라갈지 말지를 정하는 그 판정과 같아야 버튼이 "따라가지 않는 중" 을
   * 정확히 가리킨다 (두 벌로 두면 한쪽만 고쳐진다).
   */
  _syncBottomBtn(){
    if(!this.botBtn) return;
    this.botBtn.hidden=this._atBottom();
  }

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
  /**
   * FR-M11-47 (M11-B48): **대화를 열면 바로 칠 수 있다.**
   *
   * 이름이 터미널의 것과 같다 (`TerminalTool.focus`) — 부르는 자리가 하나이므로
   * 그쪽이 종류를 묻지 않아도 된다.
   */
  focus(){
    if(this.ta&&!this.ta.disabled) this.ta.focus();
  }

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
  /**
   * FR-M11-24 (M11-B22): **턴의 말은 한 컨테이너에 서고, 블록은 그 안에서 갈린다.**
   *
   * 종전에는 `_msg()` 를 불러 **빈 본문 하나**를 미리 만들었다. 그러면 블록이 둘인
   * 턴에서 첫 블록이 그 자리를 차지하고 둘째가 갈 곳이 없어, `_message()` 가 매번
   * 안을 **지우고 다시 그리는** 손을 쓰게 된다 — 그 손이 이 물결의 결함 둘(B22·B26)의
   * 뿌리다. 여기서는 머리만 세우고 본문은 **블록이 올 때** 만든다.
   */
  _ensureLive(){
    if(this._live) return this._live;
    const d=document.createElement('div'); d.className='agp-msg agp-assistant agp-live';
    const who=document.createElement('div'); who.className='agp-who'; who.textContent=this.name;
    who.appendChild(this._mkRawToggle(d));
    d.appendChild(who); this.log.appendChild(d);
    this._live=d; return d;
  }
  /** 지금 열린 말 블록의 자리. 없으면 새로 세운다 — 블록 하나가 요소 하나다. */
  _liveBodyEl(){
    if(this._liveBody) return this._liveBody;
    const b=this._mkBody('');
    this._ensureLive().appendChild(b);
    this._liveBody=b; return b;
  }
  /**
   * 스트리밍 중에는 **글자를 그대로 잇는다.** 조각마다 md 를 다시 그리면 반쯤 닫힌
   * 문법이 매번 다르게 해석되어 화면이 떨린다. 완성된 모양은 `_message()` 의
   * 스냅샷이 그린다 — 진실은 스냅샷이다.
   */
  _liveText(s){
    const b=this._liveBodyEl();
    b.dataset.raw=(b.dataset.raw||'')+s;
    b.textContent=b.dataset.raw;
  }
  /**
   * FR-M11-24: 말 블록을 **최종본으로 확정하고 닫는다.** 다음 블록은 새 요소다.
   * 컨테이너는 닫지 않는다 — 한 턴의 말들이 이름 머리 하나를 함께 쓴다.
   */
  _endText(text){
    const b=this._liveBodyEl();
    this._paintBody(b,text);
    this._liveBody=null;
    // FR-M11-14: `/config` 의 답이 왔다 — 그 목록이 폼이 된다. 모양이 아니면 그대로 둔다.
    if(this._awaitConfig){
      this._awaitConfig=false;
      // FR-M11-40: **연 뒤에** 감춘다 — 열지 못했으면 둘 다 그대로 선다.
      if(this._openConfigPick(text)){
        this._hideCommandEcho(this._cfgEcho); this._cfgEcho=null;
        if(this._live) this._hideCommandEcho(this._live);
        this._live=null; this._liveBody=null;
      }
    }
  }

  /**
   * FR-M11-28 (M11-B26): **추론은 주는 만큼 보인다.**
   *
   * **claude 는 내용을 주지 않는다** (실측 §2.11 (1) — `thinking` 이 빈 문자열이고
   * `estimated_tokens` 만 움직인다). 원본이 `thought for 2s` 로 시간만 말하는 것이
   * 그 때문이다. `codex`·`omp` 는 글자를 주므로 그때는 그것을 접어 둔다.
   *
   * 요소의 종류가 **내용 유무로 갈린다**: 있으면 펼칠 수 있는 `details`, 없으면
   * 한 줄 쪽지다. 빈 `details` 를 세우면 눌러도 아무것도 없어 고장으로 읽힌다.
   */
  _liveThinking(s,tokens,live){
    const host=this._ensureLive();
    /**
     * **재생에는 시간이 없다** (FR-CBG-5). 우리가 재는 값은 *그 추론이 실제로 걸린
     * 시간* 인데, 재생은 지난 이벤트를 순식간에 흘리므로 여기서 재면 `0.0초` 가
     * 나온다 — 그것은 모름이 아니라 **거짓**이다. 그래서 재생이면 아예 달지 않는다.
     */
    if(!this._think) this._think={at:live===false?null:Date.now(),tokens:0,text:'',el:null,kind:''};
    const th=this._think;
    th.tokens+=Number(tokens)||0;
    if(s) th.text+=s;
    this._paintThink(host);
  }
  _paintThink(host){
    const th=this._think; if(!th) return;
    const kind=th.text?'body':'note';
    if(th.kind!==kind){
      let el;
      if(kind==='body'){
        el=document.createElement('details'); el.className='agp-think';
        const sum=document.createElement('summary'); sum.textContent=t('agent.thinking'); el.appendChild(sum);
        const b=document.createElement('div'); b.className='agp-think-body'; el.appendChild(b);
      }else{
        el=document.createElement('div'); el.className='agp-think agp-think-note';
      }
      if(th.el) th.el.replaceWith(el); else host.appendChild(el);
      th.el=el; th.kind=kind;
    }
    if(kind==='body') th.el.querySelector('.agp-think-body').textContent=th.text;
    else th.el.textContent=this._thinkNote(th);
  }
  /**
   * 내용이 없을 때 적는 한 줄. **시간은 끝난 뒤에만 적는다** — 원본의 `thought for 2s`
   * 도 끝난 뒤의 값이고, 도는 중에 초를 세려면 타이머가 하나 더 필요하다.
   */
  _thinkNote(th){
    const tk=th.tokens?fmtTokens(th.tokens):'';
    if(!th.done) return tk?t('agent.thinking_progress_tokens',{tokens:tk}):t('agent.thinking_progress');
    // 시간을 재지 못한 것(재생)은 **적지 않는다** — 토큰은 프로토콜이 준 값이라 남는다.
    if(th.at===null) return tk?t('agent.thinking_done_tokens',{tokens:tk}):t('agent.thinking_done');
    const secs=((Date.now()-th.at)/1000).toFixed(1);
    return tk?t('agent.thinking_note_tokens',{secs,tokens:tk}):t('agent.thinking_note',{secs});
  }
  /** 추론 블록을 닫는다 — 시간이 그때 고정된다. */
  _endThink(){
    const th=this._think; if(!th) return;
    th.done=true; this._paintThink(this._live||this.log);
    this._think=null;
  }
  _endLive(){
    this._endThink();
    if(this._live) this._live.classList.remove('agp-live');
    this._live=null; this._liveBody=null;
  }

  /**
   * 에이전트 메시지 스냅샷 — 블록 하나가 **끝났다**는 신호다 (실측 §2.11 (2): 한
   * 프레임이 한 블록이고 블록이 닫힐 때 온다).
   *
   * FR-M11-24 (M11-B22): **지우지 않는다.**
   *
   *   이전 동작: `who` 만 남기고 **전부 지운 뒤** 스냅샷으로 다시 그렸다. 프레임이
   *              블록마다 오므로 **앞 블록이 매번 사라졌고**, 빈 `thinking` 스냅샷은
   *              세워 둔 추론 칸까지 지웠다 (M11-B26 이 안 보이던 까닭)
   *   새  동작: 그 블록만 **확정하고 닫는다**. 앞에 선 것은 그대로 산다
   *   이유:     경계는 프로토콜이 이미 주고 있었고 (§2.11 (2)) 우리가 지우고 있었다.
   *             원본이 `⏺` 를 찍는 자리가 정확히 이 경계다
   */
  _message(raw){
    // 와이어에서는 JSON 배열 그대로 온다(RawMessage 인라인). 문자열이면 파싱한다.
    let blocks=raw;
    if(typeof raw==='string'){ try{ blocks=JSON.parse(raw||'[]') }catch{ blocks=[] } }
    if(!Array.isArray(blocks)) return;
    const d=this._ensureLive();
    for(const b of blocks){
      if(!b||typeof b!=='object') continue;
      if(b.type==='thinking'){
        // 스냅샷의 `thinking` 은 claude 에서 **비어 있다** — 그것으로 덮지 않는다.
        if(b.thinking&&(!this._think||!this._think.text)) this._liveThinking(b.thinking,0);
        this._endThink();
      }else if(b.type==='text'){
        this._endText(b.text||'');
      }else if(b.type==='tool_use'){
        const card=this._toolCard(b.id,b.name,b.input);
        if(card.parentNode!==d) d.appendChild(card);
      }
    }
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
      // FR-M11-37 (M11-B36): 편집이면 **그 자리에** 무엇이 바뀌었는지 그린다.
      const diff=this._mkDiff(tool,input);
      if(diff){
        card.appendChild(diff);
        /**
         * FR-M11-38 (M11-B37): **diff 는 펼친 채 선다.**
         *
         * `FR-M11-4` 가 도구를 접는 근거는 *출력이 화면을 먹는다* 인데, diff 는
         * 출력이 아니라 **그 턴이 한 일 그 자체**다. 오류를 펼쳐 두는 것과 같은
         * 근거다 — 읽으라고 있는 것을 접으면 접수한 증상이 돌아온다.
         *
         * 펼치는 것은 **편집 도구뿐**이다: `Bash` 의 긴 출력까지 펼치면
         * `FR-M11-27` 이 접기로 푼 문제가 되살아난다.
         */
        card.open=true;
      }
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
    /**
     * FR-M11-50 (M11-B50): **백그라운드는 머리에서 말한다.**
     *
     * 실측(§2.13): `run_in_background:true` 는 **평범한 도구 호출**이고 프로토콜이
     * 진행을 따로 알려 주지 않는다 — 결과가 *"Command running in background with ID:
     * …"* 라는 **글**로 온다. 그러니 우리가 아는 것은 *백그라운드로 돌렸다* 는 사실
     * 하나이고, 그것은 **입력에 이미 있는 값**이라 지어내는 것이 없다.
     *
     * 원본도 하단에 `1 shell` 로 그 수를 적는다 (§2.13 의 화면).
     */
    const bg=this._isBackground(input)?t('agent.tool_bg'):'';
    const arg=input?String(agentDetail(tool,input)||'').replace(/\s+/g,' ').trim():'';
    if(!arg) return name+bg;
    const cut=arg.length>AGENT_TOOL_HEAD_ARG_MAX
      ? arg.slice(0,AGENT_TOOL_HEAD_ARG_MAX)+'…' : arg;
    return name+' ('+cut+')'+bg;
  }
  /** 입력이 **스스로 말하는** 사실이다 — 추정하지 않는다 (FR-M11-50). */
  _isBackground(input){
    let o=input;
    if(typeof o==='string'){ try{ o=JSON.parse(o) }catch{ return false } }
    return !!(o&&typeof o==='object'&&o.run_in_background===true);
  }

  /**
   * FR-M11-37 (M11-B36): **편집은 그 자리에서 무엇이 바뀌었는지 보인다.**
   *
   * 원본은 별도 창을 열지 않고 도구 결과 그 자리에 `⎿ Updated <파일> (+1 -1)` 과 줄
   * 단위 `±` 를 그린다 (§2.10 (2)).
   *
   * **재료는 결과가 아니라 입력이다** (실측 §2.11 (3)): `tool_result` 는 *"has been
   * updated successfully"* 한 줄뿐이고, 원본이 보이는 diff 는 TUI 가 `tool_use` 의
   * 입력에서 스스로 만든 것이다.
   *
   * **줄번호는 달지 않는다** — 그 값은 파일 내용을 알아야 나오고 프로토콜은 주지
   * 않는다 (D-M11-4 · FR-CBG-5). 아는 도구만 그린다: 모르는 도구의 입력을 diff 로
   * 읽으면 없는 변경을 그리게 된다.
   */
  _mkDiff(tool,input){
    let o=input;
    if(typeof o==='string'){ try{ o=JSON.parse(o) }catch{ return null } }
    if(!o||typeof o!=='object'||typeof o.file_path!=='string') return null;
    let removed=[],added=[];
    if(tool==='Edit'&&typeof o.old_string==='string'&&typeof o.new_string==='string'){
      removed=o.old_string===''?[]:o.old_string.split('\n');
      added=o.new_string===''?[]:o.new_string.split('\n');
    }else if(tool==='Write'&&typeof o.content==='string'){
      // 새로 쓰는 것이므로 지워진 줄이 없다.
      added=o.content===''?[]:o.content.split('\n');
    }else return null;
    const el=document.createElement('div'); el.className='agp-diff';
    const head=document.createElement('div'); head.className='agp-diff-head';
    head.textContent=t('agent.diff_head',{file:o.file_path,added:added.length,removed:removed.length});
    el.appendChild(head);
    const body=document.createElement('pre'); body.className='agp-diff-body ui-scroll';
    for(const [sign,lines] of [['-',removed],['+',added]]){
      for(const line of lines){
        const r=document.createElement('span');
        r.className='agp-diff-line agp-diff-'+(sign==='+'?'add':'del');
        r.textContent=sign+line;
        body.appendChild(r);
      }
    }
    el.appendChild(body);
    return el;
  }

  /**
   * FR-M11-27 (M11-B25): **접힌 채로도 무엇인지 보인다.**
   *
   * 접수: *"접히는 출력에서 요약정도(앞뒤 일부를 보이거나하는등)은 해줘라 뭔지는
   * 알아야지. n 줄 이내면 그냥 출력해도좋다."*
   *
   * **개정 (D-M11-5, 사용자 결정 2026-09-15): 긴 쪽은 한 문장이다.**
   *
   *   이전 동작: 넘으면 **앞 2줄 · 뒤 2줄**과 남은 줄 수
   *   새  동작: 넘으면 **한 문장** — 규모와 펼치는 법만
   *   이유:     원본이 `Searched for 1 pattern (ctrl+o to expand)` 로 그렇게 한다
   *             (§2.10 (3)). 앞뒤 두 줄은 접힌 머리를 **네 줄로 만들어** 접은 뜻을
   *             스스로 없앤다
   *
   * **짧은 쪽은 바뀌지 않는다** — 원본도 세 줄짜리 출력은 그대로 보인다 (§2.10 (2)).
   * 원본의 동사(`Searched for…`)는 옮기지 않는다: 그것은 claude 가 도구마다 문구를
   * 아는 덕이고 우리에겐 그 사전이 없다. 아는 것은 **규모**이므로 그것을 적는다.
   */
  _peekText(text){
    const lines=String(text||'').replace(/\s+$/,'').split('\n');
    if(lines.length<=AGENT_PEEK_FULL_LINES) return lines.join('\n');
    return t('agent.peek_summary',{n:lines.length});
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
    // 답할 곳이 없어진 프롬프트는 쌓아 둘 곳도 없다 — 남기면 다시 살아났을 때
    // 사용자가 잊은 말이 나간다.
    if(this._queue.length){ this._queue.length=0; this._renderQueue() }
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
    // 목록이 떠 있으면 엔터는 **고르는 것**이다 (FR-M11-48) — 아래 갈래보다 먼저 본다.
    if(!this.sugg.hidden&&(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='Tab'||e.key==='Enter')){
      if(e.key==='ArrowDown'){ e.preventDefault(); this._suggMove(1); return }
      if(e.key==='ArrowUp'){ e.preventDefault(); this._suggMove(-1); return }
      const b=this._suggCur();
      /**
       * **이미 다 친 명령이면 엔터는 보내기다.**
       *
       * 그러지 않으면 `/model` 을 다 치고 엔터를 눌렀을 때 목록이 그것을 *고르고*
       * (입력은 그대로), 다시 눌러야 나간다 — 같은 손짓을 두 번 요구하는 것은
       * 접수한 편의의 반대다. 인자를 받는 명령은 목록이 남아 있으므로 이 갈래가
       * 없으면 언제나 두 번이 된다.
       */
      const nm=b&&b.querySelector('.agp-sugg-name');
      if(nm&&nm.textContent===this.ta.value.trim()){ this._suggClose() }
      else if(b){ e.preventDefault(); b.click(); return }
    }
    if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){ e.preventDefault(); this.send(); return }
    // FR-M11-22: 터미널과 같은 규약. 수식키 조합이 겹치지 않게 **하나만** 눌린 것을 본다.
    if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&!e.shiftKey){
      const toEnd=e.key==='ArrowRight';
      if(e.metaKey&&!e.ctrlKey&&!e.altKey){ e.preventDefault(); this._moveCaret(toEnd,false); return }
      if(e.altKey&&!e.ctrlKey&&!e.metaKey){ e.preventDefault(); this._moveCaret(toEnd,true); return }
    }
    /**
     * FR-M11-48: **드롭다운이 열려 있으면 그쪽이 먼저다.** `↑↓` 는 이력이 아니라
     * 목록을 훑고, `Enter`·`Tab` 이 고른 것을 넣는다 — 목록이 떠 있는 동안 엔터가
     * 프롬프트를 보내면 고르던 손이 문장을 날린다.
     */
    if(!this.sugg.hidden){
      if(e.key==='ArrowDown'){ e.preventDefault(); this._suggMove(1); return }
      if(e.key==='ArrowUp'){ e.preventDefault(); this._suggMove(-1); return }
      if(e.key==='Tab'||e.key==='Enter'){
        const b=this._suggCur();
        if(b){ e.preventDefault(); b.click(); return }
      }
    }
    const atEdge=this.ta.selectionStart===this.ta.selectionEnd;
    if(e.key==='ArrowUp'&&atEdge&&!this.ta.value.slice(0,this.ta.selectionStart).includes('\n')){
      /**
       * FR-M11-29: **큐가 있으면 큐를 먼저 꺼낸다.** 원본의 입력창이 그 자리에서
       * *"Press up to edit queued messages"* 라고 말하므로, 같은 키에 두 벌의 손을
       * 만들지 않고 **큐 → 이력** 순으로 본다. 꺼낸 것은 큐에서 빠지므로 그대로
       * 두면 취소이고, 고쳐 보내면 수정이다.
       */
      if(this._queuePop()){ e.preventDefault(); return }
      if(this._histMove(-1)) e.preventDefault();
      return;
    }
    if(e.key==='ArrowDown'&&atEdge&&!this.ta.value.slice(this.ta.selectionEnd).includes('\n')){ if(this._histMove(1)) e.preventDefault(); return }
  }
  /** 큐의 **마지막**을 입력창으로 꺼낸다 — 쌓인 순서의 역순이 고치는 순서다. */
  _queuePop(){
    if(!this._queue.length||this.ta.value) return false;
    const item=this._queue.pop();
    this.ta.value=item.text;
    /**
     * 첨부도 함께 돌아온다 — 글만 돌려주면 다시 보낼 때 그림이 빠진다.
     *
     * **이어 붙이지 않고 갈아 끼운다.** 표식(`[Image #n]`)의 n 은 목록의 자리를
     * 가리키므로, 남아 있던 것 뒤에 붙이면 꺼낸 글의 `#1` 이 **다른 그림**을 가리킨다.
     * 입력창이 비어 있을 때만 여기 오므로(위 조건) 남은 것에는 표식이 없고, 표식이
     * 없는 첨부는 어차피 나가지 않는다 (`_takeAtts`).
     */
    this._atts=(item.atts||[]).slice();
    this._renderQueue();
    this.ta.selectionStart=this.ta.selectionEnd=this.ta.value.length;
    this._growInput();
    return true;
  }
  /**
   * FR-M11-42: 패널 어디서나 듣는 키. **끊기와 모드 순환 둘뿐이다.**
   *
   * 모달이 떠 있으면 그쪽이 먼저 받는다 (모달은 `document` 에 걸린 자기 핸들러가 있고
   * 이 요소 밖에 산다) — 그 처리는 `FR-M11-41` 이 정한다.
   */
  _onPaneKey(e){
    if(e.key==='Escape'){
      e.preventDefault(); e.stopPropagation();
      // FR-M11-48: 목록이 떠 있으면 그것을 닫는 것이 먼저다 — 끊기는 그 다음 누름이다.
      if(!this.sugg.hidden){ this._suggClose(); return }
      this._ctrlC=0; this.interrupt(); return;
    }
    /**
     * FR-M11-44 (M11-B44): **`Ctrl+C` 두 번이면 빠져나온다.**
     *
     * 원본 TUI 그대로다 (사용자 결정 2026-09-15): 첫 번은 턴만 끊고, 짧은 사이에 다시
     * 누르면 나간다.
     *
     * **선택이 있으면 복사다.** `FR-M11-36`(에이전트의 내용은 선택·복사된다)이 그
     * 손을 막 열어 두었는데, 여기서 무조건 가로채면 그 요구를 되돌리게 된다 —
     * 읽는 자리에서 가져가는 길이 먼저다.
     */
    if((e.key==='c'||e.key==='C')&&e.ctrlKey&&!e.metaKey&&!e.altKey){
      const sel=window.getSelection&&window.getSelection();
      if(sel&&String(sel)) return;
      e.preventDefault(); e.stopPropagation();
      this._onCtrlC();
      return;
    }
    if(e.key==='Tab'&&e.shiftKey&&e.target!==this.ta){ e.preventDefault(); this.cyclePermission(); return }
    if(e.key==='Tab'&&e.shiftKey&&this.sugg.hidden){ e.preventDefault(); this.cyclePermission(); return }
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
    /**
     * FR-M11-48 (M11-B51): **`/글자` 는 검색이다.**
     *
     * 접수: *"슬레시(/)로 명령시 드롭다운이나 그런 종류로 선택지 선택 가능. /글자 로
     * 입력하면 / 명령어 검색 가능. 이것도 기본으로 있는 기능이다"*.
     *
     *   이전 동작: **접두 일치**만이고, 고르는 손이 마우스와 `Tab` 하나뿐이었다.
     *              설명은 `title` 에만 있어 가리켜야 보인다
     *   새  동작: 이름 **어디에 있어도** 찾고(접두가 앞에 선다), `↑↓` 로 고르고
     *              `Enter`·`Tab` 으로 넣는다. 설명이 항목에 보인다
     *   이유:     그것이 원본에 이미 있는 기능이다
     *
     * **접두를 앞에 두는 것이 요점이다.** 부분 일치만으로 정렬하면 `/model` 을 치는
     * 중에 `set-model` 류가 먼저 서서, 찾으려던 것이 목록 아래로 밀린다.
     */
    const pre=[],mid=[];
    for(const c of cmds){
      if(!c||!c.name) continue;
      const n=c.name.toLowerCase();
      if(n.startsWith(q)) pre.push(c);
      else if(q&&n.includes(q)) mid.push(c);
    }
    const hits=pre.concat(mid).slice(0,AGENT_SUGG_MAX);
    this.sugg.textContent='';
    if(!hits.length||(hits.length===1&&hits[0].name===q&&!hits[0].argumentHint)){ this.sugg.hidden=true; return }
    for(const [i,c] of hits.entries()){
      const b=document.createElement('button'); b.type='button'; b.className='ui-btn ui-btn-sm ui-btn-ghost agp-sugg-item';
      b.setAttribute('role','option');
      const nm=document.createElement('span'); nm.className='agp-sugg-name'; nm.textContent='/'+c.name; b.appendChild(nm);
      if(c.argumentHint){ const h=document.createElement('span'); h.className='agp-sugg-hint'; h.textContent=c.argumentHint; b.appendChild(h) }
      // 설명은 **보여야** 고를 수 있다 — `title` 은 가리켜야 나온다 (FR-M9-45 와 같은 근거).
      if(c.description){ const d=document.createElement('span'); d.className='agp-sugg-desc'; d.textContent=c.description; b.appendChild(d) }
      b.addEventListener('click',()=>this._suggTake(c));
      this.sugg.appendChild(b);
      if(i===0) b.dataset.cur='1';
    }
    this.sugg.hidden=false;
    this._suggAt=0;
  }
  /** 고른 것을 입력창에 넣는다 — 마우스와 키가 같은 자리를 지난다. */
  _suggTake(c){
    this.ta.value='/'+c.name+(c.argumentHint?' ':'');
    this._suggClose();
    this.ta.focus();
    this.ta.selectionStart=this.ta.selectionEnd=this.ta.value.length;
    this._growInput();
  }
  _suggClose(){ this.sugg.hidden=true; this.sugg.textContent=''; this._suggAt=0 }
  /** `↑↓` 로 목록을 훑는다. 현재 항목은 `data-cur` 가 말한다 (CSS 가 그것을 칠한다). */
  _suggMove(d){
    const items=[...this.sugg.querySelectorAll('.agp-sugg-item')];
    if(!items.length) return false;
    const n=items.length;
    this._suggAt=((this._suggAt||0)+d+n)%n;
    for(const [i,b] of items.entries()){
      if(i===this._suggAt) b.dataset.cur='1'; else delete b.dataset.cur;
    }
    items[this._suggAt].scrollIntoView({block:'nearest'});
    return true;
  }
  _suggCur(){
    const items=[...this.sugg.querySelectorAll('.agp-sugg-item')];
    return items[this._suggAt||0]||null;
  }
  /**
   * FR-M11-14 (M11-B11): **`/model`·`/config` 는 고르는 화면을 연다.**
   *
   * 접수: *"여전히 /model, /config 같은 tui 들은 사용이 불가"*. **막힌 것은 명령이
   * 아니다** (실측 §2.11 (5)): 둘 다 정상 응답하고, `init` 이 말하는 TUI 전용 명령
   * (`doctor`·`color`·`reload-plugins`)에도 없다. 막힌 것은 **고를 자리**다 — 원본
   * TUI 에서 인자 없는 `/model` 은 선택 화면을 띄우는데 프로토콜은 사용법 텍스트를
   * 돌려줄 뿐이다.
   *
   * **인자가 있으면 가로채지 않는다** — `/model opus` 는 사용자가 이미 고른 것이다.
   *
   * 참이면 이 함수가 처리했다는 뜻이다.
   */
  _pickCommand(text){
    const m=AGENT_PICK_CMD_RE.exec(text);
    if(!m) return false;
    if(m[1]==='model') return this._openModelPick();
    // `/config` 의 키·선택지는 **응답이 준다** — 우리가 목록을 지어내지 않는다.
    // 보내 두고, 답이 오면 그것으로 연다 (`_message` 의 말 블록이 계기다).
    this._submit(text,[]);
    return true;
  }
  /**
   * FR-M11-40 (M11-B40): **고르는 화면이 서면 그 명령은 대화에 남지 않는다.**
   *
   * 원본 TUI 에서 `/model` 은 **선택 화면으로 끝난다** — 사용법 텍스트는 우리가 그것을
   * 열려고 물은 것이지 사용자가 읽으려던 것이 아니다.
   *
   * **가로채지 못한 경우는 그대로 선다**: 응답이 목록 모양이 아니어서 폼을 열지 못하면
   * (`FR-M11-14`) 그 텍스트는 보여야 한다 — 감춘 채 아무것도 열지 않으면 명령이 사라진
   * 것으로 읽힌다. 그래서 **연 뒤에** 감춘다.
   */
  _hideCommandEcho(msgEl){
    if(msgEl&&msgEl.parentNode) msgEl.remove();
  }
  /**
   * 모델 목록은 `initialize` 가 이미 주었고 메뉴가 그것을 쓴다 (`status.models`) —
   * 같은 값을 두 벌로 만들지 않는다. **모르면 열지 않는다**: 종전처럼 명령이 그대로
   * 나가고 텍스트가 선다 (FR-CBG-5 — 없는 선택지를 지어내지 않는다).
   */
  _openModelPick(){
    // `/model` 은 **보내지 않는다** — 목록을 이미 들고 있으므로 물을 것이 없다.
    // 그래서 대화에 남는 것도 없다 (FR-M11-40 이 `/config` 에만 손이 드는 이유).
    const models=(this.state&&this.state.status&&this.state.status.models)||[];
    if(!models.length) return false;
    this._openPick(t('agent.model'),models.map(x=>({
      value:x.value,label:x.displayName||x.value,title:x.description||'',cur:x.value===this._model,
    })),v=>this._submit('/model '+v,[]));
    return true;
  }
  /**
   * `/config` 응답 텍스트를 폼으로. 한 줄이 `key=a|b|c` 인 목록이며 파싱은 결정적이다
   * (실측 §2.11 (5)). **그 모양이 아니면 열지 않는다** — 텍스트가 그대로 선다.
   *
   * 현재값은 **되읽지 않는다** (§7 의 갭): 응답이 주는 것은 키와 선택지뿐이고, 보낸
   * 값을 *현재값* 으로 적으면 실패했을 때 그것이 거짓이 된다.
   */
  _openConfigPick(text){
    const keys=[];
    for(const line of String(text||'').split('\n')){
      const m=/^\s+([A-Za-z][\w.]*)=(\S.*)$/.exec(line);
      if(m) keys.push({key:m[1],values:m[2].split('|').map(x=>x.trim()).filter(Boolean)});
    }
    if(!keys.length) return false;
    const body=document.createElement('div'); body.className='agp-cfg';
    /**
     * **고른 것이 여럿일 수 있다.** 사용법이 `key=value [key=value ...]` 이므로 화면도
     * 여럿을 세운다 — 한 자리만 기억하면 마지막에 만진 것만 나가고, 그것은 폼이 셋을
     * 보이면서 하나만 보내는 거짓이 된다. 고른 것들을 자리마다 들고 보낼 때 모은다.
     */
    const picked=new Map();
    for(const k of keys){
      const row=document.createElement('div'); row.className='agp-cfg-row';
      const name=document.createElement('span'); name.className='agp-cfg-key'; name.textContent=k.key;
      const sel=document.createElement('select'); sel.className='agp-cfg-val';
      sel.setAttribute('aria-label',k.key);
      const none=document.createElement('option'); none.value=''; none.textContent=t('agent.config_keep');
      sel.appendChild(none);
      for(const v of k.values){ const o=document.createElement('option'); o.value=v; o.textContent=v; sel.appendChild(o) }
      // 되돌리면 그 키만 빠진다 — 옆 자리의 선택을 함께 지우지 않는다.
      sel.addEventListener('change',()=>{ if(sel.value) picked.set(k.key,sel.value); else picked.delete(k.key) });
      row.appendChild(name); row.appendChild(sel); body.appendChild(row);
    }
    const m=UIKit.modal({title:t('agent.config_title'),body,cls:'agp-modal agp-cfg-modal',actions:[
      {label:t('core.cancel'),onClick:()=>{}},
      {label:t('agent.send'),kind:'primary',onClick:()=>{
        if(!picked.size) return;
        // 고른 순서 그대로 — 사용법이 받는 모양이다.
        const args=[...picked].map(([k,v])=>k+'='+v).join(' ');
        this._submit('/config '+args,[]);
      }},
    ]});
    document.body.appendChild(m.el);
    return true;
  }
  /** 값 하나를 고르는 화면 — `/model` 이 쓴다. */
  _openPick(title,items,onPick){
    const body=document.createElement('div'); body.className='agp-pick';
    let value=(items.find(x=>x.cur)||items[0]).value;
    for(const it of items){
      const lab=document.createElement('label'); lab.className='agp-q-opt';
      const inp=document.createElement('input'); inp.type='radio'; inp.name='agp-pick-'+this.id; inp.value=it.value;
      inp.checked=it.value===value;
      inp.addEventListener('change',()=>{ value=it.value });
      const txt=document.createElement('span'); txt.textContent=it.label;
      if(it.title) lab.title=it.title;
      lab.appendChild(inp); lab.appendChild(txt); body.appendChild(lab);
    }
    const m=UIKit.modal({title,body,cls:'agp-modal agp-pick-modal',actions:[
      {label:t('core.cancel'),onClick:()=>{}},
      {label:t('agent.send'),kind:'primary',onClick:()=>onPick(value)},
    ]});
    document.body.appendChild(m.el);
  }

  /**
   * FR-M11-30 (M11-B28): **이미지는 붙여넣기로 온다.**
   *
   * 접수: *"이미지 첨부 기능도 없다 같이해야한다"*. 원본이 `Image in clipboard ·
   * ctrl+v to paste` 라고 그 자리에서 말하므로 손도 그것이다 (§2.10 (6)).
   *
   * **프로토콜은 받는다** (실측 §2.11 (4)) — 막힌 것은 `content` 를 문자열로만 보내던
   * 한 줄이었다. 다만 **받는다고 확인한 어댑터에서만** 연다: `controls.attachments`
   * 가 그 선언이며, 거짓인 곳에서 붙이게 두면 바이트가 조용히 사라진다.
   *
   * 본문에는 원본과 같이 **`[Image #1]`** 이 적힌다 — 무엇을 함께 보내는지 글이 말한다.
   */
  _onPaste(e){
    if(!(this.state&&this.state.controls&&this.state.controls.attachments)) return;
    const items=[...((e.clipboardData&&e.clipboardData.items)||[])]
      .filter(it=>it.kind==='file'&&/^image\//.test(it.type||''));
    if(!items.length) return;
    e.preventDefault();
    for(const it of items){
      const file=it.getAsFile(); if(!file) continue;
      const fr=new FileReader();
      fr.onload=()=>{
        // `data:<mime>;base64,<본문>` 에서 본문만 — 프로토콜이 받는 모양이 그것이다.
        const s=String(fr.result||''); const i=s.indexOf(',');
        if(i<0) return;
        this._atts.push({mediaType:file.type||'image/png',data:s.slice(i+1)});
        this._insertAtCaret(t('agent.image_ref',{n:this._atts.length}));
      };
      fr.readAsDataURL(file);
    }
  }
  /** 캐럿 자리에 글을 끼운다 — 붙여넣기는 그 자리에 오는 것이므로. */
  _insertAtCaret(text){
    const el=this.ta, a=el.selectionStart, b=el.selectionEnd;
    el.value=el.value.slice(0,a)+text+el.value.slice(b);
    el.selectionStart=el.selectionEnd=a+text.length;
    this._growInput();
  }

  /**
   * FR-M11-29 (M11-B27 · B15 · B35): **턴이 도는 중이면 쌓는다.**
   *
   * 접수 셋이 한 자리다 — *"추론중에 입력하면 그대로 입력된다"* · *"프롬프트를 연달아
   * 보낼때의 동작도 실제와 달라"* · 큐를 취소할 수 없다. 원본은 프롬프트를 큐에 쌓아
   * 앞 턴이 끝난 뒤 처리한다 (§2.10 (5) 실측).
   *
   *   이전 동작: 턴 중에도 곧바로 `/api/agent/prompt` 로 나간다 — 큐라는 개념이 없다
   *   새  동작: 도는 중이면 큐에 쌓고 화면에 세운다. 턴이 끝나면 맨 앞이 나간다
   *   이유:     원본이 그렇게 한다
   *
   * **큐는 화면의 것이다** (D-M11-6) — 서버에 두면 보는 브라우저마다 다른 큐가 서거나
   * 남의 큐가 내 화면에 선다 (FR-AGT-12).
   */
  async send(){
    const text=this.ta.value.trim();
    if(!text||this._ended||!this._canControl()) return;
    // 첨부는 **지금 보내는 프롬프트의 것**이다 — 본문이 가리키는 것만 간다.
    const atts=this._takeAtts(text);
    this.ta.value=''; this.sugg.hidden=true; this._histIdx=-1; this._growInput();
    // FR-M11-14 (M11-B11): 인자 없는 `/model`·`/config` 는 **고르는 화면**이다.
    if(this._pickCommand(text)) return;
    await this._submit(text,atts);
    /**
     * FR-M11-39 (M11-B38): **내가 보낼 때는 따라간다.**
     *
     * `FR-M11-26` 의 *"바닥일 때만"* 은 **에이전트가 말할 때**의 규칙이다 — 읽는 중에
     * 끌려가지 않기 위한 것이고, 그 규약의 근거는 *"스크롤은 사용자만 조작한다"* 다.
     * **엔터도 사용자의 조작**이므로 여기서는 내려간다: 방금 친 말은 내가 보려는 것이다.
     */
    this._scrollEnd();
  }
  /**
   * FR-M11-29: **보내는 문은 하나다** — 쌓을지 보낼지를 여기서 가른다.
   *
   * `send()` 만이 아니라 **고르는 화면**(`/model`·`/config`)도 이 문을 지난다. 그러지
   * 않으면 턴이 도는 중에 고른 값이 큐를 건너뛰고 나가며, 그것은 접수한 증상
   * (*"추론중에 입력하면 그대로 입력된다"*)이 한 경로에만 남는 것이다.
   */
  async _submit(text,atts){
    if(this._turning()){ this._enqueue(text,atts||[]); return }
    await this._post(text,atts);
  }
  /**
   * FR-M11-30: **본문이 가리키는 첨부만 간다.**
   *
   * 표식(`[Image #n]`)을 지우는 것이 붙인 것을 무르는 손이다 — 남겨 두면 화면이
   * 말하지 않는 바이트가 실린다. 보낸 뒤에는 남은 것도 버린다: 다음 프롬프트에
   * 몰래 실리면 사용자는 자기가 보내지 않은 그림을 보낸다.
   */
  _takeAtts(text){
    const keep=[];
    this._atts.forEach((a,i)=>{ if(text.includes(t('agent.image_ref',{n:i+1}))) keep.push(a) });
    this._atts=[];
    return keep;
  }
  /** 턴이 도는 중인가 — 쌓을지 보낼지를 가르는 한 자리. */
  _turning(){ return this._activity==='working'||this._activity==='waiting' }
  _enqueue(text,atts){
    this._queue.push({text,atts:atts||[]});
    this._pushHistory(text);
    this._renderQueue();
  }
  async _post(text,atts){
    /**
     * FR-M11-14: **기다림은 나가는 순간에 선다.**
     *
     * 종전에는 `_pickCommand` 에서 세웠는데, 그 사이 이 명령이 **큐에 쌓이면**
     * 도는 턴의 말이 먼저 도착해 그것을 `/config` 의 답으로 읽는다. 계기를 보내는
     * 자리로 옮기면 그 창이 닫힌다.
     */
    if(AGENT_CONFIG_CMD_RE.test(text)) this._awaitConfig=true;
    const body={toolId:this.id,text};
    if(atts&&atts.length) body.attachments=atts;
    const r=await apiPost('/api/agent/prompt',body);
    if(!r.ok){
      Toast.show(apiErrText(r,t('agent.send')),'err');
      this.ta.value=text; this._growInput();
      if(atts&&atts.length) this._atts=atts.concat(this._atts);
    }
  }
  /**
   * 쌓인 것을 그린다. 자리와 모양이 원본 그대로다 — `❯ <본문>` 이 입력창 위에 줄줄이.
   * 입력창의 안내도 함께 바뀐다: **고치는 손은 위 화살표**라고 원본이 그 자리에서 말한다.
   */
  _renderQueue(){
    const q=this._queue;
    this.queueEl.textContent='';
    this.queueEl.hidden=!q.length;
    for(const item of q){
      const row=document.createElement('div'); row.className='agp-queue-item'; row.setAttribute('role','listitem');
      const mark=document.createElement('span'); mark.className='agp-queue-mark'; mark.textContent=AGENT_QUEUE_MARK;
      const body=document.createElement('span'); body.className='agp-queue-text'; body.textContent=item.text;
      row.appendChild(mark); row.appendChild(body);
      this.queueEl.appendChild(row);
    }
    this.ta.placeholder=q.length?t('agent.queue_hint'):t('agent.prompt_placeholder');
  }
  /** 턴이 끝났다 — 맨 앞 하나가 나간다 (원본: *"앞 턴이 끝난 뒤 처리된다"*). */
  _drainQueue(){
    if(!this._queue.length||this._ended) return;
    const item=this._queue.shift();
    this._renderQueue();
    this._post(item.text,item.atts);
  }
  /**
   * FR-M11-29: **`Esc` 는 끊고 한 번에 보낸다.**
   *
   * 사용자 실측: *"queue 에 프롬프트가 가있는 상황에서 esc 누르면 현재 동작 취소되고
   * 큐가 한번에 들어가."* 위 화살표가 **고쳐 쓰는** 손이라면 이쪽은 **지금 것을 끊고
   * 쌓인 것을 즉시 보내는** 손이다 — 둘은 다른 일이다.
   *
   * 큐가 비어 있으면 종전과 같다 (`interrupt` 하나). 더해지는 것은 *큐가 있을 때* 다.
   */
  /**
   * FR-M11-44: 첫 번은 끊고, 짧은 사이에 다시 누르면 **나간다.**
   *
   * 나가는 자리는 **이미 있다** (`agentOpenTerminal` — TUI 출구, FR-AGT-10). 키를 그
   * 출구에 잇는 것이지 새 길을 내지 않는다: 나가는 손이 둘이 되면 한쪽만 고쳐진다.
   *
   * 첫 번 뒤에는 **한 번 더 누르면 나간다고 말한다** — 원본도 그 자리에서 그렇게 한다.
   */
  _onCtrlC(){
    const now=Date.now();
    if(this._ctrlC&&now-this._ctrlC<=AGENT_CTRL_C_WINDOW_MS){
      this._ctrlC=0;
      this.app.agentOpenTerminal(this.id);
      return;
    }
    this._ctrlC=now;
    this.interrupt();
    Toast.show(t('agent.ctrl_c_again'),'',AGENT_CTRL_C_WINDOW_MS);
  }

  /**
   * FR-M11-41: 답하지 않고 닫았다 — **거절을 보내고 이어서 끊는다.**
   *
   * 순서가 요점이다 (§2.12 의 실측): 거절이 열린 요청을 닫고, 끊기가 그 턴을 멈춘다.
   * 둘 중 하나만으로는 접수한 무한 대기가 남는다.
   */
  async _abandon(id){
    const r=await apiPost('/api/agent/approve',{toolId:this.id,id,choice:'deny'});
    if(!r.ok&&r.status!==404) Toast.show(apiErrText(r,t('agent.answer')),'err');
    await this.interrupt();
  }

  async interrupt(){
    if(this._ended||!this._canControl()) return;
    const queued=this._queue.splice(0);
    if(queued.length) this._renderQueue();
    if(!this.stopBtn.hidden){
      const r=await apiPost('/api/agent/interrupt',{toolId:this.id});
      if(!r.ok){ Toast.show(apiErrText(r,t('agent.interrupt')),'err'); return }
    }
    // 쌓인 것은 **한 프롬프트로** 들어간다 — 하나씩 보내면 첫 것이 다시 턴을 열어
    // 나머지가 또 쌓인다 (원본이 한 번에 넣는 이유다). 첨부도 함께 모인다.
    if(queued.length){
      const atts=queued.reduce((a,x)=>a.concat(x.atts||[]),[]);
      await this._post(queued.map(x=>x.text).join('\n'),atts);
    }
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
        const picked=()=>[...fs.querySelectorAll('.agp-q-opt input:checked')].map(x=>x.value);
        for(const [oi,o] of (q.options||[]).entries()){
          const lab=document.createElement('label'); lab.className='agp-q-opt';
          const inp=document.createElement('input'); inp.type=q.multiSelect?'checkbox':'radio'; inp.name='agp-q-'+this.id+'-'+qi; inp.value=o.label;
          inp.addEventListener('change',()=>{
            if(q.multiSelect) answers[q.question]=picked().join(', ');
            else answers[q.question]=o.label;
          });
          if(oi===0&&!q.multiSelect){ inp.checked=true; answers[q.question]=o.label }
          lab.appendChild(inp);
          const txt=document.createElement('span'); txt.textContent=o.label+(o.description?' — '+o.description:''); lab.appendChild(txt);
          fs.appendChild(lab);
        }
        /**
         * FR-M11-31 (M11-B29): **자유 입력은 목록의 마지막 항목이다.**
         *
         * 접수: *"질문에 답하는 모달에서 내가 원하는 답을 자유롭게 적는것도 필요하다"*.
         * 원본을 쟀고(§2.10 (9)) TUI 는 그것을 `3. Type something.` 으로 **선택지와
         * 같은 목록**에 둔다 — 고르는 손과 적는 손이 하나다.
         *
         * **항상 보이는 칸을 두지 않는 이유**가 여기 있다: 라디오를 고른 채 칸에도
         * 적은 상태가 만들어지면 무엇이 답인지 화면이 말하지 못한다. 목록의 한
         * 항목이면 **고른 것이 곧 답**이다.
         */
        if((q.options||[]).length){
          const lab=document.createElement('label'); lab.className='agp-q-opt agp-q-own';
          const inp=document.createElement('input'); inp.type=q.multiSelect?'checkbox':'radio';
          inp.name='agp-q-'+this.id+'-'+qi; inp.value=''; inp.dataset.own='1';
          const txt=document.createElement('span'); txt.textContent=t('agent.answer_own');
          const box=document.createElement('input'); box.type='text'; box.className='agp-q-text';
          box.setAttribute('aria-label',t('agent.answer_own')); box.hidden=true;
          const apply=()=>{
            if(!inp.checked) return;
            if(q.multiSelect) answers[q.question]=picked().concat(box.value?[box.value]:[]).join(', ');
            else answers[q.question]=box.value;
          };
          inp.addEventListener('change',()=>{
            box.hidden=!inp.checked;
            if(inp.checked){ box.focus(); apply() }
            else if(q.multiSelect) answers[q.question]=picked().join(', ');
          });
          box.addEventListener('input',apply);
          lab.appendChild(inp); lab.appendChild(txt);
          fs.appendChild(lab); fs.appendChild(box);
        }
        body.appendChild(fs); fields.push(fs);
      }
      /**
       * FR-M11-45 (M11-B45): **질문은 하나씩 서고 키로 답한다.**
       *
       * 접수: *"선택 모달좀 질문별로 구분 잘가게 하나씩 보이도록 하고 방향키 상하로 답
       * 선택, 방향키 좌우로 질문선택 엔터로 질문넘기기 + summit 페이지 tui 처럼 만들어서
       * 최종확인 후 엔터로 제출"*. 원본이 그 모양이다 (§2.10 (9) — `❯` 가 현재 항목을
       * 가리키고 `Enter to select · ↑/↓ to navigate` 를 늘 적는다).
       *
       * **마우스를 지우지 않는다.** 키가 더해지는 것이지 대신하는 것이 아니다 —
       * 클릭으로 고르고 버튼으로 제출하는 길은 그대로 선다 (FR-A11Y 의 요구이기도 하다).
       * 그래서 위에서 만든 `fieldset` 을 **그대로 쓰고** 보이는 것만 하나로 줄인다.
       */
      if(fields.length) this._wizard(body,fields,answers,req);
    }
    /**
     * FR-M11-41: **답한 뒤의 닫힘과 그냥 닫은 것을 가른다.**
     *
     * `UIKit.modal` 의 액션은 `close()` 를 **먼저** 부르고 그 다음 `onClick` 을 부른다
     * (`ui-kit.js`). 그래서 답하는 길이 닫힘보다 늦고, 그 사이 `onClose` 가 *그냥
     * 닫았다* 로 읽어 거절을 보냈다 — 실측에서 `deny` 가 답보다 **먼저** 나갔다.
     *
     * 그래서 이 상자의 액션은 **스스로 닫는다** (`keepOpen`): 표시를 세우고 닫으므로
     * 순서가 뒤집히지 않는다.
     */
    let answered=false;
    const decide=async d=>{
      answered=true;
      if(this._dialog&&this._dialog.id===req.id&&this._dialog.close) this._dialog.close();
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
    /**
     * FR-M11-41 (M11-B41): **닫는 것은 지금 것을 그만두는 것이다.**
     *
     * 접수: *"질문 모달 취소하면 거기서 interrupt 되어야하는데 무한정 기다림"*.
     * **`FR-APS-6` 을 뒤집는다** (사용자 결정 2026-09-15) — 그 조항은 *"바깥 클릭·Esc 는
     * 답이 아니다"* 였고 근거는 *실수로 닫은 것을 되돌릴 수 있어야 한다* 였다. 실제로
     * 쓰니 **되돌릴 길보다 멈출 길이 급했다.**
     *
     * **거절이 먼저다.** 실측(§2.12 의 ④)이 보였다: interrupt 만 보내면 열린 승인
     * 요청이 그대로 남고 상태가 `waiting` 이다 — claude 에는 *답 없이 닫는 프레임*이
     * 없기 때문이다 (`claudeProto.Cancel` 이 `nil` 인 그 사실). 끊기부터 보내면 그
     * 사이 에이전트가 승인을 기다리는 채로 남아 같은 무한 대기가 된다.
     *
     * **답한 뒤의 닫힘과 가른다**: `answered` 가 서 있으면 이 손은 돌지 않는다.
     */
    // 액션이 스스로 닫는다 — 위 `decide` 의 주석이 그 사유다.
    for(const a of actions) a.keepOpen=true;
    const m=UIKit.modal({title,body,actions,cls:'agp-modal',closeTitle:t('agent.choice_deny'),
      onClose:()=>{
        if(this._dialog&&this._dialog.id===req.id) this._dialog=null;
        if(answered||this._ended) return;
        this._abandon(req.id);
      }});
    this._dialog={id:req.id,close:m.close};
    document.body.appendChild(m.el);
  }

  /**
   * FR-M11-45: 질문 넘김. **한 번에 하나만 보이고 확인 화면이 마지막이다.**
   *
   * 자리(`fields`)는 이미 서 있다 — 여기서는 **보이는 것을 줄이고 키를 잇는다.** 답을
   * 담는 그릇(`answers`)도 그대로이므로 제출 경로가 갈라지지 않는다.
   */
  _wizard(body,fields,answers,req){
    const steps=fields.length;
    const sum=document.createElement('div'); sum.className='agp-q-sum'; sum.hidden=true;
    body.appendChild(sum);
    const nav=document.createElement('div'); nav.className='agp-q-nav';
    const pos=document.createElement('span'); pos.className='agp-q-pos';
    const hint=document.createElement('span'); hint.className='agp-q-hint'; hint.textContent=t('agent.q_keys');
    /**
     * **마우스로도 넘길 수 있어야 한다.** 키를 더하는 것이 이 요구인데 넘기는 손이
     * 키뿐이면 그것은 대신한 것이다 — 클릭으로 고르던 사람이 다음 질문에 갈 길을
     * 잃는다 (FR-A11Y 의 요구이기도 하다).
     */
    const prev=UIKit.button({label:t('agent.q_prev'),kind:'ghost',size:'sm',cls:'agp-q-prev',onClick:()=>move(-1)});
    const next=UIKit.button({label:t('agent.q_next'),kind:'ghost',size:'sm',cls:'agp-q-next',onClick:()=>move(1)});
    nav.appendChild(pos); nav.appendChild(hint); nav.appendChild(prev); nav.appendChild(next);
    body.appendChild(nav);

    let at=0; // steps 와 같으면 확인 화면이다.
    // `move` 는 버튼이 먼저 잡으므로 **호이스팅되는 선언**이어야 한다.
    function move(d){ at=Math.max(0,Math.min(steps,at+d)); paint() }
    const paint=()=>{
      for(const [i,fsEl] of fields.entries()) fsEl.hidden=i!==at;
      const done=at>=steps;
      sum.hidden=!done;
      if(done) this._paintSummary(sum,req,answers);
      pos.textContent=done?t('agent.q_confirm'):t('agent.q_pos',{i:at+1,n:steps});
      prev.disabled=at===0;
      next.disabled=done;
      // 확인 화면에서만 제출이 선다 — 원본이 마지막에 한 번 묻는 것과 같은 자리다.
      const primary=body.closest('.ui-modal-box')&&body.closest('.ui-modal-box').querySelector('.ui-modal-foot .ui-btn-primary');
      if(primary) primary.disabled=!done;
    };
    // 현재 질문 안에서 `↑↓` 로 답을 옮긴다 — 원본의 `↑/↓ to navigate` 다.
    const pick=d=>{
      if(at>=steps) return;
      const opts=[...fields[at].querySelectorAll('.agp-q-opt input')];
      if(!opts.length) return;
      const cur=opts.findIndex(x=>x.checked);
      const next=opts[(Math.max(0,cur)+d+opts.length)%opts.length];
      next.checked=true;
      next.dispatchEvent(new Event('change',{bubbles:true}));
    };
    body.addEventListener('keydown',e=>{
      if(e.key==='ArrowUp'||e.key==='ArrowDown'){
        // 자유 입력 칸 안에서는 캐럿의 일이다 — 가로채지 않는다.
        if(e.target&&e.target.classList&&e.target.classList.contains('agp-q-text')) return;
        e.preventDefault(); pick(e.key==='ArrowDown'?1:-1); return;
      }
      if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
        if(e.target&&e.target.classList&&e.target.classList.contains('agp-q-text')) return;
        e.preventDefault(); move(e.key==='ArrowRight'?1:-1); return;
      }
      if(e.key==='Enter'&&!e.shiftKey){
        e.preventDefault();
        if(at<steps){ move(1); return }
        // 확인 화면의 엔터가 제출이다.
        const primary=body.closest('.ui-modal-box')&&body.closest('.ui-modal-box').querySelector('.ui-modal-foot .ui-btn-primary');
        if(primary&&!primary.disabled) primary.click();
      }
    });
    paint();
    // 키가 바로 듣도록 — 모달이 열리면 이 자리가 포커스를 갖는다.
    body.tabIndex=-1;
    TIMERS.frame(()=>{ if(body.isConnected) body.focus() },{owner:this,label:'agp-q-focus'});
  }
  /** 확인 화면 — 질문과 고른 답을 나란히 적는다. */
  _paintSummary(el,req,answers){
    el.textContent='';
    const h=document.createElement('div'); h.className='agp-q-sum-head'; h.textContent=t('agent.q_confirm_head');
    el.appendChild(h);
    for(const q of (req.questions||[])){
      const row=document.createElement('div'); row.className='agp-q-sum-row';
      const k=document.createElement('span'); k.className='agp-q-sum-k'; k.textContent=q.header||q.question;
      const v=document.createElement('span'); v.className='agp-q-sum-v';
      v.textContent=answers[q.question]||t('agent.q_no_answer');
      row.appendChild(k); row.appendChild(v); el.appendChild(row);
    }
  }

  destroy(){
    this._destroyed=true;
    if(this._busyJob){ this._busyJob.stop(); this._busyJob=null }
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
