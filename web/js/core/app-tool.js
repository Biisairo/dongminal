/**
 * Remote Terminal — App 도구 생명주기 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 12개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  async _isToolBusy(toolId){
    try{const r=await fetch(`/api/tools/${toolId}/busy`);const d=await r.json();return d.busy}catch{return false}
  },

  // FR-SBX-20: 도구 기동 실패의 사유를 사용자에게 보인다. 확인창과 같은
  // 껍데기를 쓰되 선택지가 없다 — 알릴 뿐 되돌릴 것이 없다.
  //
  // 본문을 textContent 로 넣는 것이 요점이다. 여기 오는 문자열은 서버가 만든
  // 오류 메시지이며, `_confirmClose` 처럼 innerHTML 에 끼우면 그 내용이 마크업으로
  // 해석된다.
  _notify(msg){
    const ov=document.createElement('div');ov.className='confirm-overlay';
    ov.innerHTML='<div class="confirm-box"><div class="confirm-msg notify-msg"></div>'+
      '<div class="confirm-btns"><button class="confirm-ok" title="'+TIP_NOTIFY_OK+'">확인</button></div></div>';
    ov.querySelector('.confirm-msg').textContent=msg;
    document.body.appendChild(ov);
    const btn=ov.querySelector('.confirm-ok');btn.focus();
    const cleanup=()=>{ov.remove();document.removeEventListener('keydown',onKey)};
    const onKey=e=>{if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();cleanup()}};
    document.addEventListener('keydown',onKey);
    btn.addEventListener('click',cleanup);
    ov.addEventListener('click',e=>{if(e.target===ov)cleanup()});
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
    const el=document.createElement('div');
    el.className='sbx-progress';el.textContent=msg;
    document.body.appendChild(el);
    return ()=>el.remove();
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
    try{
      const r=await fetch('/api/sandbox/runtime');
      if(!r.ok) return null;
      return await r.json();
    }catch{return null}
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
    return new Promise(resolve=>{
      const missing=st.state===SBX_RT_MISSING;
      const ov=document.createElement('div');
      ov.className='confirm-overlay'; ov.dataset.state=st.state;
      const box=document.createElement('div'); box.className='confirm-box sbx-rt';
      const title=document.createElement('div'); title.className='confirm-msg';
      title.textContent=missing?SBX_RT_TITLE_MISSING:SBX_RT_TITLE_STOPPED;
      box.appendChild(title);

      const msg=document.createElement('div'); msg.className='sbx-rt-msg';
      // 실행할 수 없는 OS 에서는 "실행할까요" 가 아니라 "직접 실행하세요" 다 (D-5).
      msg.textContent=missing?SBX_RT_MSG_MISSING
        :(st.startTryable?SBX_RT_MSG_STOPPED:SBX_RT_MSG_MANUAL);
      box.appendChild(msg);

      // 보일 명령은 상태가 정한다 — 설치인지 기동인지.
      const cmd=missing?(st.installCommand||''):(st.startCommand||'');
      // 실행 버튼이 있으면 명령을 함께 보이지 않는다: 누를 것이 둘이면 어느 쪽이
      // 진짜인지 말할 수 없다. 실행할 수 없을 때에만 칠 것을 준다.
      const showCmd=!!cmd&&(missing||!st.startTryable);
      if(showCmd){
        const row=document.createElement('div'); row.className='sbx-rt-cmdrow';
        const code=document.createElement('code'); code.className='sbx-rt-cmd';
        code.textContent=cmd;
        const copy=document.createElement('button');
        copy.type='button'; copy.className='sbx-rt-copy'; copy.textContent=SBX_RT_COPY;
        copy.addEventListener('click',async()=>{
          // 복사가 막힌 환경(비 HTTPS·권한)에서도 명령은 화면에 남아 있다 —
          // 실패를 알릴 뿐 흐름을 막지 않는다.
          try{await navigator.clipboard.writeText(cmd); copy.textContent=SBX_RT_COPIED}
          catch{}
        });
        row.appendChild(code); row.appendChild(copy);
        box.appendChild(row);
      }else if(missing){
        // 명령을 모르는 OS 다. 안내만 남기고 지어내지 않는다.
        const n=document.createElement('div'); n.className='sbx-rt-msg';
        n.textContent=SBX_RT_NO_CMD; box.appendChild(n);
      }
      if(missing){
        const rs=document.createElement('div'); rs.className='sbx-rt-restart';
        rs.textContent=SBX_RT_MSG_RESTART;
        box.appendChild(rs);
        const docs=document.createElement('div'); docs.className='sbx-rt-docs';
        // 바깥 링크를 열지 않는다 — 글자로 둔다 (FR-SRT-6).
        docs.textContent=SBX_RT_DOCS;
        box.appendChild(docs);
      }

      // 진행과 사유가 함께 사는 자리. 닫히지 않으므로 읽을 시간이 있다.
      const note=document.createElement('div'); note.className='sbx-rt-note';
      note.hidden=true;
      box.appendChild(note);

      const btns=document.createElement('div'); btns.className='confirm-btns';
      let start=null;
      if(!missing&&st.startTryable){
        start=document.createElement('button');
        start.type='button'; start.className='confirm-ok sbx-rt-start';
        start.textContent=SBX_RT_START;
        btns.appendChild(start);
      }
      const close=document.createElement('button');
      close.type='button'; close.className='confirm-cancel'; close.textContent=SBX_RT_CLOSE;
      btns.appendChild(close);
      box.appendChild(btns);
      ov.appendChild(box);
      document.body.appendChild(ov);

      let done=false;
      const cleanup=v=>{
        if(done) return; done=true;
        ov.remove(); document.removeEventListener('keydown',onKey); resolve(v);
      };
      const onKey=e=>{if(e.key==='Escape'){e.preventDefault();cleanup(false)}};
      document.addEventListener('keydown',onKey);
      close.addEventListener('click',()=>cleanup(false));
      ov.addEventListener('click',e=>{if(e.target===ov)cleanup(false)});
      if(start) start.addEventListener('click',()=>this._sbxRuntimeStart(start,note,cleanup));
      (start||close).focus();
    });
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
    try{
      const r=await fetch('/api/sandbox/runtime/start',{method:'POST'});
      if(r.ok) res=await r.json();
    }catch{}
    if(!res||!res.started){
      btn.disabled=false;
      note.textContent=SBX_RT_START_FAIL+((res&&res.detail)?' — '+res.detail:'');
      return;
    }
    // NFR-SRT-2: 2초 주기, 60초 상한. 데몬이 뜨면 그 자리에서 이어진다.
    const until=Date.now()+SBX_RT_POLL_MAX_MS;
    for(;;){
      await new Promise(r=>setTimeout(r,SBX_RT_POLL_MS));
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
    try{return JSON.parse(localStorage.getItem('dm.sbx.recent')||'[]').filter(Boolean).slice(0,5)}
    catch{return []}
  },

  _sbxRemember(path){
    if(!path) return;
    try{
      const cur=this._sbxRecent().filter(p=>p!==path);
      cur.unshift(path);
      localStorage.setItem('dm.sbx.recent',JSON.stringify(cur.slice(0,5)));
    }catch{}
  },

  _pickSandbox(list,here){
    return new Promise(resolve=>{
      const ov=document.createElement('div');ov.className='confirm-overlay';
      const box=document.createElement('div');box.className='confirm-box';
      const msg=document.createElement('div');msg.className='confirm-msg';
      msg.textContent='샌드박스 프로파일';
      box.appendChild(msg);
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
          now.type='button';now.className='sbx-now';now.textContent='지금 위치';now.title=here;
          now.addEventListener('click',()=>{input.value=here;input.focus()});
          wrap.appendChild(now);
        }
        box.appendChild(wrap);

        // 최근에 연 자리는 아랫줄에 모은다. 경로를 매번 타이핑하게 하면 이
        // 창은 절차만 늘리는 자리가 된다.
        const recent=this._sbxRecent().filter(p=>p!==here);
        if(recent.length){
          const bar=document.createElement('div');bar.className='sbx-recent';
          for(const path of recent){
            const b=document.createElement('button');
            b.type='button';b.className='sbx-recent-item';b.textContent=path;b.title=path;
            b.addEventListener('click',()=>{input.value=path;input.focus()});
            bar.appendChild(b);
          }
          box.appendChild(bar);
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
          b.type='button';b.className='sbx-work-opt sbx-work-'+k;b.dataset.work=k;
          b.textContent=SANDBOX_WORK_LABEL[k];b.title=SANDBOX_WORK_TITLE[k]||'';
          b.addEventListener('click',()=>setWork(k));
          workBtns.set(k,b);wrap.appendChild(b);
        }
        box.appendChild(wrap);
      }
      // FR-SBM-5: 고른 것의 결과. 등급 배지와 **다른 자리**여야 한다 — 배지는
      // 프로파일의 것이고(FR-SBM-4) 이 줄은 이번 선택의 것이다.
      const warn=document.createElement('div');warn.className='sbx-work-warn';
      box.appendChild(warn);
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

      const btns=document.createElement('div');btns.className='confirm-btns sbx-pick';
      const cleanup=v=>{ov.remove();document.removeEventListener('keydown',onKey);resolve(v)};
      const onKey=e=>{if(e.key==='Escape'){e.preventDefault();cleanup(null)}};
      for(const p of list){
        const b=document.createElement('button');
        b.className='confirm-ok sbx-opt';
        const grade=document.createElement('span');
        grade.className='sbx-grade'+(p.isolated?' iso':'');
        grade.textContent=p.isolated?'격리':'비격리';
        b.textContent=p.name+' ';
        b.appendChild(grade);
        // FR-SPK-5 (FR-SBM-1 로 개정): 방식은 이제 **위에서 고른다.** 프로파일이
        // 정하는 것은 기본 선택뿐이므로 버튼에 표기를 겹치지 않는다 — 두 자리가
        // 같은 것을 말하면 어느 쪽이 지금 값인지 알 수 없다.
        const def=p.work||SANDBOX_WORK_NONE;
        b.title=(p.image?p.image+String.fromCharCode(10):'')+
          (p.isolated
            ? '컨테이너 안 코드가 호스트를 조작할 수 없습니다.'
            : 'dmctl 이 들어 있어 컨테이너 안에서 워크스페이스를 조작할 수 있습니다. 실수는 막지만 악의적 코드는 막지 못합니다.')+
          String.fromCharCode(10)+(SANDBOX_WORK_TITLE[def]||'');
        // FR-SPK-6 / FR-SBM-2: `none` 인 프로파일에서는 입력한 폴더가 버려진다.
        b.addEventListener('click',()=>cleanup({profile:p.name,
          work:def===SANDBOX_WORK_NONE?SANDBOX_WORK_NONE:work,
          workdir:(input&&def!==SANDBOX_WORK_NONE)?input.value.trim():''}));
        btns.appendChild(b);
      }
      const cancel=document.createElement('button');
      cancel.className='confirm-cancel';cancel.textContent='취소';cancel.title=TIP_SBX_CANCEL;
      cancel.addEventListener('click',()=>cleanup(null));
      btns.appendChild(cancel);
      box.appendChild(btns);
      // FR-SPK-7: 고를 것이 scratch 하나뿐이면 늘리는 길을 안내한다. 이것이
      // 없으면 사용자는 `sandbox.json` 이라는 자리가 있다는 것 자체를 모른다 —
      // 접수한 말("프로파일 설정창이 안 뜬다")의 나머지 절반이 이쪽이다.
      if(list.length===1&&list[0]&&list[0].name===SANDBOX_PROFILE_SCRATCH){
        const hint=document.createElement('div');hint.className='sbx-hint';
        hint.textContent=SANDBOX_DEV_HINT;
        const open=document.createElement('button');
        open.type='button';open.className='sbx-settings';open.textContent=SANDBOX_DEV_SETTINGS;
        open.title=TIP_SBX_SETTINGS;
        // 선택창을 닫고 설정을 연다 — 두 창이 겹치면 어느 쪽이 살아 있는지
        // 알 수 없다.
        open.addEventListener('click',()=>{cleanup(null);this._openSettings('sandbox')});
        hint.appendChild(open);
        box.appendChild(hint);
      }
      // FR-SBM-2: 기본 선택은 **첫 프로파일의 방식**이다. 그것이 `none` 이거나
      // 없으면 복사로 떨어진다 — 되돌아오는 통로가 없는 쪽이 안전한 기본이다.
      const first=(list[0]&&list[0].work)||'';
      setWork(SANDBOX_WORK_PICKS.includes(first)?first:SANDBOX_WORK_COPY);
      ov.appendChild(box);document.body.appendChild(ov);
      document.addEventListener('keydown',onKey);
      ov.addEventListener('click',e=>{if(e.target===ov)cleanup(null)});
      if(input) input.focus(); else {const f=btns.querySelector('.sbx-opt'); if(f) f.focus()}
    });
  },

  _confirmClose(msg, opts = {}){
    return new Promise(resolve=>{
      const ov=document.createElement('div');ov.className='confirm-overlay';
      let btns = `<button class="confirm-ok" title="${TIP_CLOSE_TOOL}">닫기</button>`
        + `<button class="confirm-cancel" title="${TIP_CLOSE_CANCEL}">취소</button>`;
      if (opts.saveBtn) {
        btns = `<button class="confirm-save" title="${TIP_CLOSE_SAVE}">저장 후 닫기</button>` + btns;
      }
      // FR-BG-3/4: 실행 중인 도구를 살려두고 닫는 선택지.
      if (opts.bgBtn) {
        btns = `<button class="confirm-bg" title="${TIP_CLOSE_BG}">${opts.bgLabel||'백그라운드로'}</button>` + btns;
      }
      ov.innerHTML=`<div class="confirm-box"><div class="confirm-msg">${msg}</div><div class="confirm-btns">${btns}</div></div>`;
      document.body.appendChild(ov);
      const saveBtn = ov.querySelector('.confirm-save');
      const bgBtn = ov.querySelector('.confirm-bg');
      if (saveBtn) saveBtn.focus(); else if (bgBtn) bgBtn.focus(); else ov.querySelector('.confirm-ok').focus();
      const cleanup=v=>{ov.remove();document.removeEventListener('keydown',onKey);resolve(v)};
      const onKey=e=>{if(e.key==='Enter'){e.preventDefault();cleanup(saveBtn?'save':(bgBtn?'background':true))}else if(e.key==='Escape'){e.preventDefault();cleanup(false)}};
      document.addEventListener('keydown',onKey);
      if (saveBtn) saveBtn.addEventListener('click',()=>cleanup('save'));
      if (bgBtn) bgBtn.addEventListener('click',()=>cleanup('background'));
      ov.querySelector('.confirm-ok').addEventListener('click',()=>cleanup(true));
      ov.querySelector('.confirm-cancel').addEventListener('click',()=>cleanup(false));
      ov.addEventListener('click',e=>{if(e.target===ov)cleanup(false)});
    });
  },

  // ── 백그라운드 도구 (FR-BG) ──

  // _setToolBackground는 도구를 백그라운드로 보내거나 되돌린다. 실패해도
  // 호출자의 흐름을 막지 않는다 — 탭 닫기가 알림 실패로 멈추면 더 나쁘다.
  async _setToolBackground(toolId,bg){
    if(!toolId) return false;
    try{
      const r=await fetch('/api/tools/background/set',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({toolId,background:!!bg})});
      return r.ok;
    }catch{return false}
  },

  async _bgRefresh(){
    try{
      const r=await fetch('/api/tools/background');
      if(!r.ok) return;
      const j=await r.json();
      this._bg=Array.isArray(j.background)?j.background:[];
    }catch{return}
    this._updateStatusBar();
    if(this._bgModalOpen) this._bgModalRender();
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
      const a=this._aw();
      const cur=this._isEditorWin(a)||this._isGitWin(a)?null:a;
      const pn=(this.focused&&cur&&cur.layout?findPane(cur.layout,this.focused):null)
        ||(cur&&cur.layout?firstPane(cur.layout):null)
        ||this._plainWindows().map(s=>firstPane(s.layout)).find(Boolean)
        ||null;
      if(pn) return pn;
      // 창이 하나도 없는 것은 delWindow 가 _mkWindow 를 끝내기 전의 과도
      // 상태뿐이다. 조용히 무효가 되지 않도록 그 왕복만큼 기다린다.
      await new Promise(r=>setTimeout(r,RESTORE_PANE_WAIT_MS));
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
    if(!pn){console.warn('[bg] 복귀할 분할 칸 없음',opts.paneId||this.focused);return}
    if(!await this._setToolBackground(toolId,false)) return;
    if(!this.tools.has(toolId)) this._mkTool(toolId,DEFAULT_TOOL_NAME);
    const t=newEntityId();
    pn.tabs.push({id:t,name:'Shell',type:'terminal',toolId});
    this.paneTabSet(pn,t);
    this.render();
    this._save();
    this._bgRefresh();
  },

  // win 은 이 도구가 들어갈 창이다. 샌드박스 창이면 도구가 그 창의 대응
  // 컨테이너 안에서 뜬다 (SANDBOX_WINDOW_SRS FR-SBX-11).
  async _newTool(cwd,cwdTool,win){
    let q='';
    if(cwd) q='&cwd='+encodeURIComponent(cwd);
    else if(cwdTool) q='&cwdTool='+encodeURIComponent(cwdTool);
    // 프로파일을 창 id 와 **함께** 보낸다. 서버가 workspace 를 조회하게 하면,
    // 창이 저장되기 전에 탭이 만들어지는 순간 샌드박스 창이 일반 창으로 읽혀
    // 호스트에서 뜬다 (FR-SBX-10).
    if(win&&win.sandbox&&win.id){
      q+='&window='+encodeURIComponent(win.id)+'&sandbox='+encodeURIComponent(win.sandbox);
      // UX_BATCH6_SRS FR-SBM-3: 이 창이 고른 작업 방식. 창 레코드에 사는 이유는
      // 뒤에 만드는 탭도 **같은 컨테이너**에 들어가기 때문이다 — 프로파일과 같다.
      if(win.sandboxWork) q+='&sandboxWork='+encodeURIComponent(win.sandboxWork);
    }
    const r=await fetch('/api/tools?cols=120&rows=40'+q,{method:'POST'});
    if(!r.ok){
      // FR-SBX-20: 샌드박스 기동 실패의 사유는 사용자에게 닿아야 한다 — 런타임
      // 미설치·데몬 미실행·이미지 없음이 모두 여기로 온다. 뭉개면 "창이 안 열린다"
      // 만 남는다.
      const detail=await r.text().catch(()=>'');
      throw new Error(detail.trim()||'create pane failed');
    }
    const {id,name}=await r.json();
    return this._mkTool(id,name);
  },

  async _focusedCwd(){
    const p=this._focusedTerminal();
    if(!p) return null;
    try{const r=await fetch('/api/cwd?tool='+p.id);const d=await r.json();return d.cwd||null}catch{return null}
  },

  // FR-ATL-7: 지우는 도구의 알람은 로컬에서 먼저 뗀다. 서버 브로드캐스트를
  // 기다리면 그 사이 배지가 없는 도구를 가리키고, 통지가 유실되면 영영 남는다.
  // FR-WSL-22: 도구를 지우는 경로는 **모든 슬롯의 인스턴스**를 파괴한다. 슬롯 1 의
  // 인스턴스가 남으면 이미 죽은 PTY 로 재연결을 시도한다.
  _killToolInstances(pid){
    for(const k of [pid,this._slotKey(pid,1)]){
      const p=this.tools.get(k);
      if(p){try{p.destroy()}catch{}; this.tools.delete(k)}
    }
  },

  async _kill(pid){
    this._killToolInstances(pid);
    if(this._attnDrop(pid)) this._attnRefresh();
    try{await fetch(`/api/tools/${pid}`,{method:'DELETE'})}catch{}
  },
  _killTool(pid){
    this._killToolInstances(pid);
    if(this._attnDrop(pid)) this._attnRefresh();
    fetch(`/api/tools/${pid}`,{method:'DELETE'}).catch(()=>{});
  },

  _aw(){return this.ws.windows.find(s=>s.id===this.ws.activeWindow)||null},

  // _isToolInActiveWindow reports whether a pane (by id) is present in the
  // currently active window's layout. Used to route focus commands only to
  // the window that is actually viewing the source pane (multi-window).
  _isToolInActiveWindow(toolId){
    if(!toolId) return false;
    const s=this._aw();
    if(!s||!s.layout) return false;
    let found=false;
    const walk=n=>{
      if(!n||found) return;
      if(n.type==='pane'&&n.tabs){
        for(const t of n.tabs) if(t.toolId===toolId){found=true;return}
      }
      if(n.type==='split'&&n.children) for(const c of n.children) walk(c);
    };
    walk(s.layout);
    return found;
  },

  /**
   * FR-NAM-1: 도구 이름을 묻는 자리는 전부 여기를 지난다. 탭이 있으면 그
   * 탭의 규칙(FR-TAN-15)이 적용되고, 없으면 파생 이름이 답한다.
   */
  _toolName(toolId,fallback){
    const loc=this._findToolLocation(toolId);
    return toolDisplayName(toolId,this._fgNames,loc&&loc.tab,fallback);
  },

  // 모든 창 layout 트리를 walk 해 toolId 를 가진 tab 위치 반환 (FR-PAN-16)
  _findToolLocation(toolId){
    if(!toolId) return null;
    const walk=(node,win)=>{
      if(!node) return null;
      if(node.type==='pane'){
        const tab=(node.tabs||[]).find(t=>t.toolId===toolId);
        return tab?{win,pane:node,tab}:null;
      }
      if(node.children) for(const c of node.children){const f=walk(c,win);if(f)return f}
      return null;
    };
    for(const s of this.ws.windows){const f=walk(s.layout,s);if(f)return f}
    return null;
  },
});
