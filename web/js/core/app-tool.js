/**
 * Remote Terminal — App 도구 생명주기 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 12개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  async _isToolBusy(toolId){
    const r=await apiGet(`/api/tools/${toolId}/busy`);
    return !!(r.data&&r.data.busy);
  },

  // OPTIMIZE_REFACTOR_SRS FR-OPT-2-4: 도구 N개를 요청 한 번으로 묻는다. 답하지 못하면
  // 빈 답이다 — 단건이 실패에 false 를 내던 것과 같다.
  async _toolsBusy(ids){
    if(!ids.length) return {};
    const r=await apiGet(`/api/tools/busy?ids=${ids.map(encodeURIComponent).join(',')}`);
    return (r.data&&r.data.busy)||{};
  },

  // FR-SBX-20: 도구 기동 실패의 사유를 사용자에게 보인다. 확인창과 같은
  // 껍데기를 쓰되 선택지가 없다 — 알릴 뿐 되돌릴 것이 없다.
  //
  // 본문을 textContent 로 넣는 것이 요점이다. 여기 오는 문자열은 서버가 만든
  // 오류 메시지이며, innerHTML 에 끼우면 그 내용이 마크업으로 해석된다.
  // (`_confirmClose` 가 종전에 그랬고, 지금은 같은 규약으로 수렴했다.)
  _notify(msg){
    // FR-OPT-11-5 (FEC-27): 골격·닫는 길·접근성 계약은 `UIKit.ask` 가 갖는다. 닫는 키는
    // `Esc` 와, 포커스된 확인 버튼을 브라우저가 누르는 `Enter` 다 (FR-PDA-2).
    const body=document.createElement('div'); body.className='confirm-msg notify-msg ui-scroll';
    body.textContent=msg;
    UIKit.ask({body,labelledBy:body,label:t('core.ok'),
      actions:[{label:t('core.ok'),kind:'primary',cls:'confirm-ok',tip:TIP_NOTIFY_OK}]});
  },

  /**
   * SANDBOX_PICK_COPY_SRS NFR-SPK-2: 복사가 도는 동안 그 사실을 보인다.
   *
   * `_notify` 를 쓰지 않는다 — 그쪽은 확인 버튼이 있는 모달이라 사용자가 닫아야
   * 사라지고, 진행은 **끝나면 스스로 사라져야** 한다. 상한 안(2 GiB)의 복사도
   * 수십 초가 걸릴 수 있는데 그동안 화면이 아무 말도 하지 않으면 사용자는
   * 고장으로 읽는다.
   *
   * 닫는 함수를 돌려준다 — 여는 쪽이 끝나는 시점을 안다.
   */
  _sbxProgress(msg){
    // FR-A11Y-19 (`UX-8`): 진행도 `Toast` 를 지난다 — 알림의 자리와 라이브 리전이
    // 한 곳이어야 한다. NFR-SPK-2 대로 **자동 소멸은 주지 않는다**(`ms:0`):
    // 끝내는 것은 부르는 쪽이고, 돌려주는 것이 그 손잡이다.
    return Toast.show(msg,'',0,{cls:'sbx-progress'}).close;
  },

  /**
   * 컨테이너 런타임의 지금 상태 (UX_BATCH5_SRS FR-SRT-1·5).
   *
   * **프로파일보다 먼저 묻는다.** 프로파일 목록은 서버가 뜰 때 바이너리가 있었는지만
   * 말하므로, 데몬이 죽어도 정상 목록이 온다 (§2.3 실측) — 그것에 업으면 실패가
   * 창을 만드는 순간까지 미뤄지고 사용자에게는 "버튼이 고장났다" 로 보인다.
   *
   * 조회 자체가 실패하면 `null` 이다. 그때는 갈래를 가르지 않고 종전 흐름으로
   * 간다 — 서버에 닿지 못하는 것은 런타임의 문제가 아니고, 여기서 막으면 멀쩡한
   * 환경에서 샌드박스를 못 쓰게 된다.
   */
  async _sbxRuntime(){
    const r=await apiGet('/api/sandbox/runtime');
    return r.ok?r.data:null;
  },

  /**
   * 런타임이 없거나 죽었을 때의 한 자리 (FR-SRT-6·7).
   *
   * 두 상태가 한 함수인 이유는 껍데기와 규약이 같기 때문이다 — 다른 것은 문장과
   * 버튼뿐이고, 그것을 두 함수로 가르면 닫기·Esc·복사가 두 벌이 된다.
   *
   * `true` 를 돌려주면 **하려던 일을 이어도 된다**는 뜻이다 (FR-SRT-7): 기동이
   * 끝나 `ok` 가 됐을 때만 그렇다. 닫거나 실패하면 `false` 다.
   *
   * FR-SRT-8: 기존 확인창 껍데기를 쓰고, 본문은 `textContent` 로 넣는다 — 여기
   * 오는 문자열은 런타임이 만든 진단이라 마크업으로 해석되면 안 된다.
   */
  _sbxRuntimeModal(st){
    const missing=st.state===SBX_RT_MISSING;
    // FR-OPT-11-5 (FEC-27): 본문만 여기서 세우고 골격은 `UIKit.ask` 가 갖는다.
    const body=document.createDocumentFragment();
    const title=document.createElement('div'); title.className='confirm-msg';
    title.textContent=missing?SBX_RT_TITLE_MISSING:SBX_RT_TITLE_STOPPED;
    body.appendChild(title);

    const msg=document.createElement('div'); msg.className='sbx-rt-msg';
    // 실행할 수 없는 OS 에서는 "실행할까요" 가 아니라 "직접 실행하세요" 다 (D-5).
    msg.textContent=missing?SBX_RT_MSG_MISSING
      :(st.startTryable?SBX_RT_MSG_STOPPED:SBX_RT_MSG_MANUAL);
    body.appendChild(msg);

    // 보일 명령은 상태가 정한다 — 설치인지 기동인지.
    const cmd=missing?(st.installCommand||''):(st.startCommand||'');
    // 실행 버튼이 있으면 명령을 함께 보이지 않는다: 누를 것이 둘이면 어느 쪽이
    // 진짜인지 말할 수 없다. 실행할 수 없을 때에만 칠 것을 준다.
    const showCmd=!!cmd&&(missing||!st.startTryable);
    if(showCmd){
      const row=document.createElement('div'); row.className='sbx-rt-cmdrow';
      const code=document.createElement('code'); code.className='sbx-rt-cmd ui-scroll';
      code.textContent=cmd;
      const copy=document.createElement('button');
      copy.type='button'; copy.className='ui-btn ui-btn-sm sbx-rt-copy'; copy.textContent=SBX_RT_COPY;
      copy.addEventListener('click',async()=>{
        // 복사가 막힌 환경(비 HTTPS·권한)에서도 명령은 화면에 남아 있다 —
        // 실패를 알릴 뿐 흐름을 막지 않는다.
        //
        //   이전 동작: `navigator.clipboard.writeText` 하나. secure context
        //             밖에서는 `navigator.clipboard` 가 **아예 없어** 호출이
        //             TypeError 로 던지고 빈 catch 가 그것을 삼켰다 — 버튼을
        //             눌러도 **아무 일이 안 일어난다.** 주석이 "실패를 알릴 뿐"
        //             이라 적었는데 알리지 않았다.
        //   새  동작: 3단까지 내려가고 **성공 여부를 돌려받는다.** 실패하면
        //             글자를 바꾸지 않으므로 눌린 것이 되지 않는다 (FR-STR-16).
        //   이유:     FR-STR-14·15 · FR-ETR-40.
        if(await ClipboardWriter.write(cmd)) copy.textContent=SBX_RT_COPIED;
      });
      row.appendChild(code); row.appendChild(copy);
      body.appendChild(row);
    }else if(missing){
      // 명령을 모르는 OS 다. 안내만 남기고 지어내지 않는다.
      const n=document.createElement('div'); n.className='sbx-rt-msg';
      n.textContent=SBX_RT_NO_CMD; body.appendChild(n);
    }
    if(missing){
      const rs=document.createElement('div'); rs.className='sbx-rt-restart';
      rs.textContent=SBX_RT_MSG_RESTART;
      body.appendChild(rs);
      const docs=document.createElement('div'); docs.className='sbx-rt-docs';
      // 바깥 링크를 열지 않는다 — 글자로 둔다 (FR-SRT-6).
      docs.textContent=SBX_RT_DOCS;
      body.appendChild(docs);
    }

    // 진행과 사유가 함께 사는 자리. 닫히지 않으므로 읽을 시간이 있다.
    const note=document.createElement('div'); note.className='ui-notice sbx-rt-note ui-scroll';
    note.hidden=true;
    body.appendChild(note);

    const canStart=!missing&&st.startTryable;
    let start=null, done=null;
    const actions=[];
    if(canStart){
      actions.push({label:SBX_RT_START,kind:'primary',cls:'confirm-ok sbx-rt-start',keepOpen:true,
        onClick:()=>this._sbxRuntimeStart(start,note,done)});
    }
    actions.push({label:SBX_RT_CLOSE,cls:'confirm-cancel',value:false});
    // FR-KIT-24·25: 이름은 머리(`.confirm-msg`)가 준다.
    return UIKit.ask({body,labelledBy:title,label:title.textContent,boxCls:'sbx-rt',
      actions,escValue:false,onOpen:(m,fin)=>{
        done=fin;
        m.el.dataset.state=st.state;
        start=m.foot.querySelector('.sbx-rt-start');
      }});
  },

  /**
   * 기동 한 번 (FR-SRT-3·4·7).
   *
   * `started:true` 는 명령이 오류 없이 반환됐다는 뜻일 뿐이므로 **그것으로 끝내지
   * 않는다** — 데몬이 떴는지는 상태를 다시 물어 확정한다. 그동안 모달은 닫히지
   * 않는다: 닫으면 진행도 사유도 읽을 자리가 사라진다 (FR-GIT-175 와 같은 근거).
   */
  async _sbxRuntimeStart(btn,note,cleanup){
    btn.disabled=true;
    note.hidden=false; note.textContent=SBX_RT_STARTING;
    let res=null;
    const rt=await apiPost('/api/sandbox/runtime/start');
    if(rt.ok) res=rt.data;
    if(!res||!res.started){
      btn.disabled=false;
      note.textContent=SBX_RT_START_FAIL+((res&&res.detail)?' — '+res.detail:'');
      return;
    }
    // NFR-SRT-2: 2초 주기, 60초 상한. 데몬이 뜨면 그 자리에서 이어진다.
    const until=Date.now()+SBX_RT_POLL_MAX_MS;
    for(;;){
      await this.timers.sleep(SBX_RT_POLL_MS,{owner:'app',label:'sbx-wait'});
      const st=await this._sbxRuntime();
      if(st&&st.state===SBX_RT_OK){cleanup(true);return}
      if(Date.now()>=until) break;
    }
    btn.disabled=false;
    // 상한을 넘긴 것은 실패와 다르다 — 명령은 돌았고 데몬이 아직 안 떴을 뿐이다.
    note.textContent=SBX_RT_TIMEOUT;
  },

  // 샌드박스 프로파일 선택 (FR-SBX-25). 격리 등급을 함께 보이는 것이 요점이다 —
  // `dev`·`agent` 는 컨테이너 안에서 dmctl 을 쓸 수 있어 호스트 워크스페이스를
  // 조작할 수 있고, 그것을 모른 채 "격리됐다" 고 믿으면 그 믿음이 위험이 된다
  // (FR-SBX-23/24).
  // 최근에 연 작업 폴더. 이 브라우저에만 남는 편의값이라 서버로 보내지 않는다.
  _sbxRecent(){
    const v=PrefStore.local.json(STORE_KEYS.sandboxRecent,[]);
    return Array.isArray(v)?v.filter(Boolean).slice(0,5):[];
  },

  _sbxRemember(path){
    if(!path) return;
    const cur=this._sbxRecent().filter(p=>p!==path);
    cur.unshift(path);
    PrefStore.local.setJson(STORE_KEYS.sandboxRecent,cur.slice(0,5));
  },

  _pickSandbox(list,here){
    // FR-OPT-11-5 (FEC-27): 본문만 여기서 세우고 골격은 `UIKit.ask` 가 갖는다.
    const body=document.createDocumentFragment();
    const msg=document.createElement('div');msg.className='confirm-msg';
    msg.textContent=t('sbx.profile_title');
    body.appendChild(msg);
    let input=null;
    // SANDBOX_PICK_COPY_SRS FR-SPK-3: 작업 폴더 입력은 **언제나** 보인다.
    //
    // 옛 조건(`list.some(p=>p.workspace)`)은 scratch 하나뿐인 환경에서 거짓이라
    // 입력란이 아예 없었고, 그 위의 `mustAsk` 가 창 자체를 띄우지 않았다 —
    // 사용자에게는 "설정창이 안 뜬다" 로 보였다 (§2.1 실측).
    {
      const wrap=document.createElement('div');wrap.className='sbx-workdir';
      const label=document.createElement('label');label.textContent=SANDBOX_WORKDIR_LABEL;
      input=document.createElement('input');
      input.type='text';input.placeholder=SANDBOX_WORKDIR_PLACEHOLDER;
      wrap.appendChild(label);wrap.appendChild(input);
      // 지금 있는 자리는 입력란 바로 오른쪽에 둔다 — 가장 자주 고를 값이고,
      // 입력란과 한 줄에 있어야 "여기에 넣는 것" 임이 보인다.
      //
      // **채워 두지는 않는다.** 기본은 마운트하지 않는 것이고, 넣는 것은
      // 고르는 행위여야 한다 (FR-SBX-40).
      if(here){
        const now=document.createElement('button');
        now.type='button';now.className='ui-btn ui-btn-sm sbx-now';now.textContent=t('sbx.here');now.title=here;
        now.addEventListener('click',()=>{input.value=here;input.focus()});
        wrap.appendChild(now);
      }
      body.appendChild(wrap);

      // 최근에 연 자리는 아랫줄에 모은다. 경로를 매번 타이핑하게 하면 이
      // 창은 절차만 늘리는 자리가 된다.
      const recent=this._sbxRecent().filter(p=>p!==here);
      if(recent.length){
        const bar=document.createElement('div');bar.className='sbx-recent';
        for(const path of recent){
          const b=document.createElement('button');
          b.type='button';b.className='ui-btn ui-btn-sm sbx-recent-item';b.textContent=path;b.title=path;
          b.addEventListener('click',()=>{input.value=path;input.focus()});
          bar.appendChild(b);
        }
        body.appendChild(bar);
      }
    }
    /**
     * UX_BATCH6_SRS FR-SBM-1·2: **작업 방식을 고르는 자리.**
     *
     *   이전 동작: 프로파일이 방식을 고정했고 버튼은 그것을 표기만 했다.
     *             `sandbox.json` 에 dev 를 정의하지 않은 사용자에게는 마운트를
     *             고를 길이 화면 어디에도 없었다 (SRS §2.3)
     *   새  동작: 마운트·복사를 언제나 고른다. 프로파일이 정하는 것은 **기본
     *             선택**뿐이다
     *   이유:     접수 ② — "마운트가 없어도 마운트 선택 가능. 마운트가 없는
     *             마운트 프로파일일 뿐"
     *
     * `none` 인 프로파일을 고르면 방식도 폴더도 **버려진다** (FR-SBM-2 / FR-SPK-6).
     * 이 줄을 프로파일마다 잠그지 않는 이유는 순서다 — 방식을 고르는 것이
     * 프로파일을 고르는 것보다 앞이고, 앞선 선택을 뒤의 선택이 되돌아가 잠그면
     * 창이 손 밑에서 움직인다.
     */
    let work=null;
    const workBtns=new Map();
    {
      const wrap=document.createElement('div');wrap.className='sbx-work-pick';
      const label=document.createElement('label');label.textContent=SANDBOX_WORK_PICK_LABEL;
      wrap.appendChild(label);
      for(const k of SANDBOX_WORK_PICKS){
        const b=document.createElement('button');
        b.type='button';b.className='ui-btn ui-btn-sm sbx-work-opt sbx-work-'+k;b.dataset.work=k;
        b.textContent=SANDBOX_WORK_LABEL[k];b.title=SANDBOX_WORK_TITLE[k]||'';
        b.addEventListener('click',()=>setWork(k));
        workBtns.set(k,b);wrap.appendChild(b);
      }
      body.appendChild(wrap);
    }
    // FR-SBM-5: 고른 것의 결과. 등급 배지와 **다른 자리**여야 한다 — 배지는
    // 프로파일의 것이고(FR-SBM-4) 이 줄은 이번 선택의 것이다.
    const warn=document.createElement('div');warn.className='sbx-work-warn';
    body.appendChild(warn);
    const syncWarn=()=>{
      const on=work===SANDBOX_WORK_MOUNT&&!!(input&&input.value.trim());
      warn.textContent=on?SANDBOX_MOUNT_WARN:'';
      warn.classList.toggle('vis',on);
    };
    const setWork=k=>{
      work=k;
      for(const [key,b] of workBtns) b.classList.toggle('on',key===k);
      syncWarn();
    };
    if(input) input.addEventListener('input',syncWarn);

    let done=null;
    const actions=list.map(p=>{
      // FR-SPK-5 (FR-SBM-1 로 개정): 방식은 이제 **위에서 고른다.** 프로파일이
      // 정하는 것은 기본 선택뿐이므로 버튼에 표기를 겹치지 않는다 — 두 자리가
      // 같은 것을 말하면 어느 쪽이 지금 값인지 알 수 없다.
      const def=p.work||SANDBOX_WORK_NONE;
      const tip=(p.image?p.image+String.fromCharCode(10):'')+
        (p.isolated
          ? t('sbx.isolated_note')
          : t('sbx.not_isolated_note'))+
        String.fromCharCode(10)+(SANDBOX_WORK_TITLE[def]||'');
      // FR-SPK-6 / FR-SBM-2: `none` 인 프로파일에서는 입력한 폴더가 버려진다.
      // 값은 누르는 순간의 입력이라 `value` 가 아니라 `done` 으로 닫는다.
      return {label:p.name,kind:'primary',cls:'confirm-ok sbx-opt',tip,keepOpen:true,
        onClick:()=>done({profile:p.name,
          work:def===SANDBOX_WORK_NONE?SANDBOX_WORK_NONE:work,
          workdir:(input&&def!==SANDBOX_WORK_NONE)?input.value.trim():''})};
    });
    actions.push({label:t('core.cancel'),cls:'confirm-cancel',tip:TIP_SBX_CANCEL,value:null});
    // FR-SPK-7: 고를 것이 scratch 하나뿐이면 늘리는 길을 안내한다. 이것이
    // 없으면 사용자는 `sandbox.json` 이라는 자리가 있다는 것 자체를 모른다 —
    // 접수한 말("프로파일 설정창이 안 뜬다")의 나머지 절반이 이쪽이다.
    let hint=null;
    if(list.length===1&&list[0]&&list[0].name===SANDBOX_PROFILE_SCRATCH){
      hint=document.createElement('div');hint.className='sbx-hint';
      hint.textContent=SANDBOX_DEV_HINT;
      const open=document.createElement('button');
      open.type='button';open.className='ui-btn ui-btn-sm sbx-settings';open.textContent=SANDBOX_DEV_SETTINGS;
      open.title=TIP_SBX_SETTINGS;
      // 선택창을 닫고 설정을 연다 — 두 창이 겹치면 어느 쪽이 살아 있는지
      // 알 수 없다.
      open.addEventListener('click',()=>{done(null);this._openSettings('sandbox')});
      hint.appendChild(open);
    }
    // FR-SBM-2: 기본 선택은 **첫 프로파일의 방식**이다. 그것이 `none` 이거나
    // 없으면 복사로 떨어진다 — 되돌아오는 통로가 없는 쪽이 안전한 기본이다.
    const first=(list[0]&&list[0].work)||'';
    setWork(SANDBOX_WORK_PICKS.includes(first)?first:SANDBOX_WORK_COPY);
    // FR-KIT-24·25: 이름은 머리(`.confirm-msg`)가 준다.
    return UIKit.ask({body,labelledBy:msg,label:t('sbx.profile_title'),footCls:'sbx-pick',
      actions,escValue:null,focus:input,onOpen:(m,fin)=>{
        done=fin;
        // 등급 배지는 버튼 글자 옆에 선다 — 이름과 한 버튼이어야 무엇의 등급인지 읽힌다.
        m.foot.querySelectorAll('.sbx-opt').forEach((b,i)=>{
          const p=list[i];
          const grade=document.createElement('span');
          grade.className='sbx-grade'+(p.isolated?' iso':'');
          grade.textContent=p.isolated?t('sbx.isolated'):t('sbx.not_isolated');
          b.append(' ',grade);
        });
        if(hint) m.body.appendChild(hint);
      }});
  },

  /**
   * 도구를 닫기 전 확인창.
   *
   * **`GitConfirm` 의 규약으로 수렴한다** (03-uiux 의 P1 `UX-1`).
   *
   * 파괴적 확인창이 앱에 두 벌 있었고 그 둘의 `Enter` 규약이 달랐다. 사용자는
   * 어느 창이 떠 있는지로 손가락을 바꾸지 않는다 — 같은 키가 한쪽에서는 취소이고
   * 다른 쪽에서는 "실행 중인 프로세스를 죽인다" 였다. **그 수렴은 그대로다.**
   * 문구를 `textContent` 로 넣는 것(`msg` 는 도구 이름을 담고 그것은 터미널이
   * 정한다)도 그대로다.
   *
   * **바뀐 것은 그 수렴이 도착한 값이다** (2026-09-10, POPUP_DEFAULT_ACTION_SRS
   * FR-PDA-1·2·25). 종전에는 "초기 포커스가 취소, `Enter` 는 실행이 아님" 이었고
   * 지금은 "초기 포커스가 **목적 버튼**, `Enter` 는 포커스된 것을 누름" 이다.
   * `UX-1` 이 고친 셋 중 이 둘은 되돌아갔고 나머지 둘(확인창 하나로의 수렴 ·
   * `textContent`)은 남는다.
   *
   * 마크업을 문자열로 잇지 않는 것도 같은 이유다 (`scripts/check-html.sh`).
   * `msg` 는 도구 이름을 담고, 도구 이름은 터미널이 정한다.
   */
  _confirmClose(msg, opts = {}){
    // 순서는 종전 그대로다 — 백그라운드·저장이 앞, 닫기·취소가 뒤.
    const actions=[];
    if(opts.bgBtn) actions.push({label:opts.bgLabel||t('core.to_background'),kind:'primary',cls:'confirm-bg',tip:TIP_CLOSE_BG,value:'background'});
    // 문구를 바꿀 수 있다 — 대상 전환의 확인(REPO_FIX 05 F-2.4)은 "닫기" 가 아니다.
    if(opts.saveBtn) actions.push({label:opts.saveLabel||t('core.save_and_close'),kind:'primary',cls:'confirm-save',tip:TIP_CLOSE_SAVE,value:'save'});
    /**
     * FR-PDA-1 / D-4: 기본 포커스는 **목적 버튼**이다.
     *
     * 사용자가 누른 것은 "닫기" 지만 **이 창이 뜨는 이유는 저장 안 된 편집이
     * 있기 때문**이다. 그 상황에서 사용자가 원하는 결과는 "편집을 잃지 않고
     * 닫는 것" 이므로 `저장 후 닫기` 가 목적이다 (사용자 결정 2026-09-10).
     * `U-10`(FR-RTU-103)이 방금 그 손실을 막는 일이었으므로 일관된다.
     *
     * 저장 갈래가 없는 호출(실행 중인 프로세스)에서는 `닫기` 가 목적이다.
     */
    if(opts.saveBtn) actions[actions.length-1].default=true;
    actions.push({label:opts.okLabel||t('core.close'),kind:'danger',cls:'confirm-ok',tip:TIP_CLOSE_TOOL,value:true,default:!opts.saveBtn});
    actions.push({label:t('core.cancel'),cls:'confirm-cancel',tip:TIP_CLOSE_CANCEL,value:false});
    // FR-KIT-24·25: 머리가 없는 상자라 이름은 본문(`.confirm-msg`)이 준다.
    // FR-PDA-2: `Enter` 는 가로채지 않는다 — 포커스된 버튼을 누르는 브라우저
    // 기본 동작이 곧 이 규약이다 (POPUP_DEFAULT_ACTION_SRS D-1). `Esc`·바깥 클릭은 취소다.
    return UIKit.ask({msg,actions,escValue:false});
  },

  // ── 백그라운드 도구 (FR-BG) ──

  // _setToolBackground는 도구를 백그라운드로 보내거나 되돌린다. 실패해도
  // 호출자의 흐름을 막지 않는다 — 탭 닫기가 알림 실패로 멈추면 더 나쁘다.
  async _setToolBackground(toolId,bg){
    if(!toolId) return false;
    const r=await apiPost('/api/tools/background/set',{toolId,background:!!bg});
    return r.ok;
  },

  /**
   * 백그라운드 목록 (FR-BGV-1).
   *
   * `state-registry` 의 `merge:'latest'` — **추월만 막는다.**
   * `tools_background_changed` 는 증분을 나르지 않고 "목록을 다시 받으라" 는
   * 신호이므로 만진 id 라는 개념이 없다. 막아야 하는 것은 두 스냅샷이 겹칠 때
   * 늦게 떠난 것이 먼저 도착해 새 목록을 낡은 것으로 되돌리는 일이다.
   */
  async _bgRefresh(src){
    const flight=this._restoreBegin('background');
    const r=await stateFetch(src,'/api/tools/background');
    if(!r.ok||!r.data) return;
    if(!this._restoreLive('background',flight)) return;
    this._bg=Array.isArray(r.data.background)?r.data.background:[];
    this._restoreEnd('background',flight);
    this.updateStatusBar();
    this._bgPanelPaint();
  },

  // FR-BGR-7: 복귀 대상 Pane 을 고른다.
  //
  // 명시 대상(opts.paneId)은 폴백하지 않는다 — 지목한 곳이 사라졌으면 실패가
  // 옳고, 그때 도구는 백그라운드 목록에 남아 여전히 닿을 수 있다 (TC-BGR-6b).
  // location 미지정은 "대상을 정하지 않았다"는 뜻이므로 폴백이 정당하다.
  async _restorePane(opts){
    if(opts.paneId){
      const win=this.ws.windows.find(s=>s.id===opts.windowId)||null;
      return win&&win.layout?findPane(win.layout,opts.paneId):null;
    }
    for(let i=0;i<RESTORE_PANE_WAIT_TRIES;i++){
      // FR-EDT-54: Editor 창에는 편집기 탭만 산다. 복귀는 `addTab` 을 거치지 않고
      // 터미널 탭을 pane 에 직접 넣으므로(`_restoreTool`) 그 게이트가 여기에도
      // 있어야 한다 — 없으면 Editor 창에 터미널 탭이 생기고, 일반 창만 걷는
      // `_migrateEditorTabs` 가 그것을 영원히 지나친다. Git 창도 같은 구멍이다.
      const a=this.aw();
      const cur=this.isEditorWin(a)||this.isGitWin(a)?null:a;
      const pn=(this.focused&&cur&&cur.layout?findPane(cur.layout,this.focused):null)
        ||(cur&&cur.layout?firstPane(cur.layout):null)
        ||this.plainWindows().map(s=>firstPane(s.layout)).find(Boolean)
        ||null;
      if(pn) return pn;
      // 창이 하나도 없는 것은 delWindow 가 _mkWindow 를 끝내기 전의 과도
      // 상태뿐이다. 조용히 무효가 되지 않도록 그 왕복만큼 기다린다.
      await this.timers.sleep(RESTORE_PANE_WAIT_MS,{owner:'app',label:'restore-pane'});
    }
    return null;
  },

  // FR-BG-7 / FR-BGR-1: 백그라운드 도구를 지정 분할 칸(opts.paneId, 미지정 시
  // 현재 포커스)의 새 탭으로 되돌린다.
  async _restoreTool(toolId,opts={}){
    if(!toolId) return;
    // FR-BGR-5: 대상을 먼저 확정한다. 백그라운드 해제를 앞세우면 대상이 없을 때
    // 도구가 목록에도 탭에도 없는 — 어디서도 닿을 수 없는 상태가 된다.
    const pn=await this._restorePane(opts);
    /**
     * FUI-21: **실패를 화면이 말한다.**
     *
     * 이 함수는 백그라운드 **구역의 행 클릭**에서 불린다. `console.warn` 은
     * 사용자에게 아무것도 아니다 — 화면에서 보면 "눌렀는데 아무 일도 없음"
     * 이고, 그 상태에서 할 수 있는 것은 같은 것을 다시 누르는 일뿐이다.
     * (모달이던 시절에는 이미 닫힌 뒤라 더 그랬다 — FR-ACT-2 로 표면이
     * 패널이 된 지금은 목록이 그대로 보이므로 안내가 그 위에 선다.)
     *
     * 도구는 두 갈래 모두에서 **백그라운드 목록에 그대로 남는다** (FR-BGR-5 가
     * 대상 확정을 앞세운 이유) — 안내가 그 사실을 함께 말한다.
     */
    if(!pn){
      console.warn('[bg] 복귀할 분할 칸 없음',opts.paneId||this.focused);
      Toast.show(BG_RESTORE_NO_PANE,'err');
      return;
    }
    if(!await this._setToolBackground(toolId,false)){
      Toast.show(BG_RESTORE_FAIL,'err');
      return;
    }
    const tabId=newEntityId();
    if(!this.tools.has(toolId)) this.mkTool(toolId,DEFAULT_TOOL_NAME);
    pn.tabs.push({id:tabId,name:TAB_NAME_DEFAULT,type:TAB_TYPE_TERMINAL,toolId});
    this.paneTabSet(pn,tabId);
    this.render();
    this.save();
    this._bgRefresh();
  },

  // win 은 이 도구가 들어갈 창이다. 샌드박스 창이면 도구가 그 창의 대응
  // 컨테이너 안에서 뜬다 (SANDBOX_WINDOW_SRS FR-SBX-11).
  async _newTool(cwd,cwdTool,win){
    // FR-OPT-11-7 (FEC-31): 쿼리는 `apiPost` 의 `query` 가 조립한다 — 손으로 잇지 않는다.
    const query={cols:TOOL_COLS_DEFAULT,rows:TOOL_ROWS_DEFAULT};
    if(cwd) query.cwd=cwd;
    else if(cwdTool) query.cwdTool=cwdTool;
    // 프로파일을 창 id 와 **함께** 보낸다. 서버가 workspace 를 조회하게 하면,
    // 창이 저장되기 전에 탭이 만들어지는 순간 샌드박스 창이 일반 창으로 읽혀
    // 호스트에서 뜬다 (FR-SBX-10).
    if(win&&win.sandbox&&win.id){
      query.window=win.id; query.sandbox=win.sandbox;
      // UX_BATCH6_SRS FR-SBM-3: 이 창이 고른 작업 방식. 창 레코드에 사는 이유는
      // 뒤에 만드는 탭도 **같은 컨테이너**에 들어가기 때문이다 — 프로파일과 같다.
      if(win.sandboxWork) query.sandboxWork=win.sandboxWork;
    }
    const r=await apiPost(TOOLS_API,null,{query});
    if(!r.ok){
      // FR-SBX-20: 샌드박스 기동 실패의 사유는 사용자에게 닿아야 한다 — 런타임
      // 미설치·데몬 미실행·이미지 없음이 모두 여기로 온다. 뭉개면 "창이 안 열린다"
      // 만 남는다.
      throw new Error(r.text.trim()||'create pane failed');
    }
    const {id,name}=r.data;
    return this.mkTool(id,name);
  },

  async _focusedCwd(){
    const p=this.focusedTerminal();
    if(!p) return null;
    const r=await apiGet('/api/cwd',{query:{tool:p.id}});
    return (r.data&&r.data.cwd)||null;
  },

  // FR-ATL-7: 지우는 도구의 알람은 로컬에서 먼저 뗀다. 서버 브로드캐스트를
  // 기다리면 그 사이 배지가 없는 도구를 가리키고, 통지가 유실되면 영영 남는다.
  // FR-WSL-22: 도구를 지우는 경로는 **모든 슬롯의 인스턴스**를 파괴한다. 슬롯 1 의
  // 인스턴스가 남으면 이미 죽은 PTY 로 재연결을 시도한다.
  // FR-SAF-17·18: 칸 목록을 손으로 적지 않는다. 종전에는 `[pid, slotKey(pid,1)]`
  // 두 칸만 돌아, `SLOT_MAX` 가 4 로 자란 뒤 슬롯 2·3 의 인스턴스가 살아남았다.
  _killToolInstances(pid){
    this.toolIds.delete(pid); this._toolsBoot.delete(pid);
    for(const k of this.slotKeysOf(pid)){
      const p=this.tools.get(k);
      if(p){ErrorLog.quiet('destroy',()=>p.destroy()); this.tools.delete(k)}
    }
  },

  async _kill(pid){
    this._killToolInstances(pid);
    if(this._attnDrop(pid)) this._attnRefresh();
    await apiDel(`/api/tools/${pid}`);
  },
  _killTool(pid){
    this._killToolInstances(pid);
    if(this._attnDrop(pid)) this._attnRefresh();
    apiDel(`/api/tools/${pid}`);
  },

  aw(){return this.ws.windows.find(s=>s.id===this.ws.activeWindow)||null},

  // _isToolInActiveWindow reports whether a pane (by id) is present in the
  // currently active window's layout. Used to route focus commands only to
  // the window that is actually viewing the source pane (multi-window).
  _isToolInActiveWindow(toolId){
    if(!toolId) return false;
    const s=this.aw();
    if(!s||!s.layout) return false;
    return !!findTabWhere([s],tab=>tab.toolId===toolId);
  },

  /**
   * FR-NAM-1: 도구 이름을 묻는 자리는 전부 여기를 지난다. 탭이 있으면 그
   * 탭의 규칙(FR-TAN-15)이 적용되고, 없으면 파생 이름이 답한다.
   */
  _toolName(toolId,fallback){
    const loc=this.findToolLocation(toolId);
    return toolDisplayName(toolId,this.fgNames,loc&&loc.tab,fallback);
  },

  // toolId 를 가진 tab 의 위치 (FR-PAN-16)
  findToolLocation(toolId){
    return toolId?findTabWhere(this.ws.windows,tab=>tab.toolId===toolId):null;
  },
});
