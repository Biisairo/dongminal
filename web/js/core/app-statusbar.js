/**
 * Remote Terminal — App 상태바 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 11개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  // ── Status Bar ──
  initStatusBar(){
    this._stats={};this._latency=null;
    // FR-GIT-101a: 진행 중인 원격 작업 목록. **표시용이 아니다** — 다른 브라우저
    // 창이 띄운 작업도 같은 리포의 원격 버튼을 막아야 하므로(FR-GIT-101) 이
    // 폴링이 그 목록을 나른다. 상태바 chip 은 철회됐고 폴링은 남았다.
    this._gitJobs=[];
    // FR-BGU-4: 진입점은 정적 요소다. 리스너를 여기서 한 번만 부착한다 —
    // 지표 재생성(updateStatusBar) 주기에 종속되면 안 된다.
    const bgBtn=document.getElementById('bg-btn');
    if(bgBtn) bgBtn.addEventListener('click',e=>{e.stopPropagation();this._bgModalToggle()});
    this._initStatusBarFold();
    /**
     * FR-CHR-11 (D-6): **깼던 규약을 되돌린다.**
     *
     * 종전에는 여기서 Run 목록을 한 번 받았다 — 상태바의 `⚡ n` 이 네 구역의
     * 합이라 Run 을 세야 했기 때문이고, 그것이 *"Run 을 한 번도 열지 않은
     * 브라우저는 `RunsPanel` 을 만들지 않는다"* (`gitObs` 규약)를 깼다.
     *
     * `⚡` 가 없어져 셀 이유가 사라졌다. 규약이 제자리로 온다 — 목록은 `Runs`
     * 를 누른 사람에게만 간다.
     */
    this._initStatusBarReflow();
    // FR-BGK-3/4/10: 인라인 확인·진행·오류는 **데이터**로 산다. 모달은 _bgRefresh
    // 마다 통째로 다시 그려지므로, 요소에 붙인 상태는 다시 그리기가 버린다
    // (GIT_REMAINING §1.3 이 전수 조사한 그 부류의 결함이다).
    this._bgConfirm=null; this._bgPending=null; this._bgError=null;
    this._startStatsPoll();
    this._renderStatusBarSettings();
  },
  _startStatsPoll(){
    if(this._statsPoll) this._statsPoll.stop();
    // FR-RST-23: 숨은 탭에서는 돌지 않고, 돌아오면 즉시 한 번 갚는다
    // (SYSTEM_STATS_SRS FR-STAT-17). 규약은 `visiblePoll` 하나가 갖는다.
    this._statsPoll=visiblePoll(()=>statsInterval,()=>this._pollStats(),{immediate:true});
  },
  /**
   * FR-PRF-36~38 (`refactor/README.md` §4.1 항목 10).
   *
   *   이전 동작: 세 왕복이 **직렬**이었다 — ping → stats → git/jobs
   *   새  동작: ping 은 홀로 앞에 남고 **뒤의 둘이 겹친다** (회차당 3r → 2r)
   *   이유:     ②③이 서로를 기다릴 이유가 없다. 원격 접속(`start.sh --expose`)에서
   *             RTT 80ms 면 회차가 240ms 이고, 주기를 하한(1초)으로 내린
   *             사용자에게는 주기의 **24%** 가 대기다
   *
   * **①은 겹치지 않는다.** 그 왕복은 지연 측정 자체가 목적이라(아래 `t0`)
   * 다른 요청과 같은 줄에 서면 측정이 오염된다. 앞에 두는 것만으로 충분하다.
   *
   * 회차 겹침 가드를 더하지 않는다 — `TimerHub` 의 `overlap:'drop'` 기본값이
   * 이미 막는다 (`timer-hub.js:148`).
   */
  async _pollStats(){
    // Measure real network latency with lightweight ping
    const t0=performance.now();
    const ping=await apiGet('/api/ping');
    // 망 실패는 status 0 이다 — 그때 지연은 숫자가 아니라 "없음" 이다.
    this._latency=ping.status?Math.round(performance.now()-t0):null;
    // 통계는 따로 받는다 — ping 을 순수한 지연 측정으로 남겨 두려는 것이다.
    const [st]=await Promise.all([apiGet('/api/stats'),this._pollGitJobs()]);
    if(st.ok&&st.data) this._stats=st.data;
    this.updateStatusBar();
  },
  /**
   * FR-RPT-3: 지표를 통째로 다시 만들지 않는다.
   *
   * 이 함수는 stats 폴링과 git status 폴링에서 **1초마다** 불린다. 지표에 제스처는
   * 없지만 `title` 툴팁이 있고, 요소를 다시 만들면 브라우저가 표시 중인 툴팁을
   * 닫는다 — chip 을 hover 해서 리포 경로를 읽는 일이 되지 않는다.
   *
   * **컨테이너 단위 가드로는 부족하다.** 지연·CPU·업타임은 매 회차 값이 달라
   * "전체가 같으면 그리지 않는다" 가 거의 발동하지 않는다. 그래서 지표를 **항목으로**
   * 다루고, 값이 바뀐 항목만 다시 만든다.
   */
  updateStatusBar(){
    const bar=document.getElementById('sb-items');if(!bar)return;
    const items=[];
    const push=(k,html)=>items.push({k,html});
    // **값은 전부 이 함수를 지난다** (02-fe-arch 의 P0).
    //
    // 여기 오는 값의 출처가 여럿이고 그중 하나가 터미널 출력이다 — 셸에서 도는
    // 어떤 프로그램이든 `printf '\e]777;Cwd;<img src=x onerror=…>\a'` 한 줄로
    // 이 자리에 임의의 마크업을 넣을 수 있었다. `cat` 한 파일, `curl` 응답, SSH
    // 원격 호스트의 프롬프트, 에이전트 출력이 전부 소스이며, 디렉터리 이름에
    // `<` 를 넣는 것은 POSIX 가 허용한다.
    //
    // **출처가 아니라 싱크에서 막는다.** 출처를 세다 보면 하나를 빠뜨리게 되고,
    // 이 UI 는 터미널·파일·git 쓰기·설정 API 에 닿으므로 그 하나가 전부다.
    // 서버가 준 값(hostname·cpu…)도 예외를 두지 않는다 — 예외가 있으면 다음
    // 사람이 어느 쪽인지 판단해야 하고, 그 판단이 틀리는 날이 온다.
    const e=escHtml;
    /**
     * UIUX_OVERHAUL_SRS FR-CHR-11 (D-6): **`⚡` 는 여기 없다.**
     *
     *   이전 동작: 상태바의 `⚡ n` 하나가 주의·에이전트·백그라운드·Run 넷의
     *             진입점이었다 (FR-ACT-3)
     *   새  동작: 그 넷은 상단바의 `경고`·`Agents`·`Background`·`Runs` 가 연다
     *   이유:     실사용자가 `⚡` 를 찾지 못했다 (R-5 현실화). 상태바는 **상태**를
     *             말하는 줄이고 동작의 진입점은 상단바의 것이다 — 가르는 축은
     *             전역인가 국소인가이지 빈도가 아니다
     *
     * **합쳐진 것은 패널이지 진입점이 아니었다** — FR-ACT-1·2·4·5·6 은 그대로다.
     * 넷이 같은 활동 패널을 열고, 단축키는 그 구역으로 스크롤한다.
     */
    if(statusBar.connection){
      const ok=this._latency!==null;
      push('connection',`<span class="sb-item"><span class="sb-dot ${e(ok?'ok':'err')}"></span>${e(ok?t('statusbar.connected'):t('statusbar.disconnected'))}</span>`);
    }
    if(statusBar.latency&&this._latency!==null){
      push('latency',`<span class="sb-item"><span class="mono">${e(this._latency)}ms</span></span>`);
    }
    if(statusBar.location){
      const loc=this._locationLabel();
      if(loc)push('location',`<span class="sb-item" title="${e(t('statusbar.location_title',{loc}))}">📍 ${e(loc)}</span>`);
    }
    if(statusBar.cwd){
      push('cwd',`<span class="sb-item">📁 <span class="mono sb-ref">${e(this._shortCwd(this.cwd||'~'))}</span></span>`);
    }
    if(statusBar.hostname&&this._stats.hostname){
      push('hostname',`<span class="sb-item">💻 <span class="mono sb-ref">${e(this._stats.hostname)}</span></span>`);
    }
    if(statusBar.cpu&&this._stats.cpu!==undefined){
      push('cpu',`<span class="sb-item">CPU <span class="mono">${e(this._stats.cpu)}%</span></span>`);
    }
    if(statusBar.memory&&this._stats.memTotal){
      const used=this._fmtMemSize(this._stats.memUsed);
      const total=this._fmtMemSize(this._stats.memTotal);
      push('memory',`<span class="sb-item">MEM <span class="mono">${e(used)}/${e(total)}</span></span>`);
    }
    if(statusBar.disk&&this._stats.diskPct){
      push('disk',`<span class="sb-item">DISK <span class="mono">${e(this._stats.diskPct)}%</span></span>`);
    }
    if(statusBar.termsize){
      const p=this.focusedTerminal();
      if(p&&p.term){
        push('termsize',`<span class="sb-item"><span class="mono">${e(p.term.cols)}×${e(p.term.rows)}</span></span>`);
      }
    }
    if(statusBar.uptime){
      // FR-TYP-3: 사람말과 기계값이 한 문자열로 섞여 있어 M1 이 이 줄만 남겼다 —
      // `'시스템 {v}'` 안에서는 `1d 21h` 를 꺼낼 수 없다. 템플릿을 **라벨만**으로
      // 가르고 값은 `.mono` 로 나른다. 이웃 지표(CPU·MEM·DISK)와 같은 모양이다.
      //
      // **조각을 문자열로 잇지 않는다** (02-fe-arch 의 P0): 마크업이 든 조각을
      // `join` 하면 그 `${…}` 는 이스케이프로 시작하지 않고, 게이트는 예외를 두지
      // 않는다. 여기는 DOM 으로 세운다 — `reconcileList` 가 `el` 을 받는다.
      const el=document.createElement('span'); el.className='sb-item';
      el.appendChild(document.createTextNode('↑ '));
      const seg=(k,v)=>{
        // `.sb-sep` 는 이 자리를 위해 있던 규칙이고 아무도 쓰지 않고 있었다.
        if(el.childNodes.length>1){
          const sep=document.createElement('span'); sep.className='sb-sep'; sep.textContent='│';
          el.appendChild(sep);
        }
        el.appendChild(document.createTextNode(t(k)+' '));
        const m=document.createElement('span'); m.className='mono'; m.textContent=v;
        el.appendChild(m);
      };
      if(this._stats.sysUptime)seg('statusbar.uptime_sys',this._stats.sysUptime);
      if(this._stats.srvUptime)seg('statusbar.uptime_srv',this._stats.srvUptime);
      if(el.childNodes.length>1)items.push({k:'uptime',el});
    }
    // **상태바에 git 표면은 없다.** 브랜치 chip 은 FR-FLW-12 가, 진행 중 원격 작업
    // chip 은 U-19 ①(FR-GIT-112 철회)이 없앴다 — 둘 다 사용자 판정이다.
    // 근거는 그려질 마크업 전부다 (FR-RPT-2). 문자열 지표는 그 문자열이고, chip 은
    // DOM 이므로 `outerHTML` 이다.
    reconcileList(bar,items,{
      key:i=>i.k,
      sig:i=>i.html!==undefined?i.html:i.el.outerHTML,
      build:i=>{
        if(i.el) return i.el;
        const t=document.createElement('template');
        t.innerHTML=i.html;
        return t.content.firstElementChild;
      },
    });
    // FR-HIE-4: 순위를 행에 싣는다. `reconcileList` 가 키를 `dataset.rkey` 로
    // 남기므로(repaint.js) 그것을 표에 대어 보면 된다 — 마크업에 순위를 적지 않는다.
    for(const el of bar.children){
      const pri=STATUSBAR_PRI[el.dataset.rkey];
      if(pri) el.dataset.pri=String(pri);
    }
    this._foldStatusBar();
    this._updateBgBtn();
  },

  /**
   * STATUS_BAR_REFLOW_SRS FR-SBR-7: 상태바가 줄을 늘리면 `#area` 가 그만큼 줄어
   * 터미널의 cols/rows 가 어긋난다. 그 변화는 `window.resize` 를 내지 않으므로
   * (§2.2) 상태바 자신의 크기를 계기로 삼는다.
   */
  _initStatusBarReflow(){
    const bar=document.getElementById('status-bar');
    if(!bar||typeof ResizeObserver==='undefined')return;
    let h=null,w=null;
    this._sbRo=new ResizeObserver(es=>{
      const r=es[es.length-1].contentRect;
      const nh=r.height,nw=r.width;
      // FR-HIE-4: 폭이 바뀌면 접힘을 다시 잰다. 높이보다 먼저 보는 것은, 접는
      // 일이 높이를 바꾸어 아래 분기를 스스로 부르기 때문이다 — 순서가 반대면
      // 한 프레임 늦게 맞춘다. 접힘은 멱등이라 되먹임이 돌지 않는다.
      if(w!==null&&Math.abs(nw-w)>=0.5) this._foldStatusBar();
      w=nw;
      // 첫 관측은 지금 높이를 적어 두는 일일 뿐이다 — 변한 것이 없다.
      if(h===null){h=nh;return}
      if(Math.abs(nh-h)<0.5)return;
      h=nh;
      this._scheduleFit();
    });
    this._sbRo.observe(bar);
  },

  // FR-SBR-8..11: 진입점은 상단바 `Runs` 와 `Agents` 사이의 정적 버튼이다.
  // 이름은 줄이지 않는다 — `BG` 는 처음 보는 사람에게 아무것도 말하지 않는다
  // (FR-SBR-11, 1.0.3 개정).
  // 지표 재생성과 수명을 공유하지 않으므로(FR-RPT-3) 여기서는 개수와 하이라이트만
  // 갱신한다. **숨기지 않는다** — 나타났다 사라지는 버튼이 이웃의 자리를 흔든다 (D-3).
  _updateBgBtn(){
    const btn=document.getElementById('bg-btn');if(!btn)return;
    const n=(this._bg&&this._bg.length)||0;
    btn.textContent=n?t('html.btn_background_n',{n}):t('html.btn_background');
    // FR-TIP-2: 툴팁은 영어다. 배지의 숫자는 그대로 — 바뀌는 것은 title 뿐이다.
    btn.title=n?`${n} tool${n===1?'':'s'} running in the background`
              :'No tools running in the background';
    btn.classList.toggle('on',!!n);
  },

  /**
   * FR-BGU-6/7 (**UIUX_OVERHAUL_SRS FR-ACT-2 로 개정**): 진입점은 이제 **패널**을
   * 연다. 중앙 차단 모달이 사라졌다 — 되돌릴 것이 없는 조회가 백드롭으로 앱
   * 전체를 막을 이유가 없다 (§3.3 원칙 4).
   *
   * 이름은 그대로 둔다. 부르는 자리가 여섯이고(`app.js` 의 `bgToggle` ·
   * `app-tool.js` · `app-cmd.js` · 진입점 · 행 클릭 · e2e) 이름을 바꾸는 것은
   * 이 변경이 아니다. `open===false` 는 "닫아라" 가 아니라 **"내 일은 끝났다"**
   * 로 남는다 — 패널은 조회이므로 남의 동작이 닫지 않는다.
   */
  _bgModalToggle(open){
    if(open===false) return;                 // 조회는 남의 동작에 닫히지 않는다
    this._bgConfirm=null; this._bgError=null;
    this.actPanelOpen('bg');
  },

  /** 패널이 열려 있으면 다시 그린다. 모달 시절 `_bgModalRender` 가 하던 일이다. */
  _bgPanelPaint(){
    this.agentsRender();
  },

  // FR-BGK-1: 행 하나. 종료는 행 클릭(복귀)과 **다른 목표**다 — 겹치면 복귀하려다
  // 죽인다. 확인·진행·오류는 this._bg* 에서 파생하므로 다시 그려도 살아남는다.
  _bgRow(b){
    const confirming=this._bgConfirm===b.toolId;
    const pending=this._bgPending===b.toolId;
    const row=document.createElement('div'); row.className='bg-row';
    if(!confirming&&!pending) row.title=t('bg.row_title');
    // .pn-tab[data-toolid] 과 같은 관행 — 어느 도구의 행인지 DOM 으로 식별한다.
    row.dataset.toolid=b.toolId;
    // FR-NAM-5: 백그라운드 도구에는 탭이 없다 — 파생 이름이 그 도구를 부르는
    // 유일한 이름이다. 서버가 준 name 은 fallback 으로만 쓴다.
    const name=document.createElement('span'); name.className='bg-name';
    name.textContent=this._toolName(b.toolId,b.name);
    const cwd=document.createElement('span'); cwd.className='bg-cwd'; cwd.textContent=b.cwd||'';
    row.appendChild(name); row.appendChild(cwd);
    // FR-BGK-12: Run 소속. 묶음 H 가 오기 전에는 필드가 없고, 그때는 아무것도 붙지 않는다.
    const run=this._bgRun(b);
    if(run){
      const el=document.createElement('span'); el.className='bg-run';
      // FR-TYP-3: 혼합 문자열은 조각으로 가른다 — `Run` 과 역할명은 사람말이고
      // short 는 해시다. textContent 로 붙이는 것은 그대로다 (역할명은 사용자
      // 입력이므로 innerHTML 로 올리지 않는다).
      el.appendChild(document.createTextNode('Run '));
      const hash=document.createElement('span'); hash.className='mono'; hash.textContent=run.short;
      el.appendChild(hash);
      if(run.role) el.appendChild(document.createTextNode(' · '+run.role));
      row.appendChild(el);
    }
    // FR-BGK-10: 오류는 행 안에 남는다. 종료 목표보다 앞에 두어 오른쪽 끝이 흔들리지 않는다.
    if(this._bgError&&this._bgError.toolId===b.toolId){
      const err=document.createElement('span'); err.className='bg-err';
      err.textContent=this._bgError.msg; row.appendChild(err);
    }
    if(pending){
      // 서버가 SIGTERM 유예(3초)를 기다리므로 응답은 즉답이 아니다. 아무 표시가
      // 없으면 사용자는 눌리지 않았다고 보고 행을 다시 누른다 — 그것이 복귀다.
      const p=document.createElement('span'); p.className='bg-killing'; p.textContent=t('runs.closing');
      row.appendChild(p);
    }else if(confirming){
      row.appendChild(this._bgConfirmEl(b));
    }else{
      row.appendChild(this._bgKillBtn(b));
    }
    row.addEventListener('click',()=>{
      if(this._bgPending) return;
      // FR-BGK-5: 확인이 열려 있으면 행을 건드리는 것은 **취소일 뿐**이다.
      // 취소와 복귀를 한 클릭에 겹치면 확인의 의미가 사라진다.
      if(this._bgConfirm){this._bgConfirmSet(null);return}
      this._restoreTool(b.toolId);
    });
    return row;
  },

  // FR-BGK-2: 항상 보인다. hover 게이팅하지 않는다 — 터치 기기에 hover 가 없다.
  _bgKillBtn(b){
    const btn=document.createElement('button');
    btn.className='ui-btn ui-btn-sm bg-kill'; btn.textContent=t('runs.close');
    btn.title=t('bg.kill_title',{name:this._toolName(b.toolId,b.name)});
    btn.dataset.toolid=b.toolId;
    btn.addEventListener('click',e=>{e.stopPropagation();this._bgConfirmSet(b.toolId)});
    return btn;
  },

  // FR-BGK-4: 확인은 행 안에서 한다. 모달 위의 모달은 Escape 처리와 포커스
  // 관리를 복잡하게 만든다.
  _bgConfirmEl(b){
    const wrap=document.createElement('span'); wrap.className='bg-confirm';
    const q=document.createElement('span'); q.className='bg-q'; q.textContent=this._bgKillQuestion(b);
    const yes=document.createElement('button'); yes.className='ui-btn ui-btn-sm ui-btn-danger bg-yes'; yes.textContent=t('core.yes');
    yes.title=TIP_BG_KILL_YES;
    const no=document.createElement('button'); no.className='ui-btn ui-btn-sm bg-no'; no.textContent=t('core.no');
    no.title=TIP_BG_KILL_NO;
    yes.addEventListener('click',e=>{e.stopPropagation();this._bgKill(b.toolId)});
    no.addEventListener('click',e=>{e.stopPropagation();this._bgConfirmSet(null)});
    wrap.appendChild(q); wrap.appendChild(yes); wrap.appendChild(no);
    return wrap;
  },

  // FR-BGK-12 / FR-HLM-9: 헤드리스 멤버는 소속을 알리고 죽인다.
  //
  // runId·role 은 /api/tools/background 가 **열린 Run 의 멤버에만** 싣는다
  // (omitempty — 모르면 키가 없다). 그러니 없는 것이 정상이고, 그때는 "떼어 둔
  // 내 도구" 다. short 는 uuid 앞 8자 (run/store.go 의 shortID 와 같은 규약).
  _bgRun(b){
    if(!b.runId) return null;
    return {short:String(b.runId).slice(0,8),role:b.role||''};
  },

  _bgKillQuestion(b){
    const run=this._bgRun(b);
    if(!run) return t('bg.q_kill');
    return run.role
      ? t('bg.q_kill_member_role',{short:run.short,role:run.role})
      : t('bg.q_kill_member',{short:run.short});
  },

  // FR-BGK-5: 확인은 한 번에 하나다. 다른 행의 종료를 누르면 앞의 확인은 취소된다.
  _bgConfirmSet(toolId){
    this._bgConfirm=toolId||null;
    this._bgError=null;
    this._bgPanelPaint();
  },

  // FR-BGK-6~10: 종료는 POST /api/tools/kill 이다. 성공하면 목록만 다시 받는다 —
  // 모달은 열린 채로 남고(FR-BGK-8), "없음" 과 배지 소멸은 그 갱신이 따라온다
  // (FR-BGK-9). 실패하면 행이 남고 오류만 인라인으로 붙는다(FR-BGK-10).
  async _bgKill(toolId){
    this._bgConfirm=null; this._bgError=null; this._bgPending=toolId;
    this._bgPanelPaint();
    const r=await apiPost('/api/tools/kill',{toolId});
    const ok=r.ok;
    let msg='';
    if(!ok) msg=apiErrText(r,t('runs.close_fail'));
    this._bgPending=null;
    if(!ok) this._bgError={toolId,msg};
    else await this._bgRefresh();
    // 응답을 기다리는 사이에 모달이 닫혔을 수 있다 — 그때 그리면 되살아난다.
    // 목록 갱신이 실패한 회차에도 '종료 중…' 이 남지 않게 여기서 한 번 더 그린다.
    this._bgPanelPaint();
  },
  /**
   * 상태바의 cwd 표기 (M6 `FE-21`).
   *
   *   이전 동작: `cwd.replace(/^\/Users\/[^/]+/,'~')` — **macOS 전용 정규식**
   *             이었다. Linux 의 `/home/<user>` 도 Windows 의 `C:\Users\<user>`
   *             도 걸리지 않아, 그 두 OS 에서는 절대경로가 통째로 상태바에
   *             들어갔다. 자르는 쪽도 `split('/')` 이라 Windows 에서는 조각이
   *             언제나 하나였고, 그래서 **길이 제한도 듣지 않았다**
   *   새  동작: **서버가 아는 홈**(`_edHome()`)을 접두로 쓰고, 구분자는
   *             `pathSep` 이 그 경로에게 묻는다
   *   이유:     홈이 어디인지는 OS 가 아니라 **그 인스턴스**가 안다. 추측하는
   *             정규식 대신 아는 값을 쓴다 — `pathBase`·`pathUnder` 가 같은
   *             이유로 구분자를 경로에게 묻고 있었다
   *
   * 홈 아래가 아니면 `~` 를 붙이지 않는다. 종전에는 잘라낼 때 무조건 `~/.../`
   * 를 앞세워, 홈 밖의 깊은 경로가 **홈 아래인 것처럼** 보였다.
   */
  _shortCwd(cwd){
    const sep=pathSep(cwd);
    const home=this._edHome?this._edHome():'';
    let short=cwd,athome=false;
    if(home&&pathUnder(home,cwd)){
      athome=true;
      const rel=pathRel(home,cwd);
      short=rel?('~'+sep+rel.split('/').join(sep)):'~';
    }
    const parts=short.split(sep);
    if(parts.length>4) short=(athome?'~':'…')+sep+'...'+sep+parts.slice(-3).join(sep);
    return short;
  },

  /**
   * **시스템 메모리**의 표기 (M6 `FE-22`).
   *
   * `file-editor` 의 `_fmtFileSize` 와 **합치지 마라.** 그쪽은 B·KB 가 뜻을
   * 갖는 값(파일 크기)이고 이쪽은 언제나 MB 이상이다. 이름이 둘 다
   * `_fmtBytes` 였던 것이 그 둘을 "중복" 으로 읽히게 했다 — 합치면 두 화면 중
   * 하나의 표기가 조용히 바뀐다.
   */
  _fmtMemSize(b){
    if(b<1073741824)return(b/1048576).toFixed(1)+'MB';
    return(b/1073741824).toFixed(1)+'GB';
  },
  _locationLabel(){
    const s=this.aw();if(!s||!s.layout||!this.focused)return null;
    const sidx=this.ws.windows.findIndex(x=>x.id===this.ws.activeWindow);
    if(sidx<0)return null;
    const panes=[];
    const walk=n=>{
      if(!n)return;
      if(n.type==='pane')panes.push(n);
      else if(n.type==='split')for(const c of(n.children||[]))walk(c);
    };
    walk(s.layout);
    const pidx=panes.findIndex(r=>r.id===this.focused);
    if(pidx<0)return null;
    const pn=panes[pidx];
    const tidx=pn.tabs.findIndex(t=>t.id===this.paneTab(pn));
    if(tidx<0)return null;
    return `W${sidx+1}.P${pidx+1}.T${tidx+1}`;
  },
  updateCwd(){
    const p=this.focusedTerminal();if(!p)return;
    apiGet('/api/cwd',{query:{tool:p.id}}).then(r=>{
      if(!r.data) return;
      this.cwd=r.data.cwd;
      this.updateStatusBar();
    });
  },
  _renderStatusBarSettings(){
    const el=document.getElementById('sb-settings');if(!el)return;
    el.innerHTML='';
    /**
     * POLL_INTERVAL_SETTINGS_SRS FR-PIS-22: **`갱신 주기` 행이 여기서 빠졌다.**
     *
     * `Polling` 탭으로 옮겼다 (D-2) — 같은 값의 손잡이가 두 자리에 있으면 어느
     * 쪽이 진실인지 화면이 말하지 않는다. 이 패널에 남는 것은 **무엇을 보일지**
     * 뿐이고, **얼마나 자주 물을지**는 주기의 것이다.
     *
     * `_startStatsPoll` 을 다시 부르던 자리도 함께 사라졌다: 주기를 함수로 주므로
     * (FR-PIS-13) 재무장 한 줄이 그 일을 하고, 그쪽은 **발화하지 않는다**.
     */
    // Item toggles
    for(const[k,v]of Object.entries(STATUS_ITEMS)){
      const row=document.createElement('div');row.className='sbs-row';row.dataset.item=k;
      const label=document.createElement('span');label.textContent=v.label;
      // FR-CMP-20·21: 알약은 킷의 것이다. 종전에는 입력을 숨기고(`opacity:0`)
      // 형제 `<span class="slider">` 가 알약을 그렸다 — 그 대역이 있으면 킷의
      // `:checked` 파생이 닿지 않는다. 입력이 스스로 그리므로 대역을 걷는다.
      const inp=document.createElement('input');
      inp.type='checkbox'; inp.className='ui-switch'; inp.checked=!!statusBar[k];
      inp.addEventListener('change',()=>{statusBar[k]=inp.checked;this.saveSettings();this.updateStatusBar()});
      row.appendChild(label);row.appendChild(inp);
      el.appendChild(row);
    }
  },
});
