/**
 * Remote Terminal — 창 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * 돌아갈 자리·탭 이름의 출처·창 더하기·지우기·닫기 되돌리기·창 전환. App 은 이것을 `layout` 으로 든다
 * (REFACTOR3_FE_APPCTL_SRS 9i-1, 옛 `app-layout.js` 의 앞쪽). 탭 더하기는 부품 `LayoutTabAdd`(`layout-tab-add.js`)
 * `.tabAdd`, 탭 닫기·전환·분할·사이드바는 부품 `LayoutTabOps`(`layout-tab-ops.js`) `.tabOps` 다. 9i-2 의 부품 다섯 —
 * 도킹 `.dock`(`layout-dock.js`) · 끌어 놓기 `.dnd`(`layout-dnd.js`) · 창 그룹 `.groups`(`layout-groups.js`) · 받은 워크스페이스의
 * 정규화·활성 창·프리셋 `.winState`(`layout-window-state.js`) · 닫은 탭 다시 열기 `.reopen`(`layout-tab-reopen.js`).
 * 돌아갈 창 `_lastPlainWindow`·`_lastEditorWindow`·`mPaneIdx` 는 App 에 남고 쓰기는 이 묶음만 한다(§2.2 A/9i).
 *
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
class LayoutController extends Controller {
  constructor(app){
    super(app);
    this._winUndo=null; // 닫은 창의 유예 하나 (WINDOW_CLOSE_UNDO_SRS FR-WCU-6)
    this.tabAdd=new LayoutTabAdd(app);
    this.tabOps=new LayoutTabOps(app);
    this.dock=new LayoutDock(app);
    this.dnd=new LayoutDnd(app);
    this.groups=new LayoutGroups(app);
    this.winState=new LayoutWindowState(app);
    this.reopen=new LayoutTabReopen(app);
  }

  /**
   * RELOAD_CONTINUITY_SRS FR-RLC-6·10: 사이드바 탭이 **돌아갈 창**을 적는다.
   *
   * 자리가 sessionStorage 인 이유는 이 값이 `activeWindow`·`focusedPanes`·`slots`
   * 와 같은 범주 — "이 브라우저 탭이 보던 것" — 이기 때문이다 (SRS §2.3).
   * localStorage 에 두면 두 탭이 같은 키를 번갈아 덮어 서로의 복귀 자리를 흔든다.
   *
   * 저장이 막힌 환경(사생활 모드)에서는 메모리에만 남는다 — 사이드바의 편의가
   * 화면을 세우지 못하게 해서는 안 된다.
   */
  _rememberReturn(kind,id){
    if(kind==='plain') this.app._lastPlainWindow=id; else this.app._lastEditorWindow=id;
    PrefStore.session.set(RETURN_WINDOW_KEY[kind],id);
  }

  /**
   * FR-RLC-8: 기억을 되살린다. `activeWindow`·`focusedPanes` 와 **같은 블록**에서
   * 불린다 (app.js) — 셋 다 같은 성질이고, 흩어 두면 하나만 고쳐진다.
   *
   * 지금 워크스페이스에 없는 창 id 는 버린다. 없는 창으로 돌아갈 수는 없으며,
   * 그때의 동작은 종전과 같은 폴백이다 (FR-RLC-9).
   */
  _restoreReturn(){
    const has=id=>!!id&&this.app.ws.windows.some(s=>s&&s.id===id);
    for(const kind of Object.keys(RETURN_WINDOW_KEY)){
      const id=PrefStore.session.get(RETURN_WINDOW_KEY[kind]);
      if(!has(id)) continue;
      if(kind==='plain') this.app._lastPlainWindow=id; else this.app._lastEditorWindow=id;
    }
  }

  // 창 사이드바 드래그 재배치. drop(즉시) 1순위 + dragend 폴백, done 으로 중복 커밋 차단.
  // 식별자(id)로 원본/대상을 찾아 splice 후 인덱스 이동에 안전. 대상 미존재(끝 너머)면 맨 끝으로.
  // ── 탭 이름의 출처 (CONVENIENCE_SRS 묶음 N) ──

  // FR-TAN-2: 사용자·에이전트가 명시적으로 준 이름이다. 자동 갱신 대상에서
  // 빠진다 (FR-TAN-15).
  _tabToManual(tab){
    if(tab) tab.nameSource=NAME_SOURCE_MANUAL;
  }

  // FR-TAN-21/22: 자동으로 되돌린다. 이름도 기본값으로 함께 돌린다 — 되돌린
  // 탭에 전경 프로그램이 없으면 `Shell` 이어야 하고(FR-TAN-12), 예전 수동
  // 이름이 남아 있으면 그 상태를 표현할 방법이 없다.
  //
  // `nameSource` 키를 지우는 것은 저장을 줄이려는 것이 아니라, auto 가
  // "출처가 없다"는 뜻이기 때문이다 — `tabNameSource` 가 같은 값을 낸다.
  _tabToAuto(tab){
    if(!tab) return;
    delete tab.nameSource;
    tab.name=TAB_NAME_DEFAULT;
  }

  /**
   * 탭 이름 인라인 편집. 창 이름(`rename`)과 갈라져 있는 이유는 **빈 문자열의
   * 뜻이 다르기** 때문이다 — 탭에서는 자동 복귀 명령이고(FR-TAN-21), 창에는
   * 그런 개념이 없어 지금처럼 취소로 남는다.
   */
  renameTab(tab, el){
    const old=tab.name;
    const input=document.createElement('input');
    input.type='text'; input.value=old; input.className='rename-input';
    el.replaceWith(input); input.focus(); input.select();
    const done=()=>{
      const v=input.value.trim();
      // FR-TAN-21: 비워서 확정하면 자동으로 돌아간다. 지금까지 빈 이름은 그냥
      // 거부돼 동작이 비어 있었고, 여기에 뜻을 준다.
      if(!v){ this._tabToAuto(tab); this.app.save() }
      // FUI-18: 만들 때와 **같은 상한**이다. 여기가 그 상한의 우회로였다.
      else if(v!==old){ tab.name=clampEntityName(v); this._tabToManual(tab); this.app.save() }
      this.app.render();
    };
    input.addEventListener('blur', done, {once:true});
    input.addEventListener('keydown', e=>{
      if(e.key==='Enter'){e.preventDefault();input.blur()}
      if(e.key==='Escape'){input.value=old;input.blur()}
    });
  }

  /**
   * FR-CLS-1: 창을 닫은 뒤 갈 일반 창. `removedIdx` 는 방금 지운 자리이며 그
   * 자리에 가장 가까운 일반 창을 고른다 — 목록에서 눈이 있던 곳 근처다.
   * 일반 창이 없으면 null 이고, 그때의 처리는 호출자의 몫이다 (FR-CLS-2).
   */
  _nextActiveWindow(removedIdx){
    const arr=this.app.ws.windows;
    // FR-EDT-45: Editor 창도 대상이 아니다 — 창 하나 닫았을 뿐인데 편집기
    // 화면에 떨어지면 안 된다 (Git 창을 거르는 것과 같은 근거).
    const plain=s=>s&&!this.app.git.isKindWin(s);
    for(let d=0;d<arr.length;d++){
      const a=arr[removedIdx+d], b=arr[removedIdx-d];
      if(plain(a)) return a;
      if(plain(b)) return b;
    }
    return null;
  }

  /**
   * WORKBENCH_REVIEW_SRS FR-WBR-20 (UX_REVISION_SRS FR-CWD-1 폐기).
   *
   *   이전 동작: 새 창의 첫 도구가 **포커스 분할 칸의 cwd 를 승계**했다
   *   새  동작: 승계하지 않는다 — 호출자가 준 것이 없으면 **홈**이다
   *   이유:     사용자 지시("터미널은 홈에서 시작하는 것이 맞다"). 새 창은
   *             "새로 시작한다" 는 뜻이고, 지금 일하던 자리에서 하나 더 여는
   *             것은 새 탭·분할이다 — 그쪽의 승계는 그대로다 (FR-WBR-21)
   *
   * 명시적 지정은 그대로 이긴다 (FR-CWD-3) — `opts.cwd` 와 `opts.cwdTool` 이다.
   * `dmctl new-window --cwd` 가 그 길로 온다 (FR-WBR-23).
   */
  async _mkWindow(opts={}){
    const sandbox=(typeof opts.sandbox==='string'&&opts.sandbox)?opts.sandbox:'';
    // FR-SBX-40: 샌드박스 창은 **고른 폴더만** 쓴다.
    const cwd=opts.cwd||null;
    // FR-CWD-3: `cwdTool` 은 그 도구의 cwd 를 서버가 풀어 준다
    // (`/api/tools?cwdTool=`) — 브라우저는 경로를 모른 채 넘긴다.
    const refTool=sandbox?null:(opts.cwdTool||null);
    // UX_BATCH6_SRS FR-SBM-3: 선택창에서 고른 작업 방식. 값의 출처는 서버가 보낸
    // 프로파일 목록 하나뿐이므로 화면은 이름을 거르지 않는다 (SERVER_DRIVEN_ACTIONS_SRS K-i).
    const work=typeof opts.sandboxWork==='string'?opts.sandboxWork:'';
    // FR-SBX-10: 창 id 를 도구보다 **먼저** 만든다. 순서가 반대면 첫 도구가
    // 자기 창을 모른 채 떠서, 샌드박스 창인데 첫 탭만 호스트에서 돈다.
    const wid=newEntityId();
    const p=await this.app.tool.life._newTool(cwd, cwd?null:refTool, {id:wid,sandbox,sandboxWork:sandbox?work:''});
    const r=newEntityId(),tabId=newEntityId();
    const name=clampEntityName(typeof opts.name==='string'&&opts.name?opts.name:'Window');
    const s={
      id:wid,name,
      // `opts.name` 은 **창** 이름이다 — 안의 탭은 이름을 받은 적이 없으므로
      // auto 로 태어난다 (FR-TAN-1). `nameSource` 를 적지 않는 것이 auto 다.
      layout:{type:'pane',id:r,tabs:[{id:tabId,name:TAB_NAME_DEFAULT,type:TAB_TYPE_TERMINAL,toolId:p.id}],activeTab:tabId}
    };
    // FR-SBX-18: 선택 필드다. 일반 창에는 키 자체를 두지 않는다.
    if(sandbox) s.sandbox=sandbox;
    // FR-SBM-3: 창의 것이다 — 이 창에 뒤로 생기는 탭도 같은 컨테이너에 들어간다.
    if(sandbox&&work) s.sandboxWork=work;
    // SANDBOX_PICK_COPY_SRS FR-SPK-21·22: 이 창의 작업 폴더가 **복사본**이라는
    // 사실. 컨테이너 안의 변경이 호스트로 돌아오지 않는다는 것은 창을 여는
    // 순간에만 말하고 끝낼 성질이 아니다 — 사용자는 며칠 뒤에도 그 창에서
    // 일한다. 폴더를 실제로 받은 창에만 적는다 (복사한 것이 없으면 뜻이 없다).
    if(sandbox&&opts.sandboxCopy===true&&cwd) s.sandboxCopy=true;
    this.app.ws.windows.push(s);
    // REMOTE_SESSION_TAB_CREATE_SRS FR-RST-2: keepFocus 면 창은 사이드바에만
    // 추가 — activeWindow/focused 무변화 (백그라운드 잡 컨테이너 패턴).
    if(!opts.keepFocus){
      this.app._activateWindow(s.id);
      // FR-WSL-54: **여는 경로는 포커스 칸에 연다** — 창을 만드는 것도 그 경로다.
      //
      // 화면은 `ws.activeWindow` 가 아니라 **칸이 가리키는 창**을 그린다
      // (`slotWindow`). 이 한 줄이 없던 동안 모델만 새 창이 되고 화면은 옛 창을
      // 그대로 보였다 — 칸이 나뉘어 있을 때만 드러났고, 그대로 접수됐다
      // ("생성과 동시에 이동해야 하는데 이동하지 않는다", 2026-09-11).
      //
      // `switchWindow` 가 밟는 걸음과 같다. 다른 칸은 건드리지 않는다.
      this.app._slotOnSwitch(s.id);
      this.app.setFocusState(r, s);
      this.app._focusWindow(s.id);
    }
    // Fire-and-forget save: keeps the UI snappy. Awaiting here would block
    // render on the PUT roundtrip (see split/addTab which already use
    // this pattern).
    this.app.save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-6/7: 생성한 엔터티 id 반환 (echo 용).
    return {win:s.id, pane:r, tab:{uuid:tabId, toolId:p.id}};
  }

  async addWindow(opts){await this.app._mkWindow(opts||{});this.app.render()}

  /**
   * M9_SRS FR-M9-4: `opts.force` 는 **이미 물었다**는 뜻이다 (탭 쪽 FR-RUN-6 과
   * 같은 규약). `dmctl close-window --force|--background` 가 그 길로 오며, 답을
   * 이미 준 요청이 확인창을 만나면 그 자리에서 멎는다.
   *
   * `opts.keepTool` 은 그 답이 "백그라운드로 보내기" 일 때다 — 도는 도구를 죽이지
   * 않고 배경으로 옮긴다.
   *
   * REFACTOR3_FE_REST3_SRS FR-FR3-8·9 (FC-05): 확인 둘 → 도구 처리 → 빼기 → 되돌리기 → 슬롯 → 다음 창의 순서다.
   */
  async delWindow(sid,opts={}){
    const i=this.app.ws.windows.findIndex(s=>s.id===sid);
    if(i<0) return;
    // FR-WSL-6: 슬롯 정리는 창을 실제로 지우기 **전에** 예약해 두지 않는다 —
    // 아래 확인 대화에서 취소될 수 있기 때문이다. 지운 뒤에 부른다 (아래).
    const s=this.app.ws.windows[i];
    if(!await this._delWinDirtyOk(s,opts)) return;
    const pids=allPids(s.layout);
    const ans=await this._delWinAsk(pids,opts);
    if(!ans) return;
    this._delWinTools(pids,ans.asked,ans.keep);
    this.app.ws.windows.splice(i,1);
    if(!ans.asked) this._winUndoArm(s,i,pids);
    // FR-WSL-6: 실제로 지워진 뒤에 슬롯을 정리한다 — 위의 확인 대화에서
    // 취소되면 여기 도달하지 않는다.
    this.app._slotOnWindowGone(sid);
    await this._delWinAfter(sid,i);
  }

  /**
   * UX_BATCH8_SRS FR-CLG-1·3·4: **저장하지 않은 편집을 먼저 묻는다.** 계속하면 참이다.
   *
   *   이전 동작: 실행 중인 프로세스만 물었다. 편집기가 dirty 여도 창이 그대로
   *             사라지고, 그 순간 탭 id 가 없어져 편집기와 모델이 함께 버려진다
   *   새  동작: 탭 닫기와 같은 팝업을 같은 문구로 띄운다 (`app-layout` 의 dirty
   *             가드와 한 벌이다)
   *   이유:     접수 — "수정된 파일 닫을 때 저장하고닫기/그냥닫기/취소 팝업".
   *             그 팝업은 탭 닫기에 이미 있었고 이 길에만 없었다
   *
   * 프로세스 확인보다 **앞에** 선다 (FR-CLG-4). 여기서 취소하면 창이 남으므로
   * 도구를 어떻게 할지 물을 일 자체가 없다. 워크스페이스는 답을 받은 뒤에야
   * 바뀐다 (NFR-2) — `delWindow` 의 `findIndex` 는 읽기일 뿐이다.
   */
  async _delWinDirtyOk(s,opts){
    if(!(this.app.editor.sync._edWinDirty&&this.app.editor.sync._edWinDirty(s)&&!opts.force)) return true;
    const r=await this.app.tool._confirmClose(CLOSE_DIRTY_MSG,{saveBtn:true});
    if(!r) return false;
    // FR-EXC-13a: 하나라도 저장하지 못했으면 창을 닫지 않는다 — 탭 하나의
    // 경합으로 창 전체의 편집을 잃을 수는 없다.
    if(r==='save'&&!await this.app.editor.sync._edWinSaveDirty(s)) return false;
    return true;
  }

  /**
   * 프로세스 확인. 취소면 `null`, 아니면 `{asked, keep}` — `asked` 는 busy 인 도구가 있었는가(확인창이 뜨는
   * 사유), `keep` 은 배경으로 살릴 pid 집합이다.
   *
   * FR-BG-4/4a: 일괄 전환 대상은 busy 인 도구만이다. 확인창이 뜨는 사유가
   * "실행 중인 프로세스"이고, 한가하면 그냥 종료한다는 FR-BG-1 의 기본과
   * 일관되어야 한다 — 한가한 셸까지 보존하면 백그라운드가 쓰레기로 찬다.
   */
  async _delWinAsk(pids,opts){
    const busyMap=await this.app.tool._toolsBusy(pids);
    const busy=pids.filter(pid=>!!busyMap[pid]);
    const keep=new Set();
    // FR-M9-4: 답을 이미 받은 요청은 묻지 않는다. `keepTool` 이면 그 답이
    // "백그라운드" 이므로 busy 인 도구를 살린다 — 확인창의 `background` 와 같은 집합이다.
    const asked=busy.length>0;
    if(asked&&!opts.force){
      const r=await this.app.tool._confirmClose(t('core.q_close_window'),
        {bgBtn:true,bgLabel:t('core.bg_running_only')});
      if(!r) return null;
      if(r==='background') for(const pid of busy) keep.add(pid);
    }else if(asked&&opts.keepTool){
      for(const pid of busy) keep.add(pid);
    }
    return {asked,keep};
  }

  /**
   * WINDOW_CLOSE_UNDO_SRS FR-WCU-1·3·5 (`UX-2`): **묻지 않은 닫기는 되돌릴 수 있다.**
   *
   *   이전 동작: 한가한 창은 곧바로 `_kill` — 확인도 되돌리기도 없었다
   *   새  동작: 확인창이 뜨지 않은 창의 도구는 죽이지 않고 **백그라운드**로
   *             보낸 뒤 유예(`WINDOW_CLOSE_UNDO_MS`)를 연다. Undo 가 되돌리고,
   *             만료가 죽인다 (`_winUndoFinal`)
   *   이유:     `×` 는 hover 에서만 보이는 16px 이고 `Delete` 키 길도 생겼다
   *             (FR-A11Y-16). 확인창 대신 Undo 인 이유는 한가한 셸을 닫는 일이
   *             거의 언제나 뜻한 일이어서다 — 되돌릴 수 있으면 묻지 않아도 된다
   *
   * 확인을 **지난** 닫기는 종전대로 최종이다 (D-WCU-2) — 안전망은 길마다 하나.
   * `--force`·`--background` 로 답을 미리 준 것도 같다 — 사용자의 결정은 그 명령을
   * 친 순간에 있었다 (FR-M9-4).
   */
  _delWinTools(pids,asked,keep){
    if(!asked){
      this._winUndoFinal();
      for(const pid of pids) this.app.tool.life._setToolBackground(pid,true);
      this.app.tool.life._bgRefresh();
      return;
    }
    for(const pid of keep) this.app.tool.life._setToolBackground(pid,true);
    if(keep.size) this.app.tool.life._bgRefresh();
    // FR-BG-4b: backgroundCapable 이 아닌 도구는 전환 대상이 아니라 종료된다.
    for(const pid of pids) if(!keep.has(pid)) this.app.tool.life._kill(pid);
  }

  // 창을 뺀 뒤 — 빈 워크스페이스·다음 활성 창·포커스·그리기·저장.
  async _delWinAfter(sid,i){
    if(!this.app.ws.windows.length){await this.app._mkWindow();this.app.render();return}
    if(this.app.ws.activeWindow===sid){
      // UX_REVISION_SRS FR-CLS-1: 다음 활성 창은 **일반 창**이다. 인덱스로만
      // 고르면 Git 창이 활성이 되고, 그러면 사이드바 탭이 Git 으로 따라간다
      // (FR-SBT-14) — 창 하나 닫았을 뿐인데 Git 화면에 떨어진다.
      //
      // Git 창 자신을 닫은 경우는 `_gitCloseWindow` 가 이미 복귀 대상으로
      // 옮겨 놓았다 (FR-CLS-3). 그 경로도 여기 규칙과 같은 곳으로 간다.
      const next=this._nextActiveWindow(i);
      if(!next){
        // FR-CLS-2: 일반 창이 남지 않았다. Git 창만 남기고 사용자를 그 안에
        // 가두지 않는다 — 새 창을 만들고 그리로 간다.
        await this.app._mkWindow();
        this.app.render(); this.app.save();
        return;
      }
      this.app._activateWindow(next.id);
    }
    const a=this.app.tool.life.aw();
    if(a&&a.layout){
      const next=(a.focusedPane&&findPane(a.layout,a.focusedPane))?a.focusedPane:firstPane(a.layout)?.id||null;
      this.app.setFocusState(next, a);
    } else this.app.focusClear();
    // Render first, save in background (matches split/addTab/closeTab).
    this.app._focusWindow(this.app.ws.activeWindow);
    this.app.render();
    this.app.save();
  }

  // ── 창 닫기의 되돌리기 (WINDOW_CLOSE_UNDO_SRS FR-WCU-1~7) ──

  /**
   * 유예를 연다. **하나만 산다** (FR-WCU-6) — `delWindow` 가 앞선 것을 먼저
   * 최종으로 만든다. 진입점은 `Toast` 의 동작 버튼이라 라이브 리전을 지난다
   * (FR-WCU-2 / FR-A11Y-19). 타이머는 우리 것이다 — 토스트의 것과 길이가 같지만
   * 만료가 해야 할 일(죽이기)은 토스트가 모른다.
   */
  _winUndoArm(win,index,pids){
    const h=Toast.show(WINDOW_CLOSE_UNDO_TEXT.replace('%s',win.name||''),'',WINDOW_CLOSE_UNDO_MS,{
      id:'win-undo', cls:'win-undo-toast',
      actions:[{label:WINDOW_CLOSE_UNDO_LABEL,title:WINDOW_CLOSE_UNDO_TITLE,
                onClick:()=>this._winUndoRun()}],
    });
    const timer=this.app.timers.after(WINDOW_CLOSE_UNDO_MS,()=>this._winUndoFinal(),
      {owner:'app',label:'win-undo'});
    this._winUndo={win,index,pids,close:h.close,timer};
  }

  /**
   * FR-WCU-4: 만료. **지금 어느 창에도 없는 도구만** 죽인다 — 유예 동안 백그라운드
   * 목록에서 되살린 도구는 다른 창의 것이 됐다 (D-WCU-1).
   */
  _winUndoFinal(){
    const u=this._winUndo; if(!u) return;
    this._winUndo=null;
    if(u.timer) u.timer.stop();
    u.close();
    const referenced=new Set(this.app.ws.windows.flatMap(w=>allPids(w.layout)));
    for(const pid of u.pids) if(!referenced.has(pid)) this.app.tool.life._kill(pid);
    this.app.tool.life._bgRefresh();
  }

  /**
   * FR-WCU-7 / D-WCU-3: 창 객체를 **같은 자리**에 되돌린다. 도구 인스턴스는
   * `_kill` 을 지나지 않았으므로 살아 있고 다음 render 가 붙인다.
   */
  _winUndoRun(){
    const u=this._winUndo; if(!u) return;
    this._winUndo=null;
    if(u.timer) u.timer.stop();
    u.close();
    const at=Math.min(u.index,this.app.ws.windows.length);
    this.app.ws.windows.splice(at,0,u.win);
    // FR-WGR-13: 되돌린 창은 원래 그룹으로 간다 — 그 사이 그룹이 지워졌으면 풀린다.
    this.groups._groupsNormalizeWs(this.app.ws);
    for(const pid of u.pids) this.app.tool.life._setToolBackground(pid,false);
    this.app.tool.life._bgRefresh();
    this.app._activateWindow(u.win.id);
    const next=(u.win.focusedPane&&findPane(u.win.layout,u.win.focusedPane))?u.win.focusedPane:firstPane(u.win.layout)?.id||null;
    this.app.setFocusState(next,u.win);
    this.app._focusWindow(u.win.id);
    this.app.render();
    this.app.save();
  }

  switchWindow(sid){
    if(this.app.ws.activeWindow===sid){
      if(this.app.isMobile && this.app.drawerOpen) this.app.mobile._toggleDrawer(false);
      return;
    }
    const cur=this.app.tool.life.aw();if(cur)cur.focusedPane=this.app.focused;
    // FR-GIT-185: Open File 이 돌아갈 창을 기억한다 — 규칙이 하나여야 "어디에
    // 열렸는지 모르겠다"가 없다 (O15).
    // RELOAD_CONTINUITY_SRS FR-RLC-6·7: 그 기억은 새로고침을 건넌다. 사이드바
    // 탭 자체는 이미 건너는데(localStorage `sidebarTab`) 그 탭이 **돌아갈 자리**는
    // 건너지 못해, 새로고침 뒤 Windows 탭이 늘 첫 창으로 갔다 (SRS §2.2).
    // 적는 자리는 여기 하나다 — 두 벌로 만들면 한쪽만 갱신된다.
    if(cur&&!this.app.git.isKindWin(cur)) this._rememberReturn('plain',cur.id);
    this.app._activateWindow(sid);
    // WINDOW_SLOTS_SRS FR-WSL-54: 포커스 슬롯이 이 창을 받는다. 다른 슬롯은
    // 건드리지 않는다 — 그것이 두 칸을 나란히 두는 이유다.
    this.app._slotOnSwitch(sid);
    // FR-EDT-7: Editor 탭이 돌아갈 창을 같은 규약으로 기억한다 — 들어가는
    // 순간에 적는다. 나갈 때 적으면 한 번도 떠난 적 없는 창을 기억하지 못한다.
    if(this.app.editor.isEditorWin(this.app.tool.life.aw())) this._rememberReturn('editor',sid);
    const a=this.app.tool.life.aw();
    if(a&&a.layout){
      const next=(a.focusedPane&&findPane(a.layout,a.focusedPane))?a.focusedPane:firstPane(a.layout)?.id||null;
      this.app.setFocusState(next, a);
    } else this.app.focusClear();
    this.app.mPaneIdx=0;
    if(this.app.isMobile && this.app.drawerOpen) this.app.mobile._toggleDrawer(false);
    this.app._focusWindow(sid);
    // FR-GIT-22 + FR-RTU-62: 창 전환은 폴링 조건의 재평가 시점이다. **모든
    // 패널**이 다시 본다 — 떠난 창의 패널이 타이머를 든 채 남으면 아무도 보지
    // 않는 저장소를 계속 폴링한다.
    this.app.git.surfaces._gitRescheduleAll();
    this.app.save(); this.app.render();
  }
}

// 바깥이 부르는 이름 — `app.js`(부팅의 복원·창 단축키)·`tool-cmd.js`·`layout-dnd.js`·`layout-window-state.js`(프리셋)·편집기·`ui/`·e2e·계약.
Controller.delegate(App,'layout',['_restoreReturn','_tabToManual','_tabToAuto','renameTab','_mkWindow','addWindow','delWindow',
  'switchWindow']);
