/**
 * Remote Terminal — 도구: 바쁨 묻기·알림·샌드박스 고르기·닫기 확인 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * App 은 이것을 `tool` 로 든다(REFACTOR3_FE_APPCTL_SRS 9j, 옛 `app-tool.js` 의 앞쪽). 부품 넷 — 도구 수명(백그라운드·복원·
 * 만들기·죽이기·찾기) `ToolLife`(`tool-life.js`) `.life` · 원격 커맨드 `ToolCmd`(`tool-cmd.js`) `.cmd` · 작업 중 표식
 * `ToolWork`(`tool-work.js`) `.work` · 터미널 검색 `ToolSearch`(`tool-search.js`) `.search`.
 * 백그라운드 목록 `_bg` 는 App 에 남고 쓰기는 이 묶음만 한다(§2.2 A/9j).
 *
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
// 샌드박스 창의 작업 방식(SANDBOX_PICK_COPY_SRS FR-SPK-10·23)의 라벨·도움말은 방식 이름을 키로 고르고, 없으면 이름(도움말은 빈 글자) 그대로다 (FR-SDA-84).
function sandboxWorkLabel(work){
  const k='core.sandbox_work_label.'+work;
  return I18N.has(k)?t(k):String(work);
}
function sandboxWorkTitle(work){
  const k='core.sandbox_work_title.'+work;
  return I18N.has(k)?t(k):'';
}
// 컨테이너 런타임의 상태(UX_BATCH5_SRS FR-SRT-1~8). 갈래는 서버가 싣는 뜻(`ready`·`installed`)으로 고르고, 제목·문장은 `state` 를 키로
// 고른다 (SERVER_DRIVEN_ACTIONS_SRS K-i). 키가 없으면 `state` 그대로다.
function sbxRuntimeText(prefix,state){
  const k=prefix+state;
  return I18N.has(k)?t(k):String(state);
}
// SERVER_DRIVEN_ACTIONS_SRS K-i: 프로파일이 받는 방식(`workPicks`, 서버가 싣는다).
const sbxPicksOf=p=>(p&&Array.isArray(p.workPicks))?p.workPicks:[];
/** 고르는 줄은 프로파일들의 `workPicks` 를 방식으로 합친 것이다(서버 순서). 선택은 `{work, copies}` 그대로 든다. */
function sbxWorkPicks(list){
  const picks=[];
  for(const p of list) for(const k of sbxPicksOf(p)) if(k&&!picks.some(x=>x.work===k.work)) picks.push(k);
  return picks;
}
/**
 * FR-SBM-2: 기본 선택은 **첫 프로파일의 방식**이다. 그것을 고를 수 없으면
 * `copies` 인 선택으로 떨어진다 — 되돌아오는 통로가 없는 쪽이 안전한 기본이다.
 */
function sbxDefaultWork(list,picks){
  const first=(list[0]&&list[0].work)||'';
  return picks.find(x=>x.work===first)||picks.find(x=>x.copies)||picks[0]||null;
}
/**
 * 프로파일 버튼을 누른 결과. FR-SPK-6 / FR-SBM-2: 고를 방식이 없는(`workPicks` 가 빈) 프로파일에서는
 * 입력한 폴더가 버려지고 프로파일의 방식이 그대로 실린다. 고른 방식을 이 프로파일이 받지 않으면
 * 프로파일의 방식으로 간다.
 */
function sbxPickResult(p,work,workdir){
  const own=sbxPicksOf(p);
  const k=own.find(x=>!!work&&x.work===work.work)||own.find(x=>x.work===p.work)||own[0]||null;
  return k?{profile:p.name,work:k.work,copies:!!k.copies,workdir}
    :{profile:p.name,work:p.work||'',copies:false,workdir:''};
}

class ToolController extends Controller {
  constructor(app){
    super(app);
    this.life=new ToolLife(app);
    this.cmd=new ToolCmd(app);
    this.work=new ToolWork(app);
    this.search=new ToolSearch(app);
  }

  async _isToolBusy(toolId){
    const r=await apiGet(`/api/tools/${toolId}/busy`);
    return !!(r.data&&r.data.busy);
  }

  // OPTIMIZE_REFACTOR_SRS FR-OPT-2-4: 도구 N개를 요청 한 번으로 묻는다. 답하지 못하면
  // 빈 답이다 — 단건이 실패에 false 를 내던 것과 같다.
  async _toolsBusy(ids){
    if(!ids.length) return {};
    const r=await apiGet(`/api/tools/busy?ids=${ids.map(encodeURIComponent).join(',')}`);
    return (r.data&&r.data.busy)||{};
  }

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
  }

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
  }

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
  }

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
    // 설치됐는가는 서버가 싣는 뜻이다 — 상태 이름과 견주지 않는다 (SERVER_DRIVEN_ACTIONS_SRS K-i).
    const installed=!!st.installed;
    // 시작할 수 있는지는 서버의 답이다 (SERVER_DRIVEN_ACTIONS_SRS X-b).
    const canStart=actionOk(st,'sandbox.runtime.start');
    // FR-OPT-11-5 (FEC-27): 본문만 여기서 세우고 골격은 `UIKit.ask` 가 갖는다.
    const body=document.createDocumentFragment();
    const title=document.createElement('div'); title.className='confirm-msg';
    title.textContent=sbxRuntimeText('core.sbx_rt_title.',st.state);
    body.appendChild(title);

    const msg=document.createElement('div'); msg.className='sbx-rt-msg';
    // 실행할 수 없는 OS 에서는 "실행할까요" 가 아니라 "직접 실행하세요" 다 (D-5).
    msg.textContent=(!installed||canStart)?sbxRuntimeText('core.sbx_rt_msg.',st.state):SBX_RT_MSG_MANUAL;
    body.appendChild(msg);

    // 보일 명령은 상태가 정한다 — 설치인지 기동인지.
    const cmd=installed?(st.startCommand||''):(st.installCommand||'');
    // 실행 버튼이 있으면 명령을 함께 보이지 않는다: 누를 것이 둘이면 어느 쪽이
    // 진짜인지 말할 수 없다. 실행할 수 없을 때에만 칠 것을 준다.
    const showCmd=!!cmd&&!canStart;
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
    }else if(!installed){
      // 명령을 모르는 OS 다. 안내만 남기고 지어내지 않는다.
      const n=document.createElement('div'); n.className='sbx-rt-msg';
      n.textContent=SBX_RT_NO_CMD; body.appendChild(n);
    }
    if(!installed){
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
  }

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
      // 거절(X-b)이면 사유 코드의 문구, 실행 실패면 런타임의 진단이다.
      const code=!rt.ok&&rt.headers?rt.headers.get('X-Error-Code'):null;
      const why=code&&I18N.has('why.'+code)?t('why.'+code):((res&&res.detail)||'');
      note.textContent=SBX_RT_START_FAIL+(why?' — '+why:'');
      return;
    }
    // NFR-SRT-2: 2초 주기, 60초 상한. 데몬이 뜨면 그 자리에서 이어진다.
    const until=Date.now()+SBX_RT_POLL_MAX_MS;
    for(;;){
      await this.app.timers.sleep(SBX_RT_POLL_MS,{owner:'app',label:'sbx-wait'});
      const st=await this._sbxRuntime();
      if(st&&st.ready){cleanup(true);return}
      if(Date.now()>=until) break;
    }
    btn.disabled=false;
    // 상한을 넘긴 것은 실패와 다르다 — 명령은 돌았고 데몬이 아직 안 떴을 뿐이다.
    note.textContent=SBX_RT_TIMEOUT;
  }

  // 샌드박스 프로파일 선택 (FR-SBX-25). 격리 등급을 함께 보이는 것이 요점이다 —
  // `dev`·`agent` 는 컨테이너 안에서 dmctl 을 쓸 수 있어 호스트 워크스페이스를
  // 조작할 수 있고, 그것을 모른 채 "격리됐다" 고 믿으면 그 믿음이 위험이 된다
  // (FR-SBX-23/24).
  // 최근에 연 작업 폴더. 이 브라우저에만 남는 편의값이라 서버로 보내지 않는다.
  _sbxRecent(){
    const v=PrefStore.local.json(STORE_KEYS.sandboxRecent,[]);
    return Array.isArray(v)?v.filter(Boolean).slice(0,5):[];
  }

  _sbxRemember(path){
    if(!path) return;
    const cur=this._sbxRecent().filter(p=>p!==path);
    cur.unshift(path);
    PrefStore.local.setJson(STORE_KEYS.sandboxRecent,cur.slice(0,5));
  }

  _pickSandbox(list,here,onlyDefault){
    // FR-OPT-11-5 (FEC-27): 본문만 여기서 세우고 골격은 `UIKit.ask` 가 갖는다.
    const body=document.createDocumentFragment();
    const msg=document.createElement('div');msg.className='confirm-msg';
    msg.textContent=t('sbx.profile_title');
    body.appendChild(msg);
    const input=this._sbxWorkdirRow(body,here);
    const picks=sbxWorkPicks(list);
    // FR-SBM-5: 고른 것의 결과. 등급 배지와 **다른 자리**여야 한다 — 배지는
    // 프로파일의 것이고(FR-SBM-4) 이 줄은 이번 선택의 것이다.
    const warn=document.createElement('div');warn.className='sbx-work-warn';
    let work=null,workBtns=null;
    const syncWarn=()=>{
      // 돌아오는 통로가 있는 선택(`copies` 거짓)에 폴더가 있을 때다.
      const on=!!work&&!work.copies&&!!input.value.trim();
      warn.textContent=on?SANDBOX_MOUNT_WARN:'';
      warn.classList.toggle('vis',on);
    };
    const setWork=k=>{
      work=k;
      for(const [key,b] of workBtns) b.classList.toggle('on',!!k&&key===k.work);
      syncWarn();
    };
    workBtns=this._sbxWorkRow(body,picks,setWork);
    body.appendChild(warn);
    input.addEventListener('input',syncWarn);

    // 값은 누르는 순간의 입력이라 `value` 가 아니라 `done` 으로 닫는다.
    let done=null;
    const actions=list.map(p=>this._sbxProfileAction(p,()=>done(sbxPickResult(p,work,input.value.trim()))));
    actions.push({label:t('core.cancel'),cls:'confirm-cancel',tip:TIP_SBX_CANCEL,value:null});
    const hint=onlyDefault?this._sbxDevHint(()=>done(null)):null;
    setWork(sbxDefaultWork(list,picks));
    // FR-KIT-24·25: 이름은 머리(`.confirm-msg`)가 준다.
    return UIKit.ask({body,labelledBy:msg,label:t('sbx.profile_title'),footCls:'sbx-pick',
      actions,escValue:null,focus:input,onOpen:(m,fin)=>{
        done=fin;
        this._sbxGradeBadges(m.foot,list);
        if(hint) m.body.appendChild(hint);
      }});
  }

  /**
   * SANDBOX_PICK_COPY_SRS FR-SPK-3: 작업 폴더 입력은 **언제나** 보인다. 입력란을 돌려준다.
   *
   * 옛 조건(`list.some(p=>p.workspace)`)은 scratch 하나뿐인 환경에서 거짓이라
   * 입력란이 아예 없었고, 그 위의 `mustAsk` 가 창 자체를 띄우지 않았다 —
   * 사용자에게는 "설정창이 안 뜬다" 로 보였다 (§2.1 실측).
   */
  _sbxWorkdirRow(body,here){
    const wrap=document.createElement('div');wrap.className='sbx-workdir';
    const label=document.createElement('label');label.textContent=SANDBOX_WORKDIR_LABEL;
    const input=document.createElement('input');
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
    return input;
  }

  /**
   * UX_BATCH6_SRS FR-SBM-1·2: **작업 방식을 고르는 자리.** 방식 → 버튼의 표를 돌려준다.
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
  _sbxWorkRow(body,picks,setWork){
    const workBtns=new Map();
    if(!picks.length) return workBtns;
    const wrap=document.createElement('div');wrap.className='sbx-work-pick';
    const label=document.createElement('label');label.textContent=SANDBOX_WORK_PICK_LABEL;
    wrap.appendChild(label);
    for(const k of picks){
      const b=document.createElement('button');
      b.type='button';b.className='ui-btn ui-btn-sm sbx-work-opt sbx-work-'+k.work;b.dataset.work=k.work;
      b.textContent=sandboxWorkLabel(k.work);b.title=sandboxWorkTitle(k.work);
      b.addEventListener('click',()=>setWork(k));
      workBtns.set(k.work,b);wrap.appendChild(b);
    }
    body.appendChild(wrap);
    return workBtns;
  }

  /**
   * 프로파일 하나의 버튼. FR-SPK-5 (FR-SBM-1 로 개정): 방식은 이제 **위에서 고른다.** 프로파일이
   * 정하는 것은 기본 선택뿐이므로 버튼에 표기를 겹치지 않는다 — 두 자리가
   * 같은 것을 말하면 어느 쪽이 지금 값인지 알 수 없다.
   */
  _sbxProfileAction(p,onClick){
    const tip=(p.image?p.image+String.fromCharCode(10):'')+
      (p.isolated
        ? t('sbx.isolated_note')
        : t('sbx.not_isolated_note'))+
      String.fromCharCode(10)+sandboxWorkTitle(p.work);
    return {label:p.name,kind:'primary',cls:'confirm-ok sbx-opt',tip,keepOpen:true,onClick};
  }

  /**
   * FR-SPK-7: 고를 것이 scratch 하나뿐이면 늘리는 길을 안내한다. 이것이
   * 없으면 사용자는 `sandbox.json` 이라는 자리가 있다는 것 자체를 모른다 —
   * 접수한 말("프로파일 설정창이 안 뜬다")의 나머지 절반이 이쪽이다.
   */
  _sbxDevHint(close){
    const hint=document.createElement('div');hint.className='sbx-hint';
    hint.textContent=SANDBOX_DEV_HINT;
    const open=document.createElement('button');
    open.type='button';open.className='ui-btn ui-btn-sm sbx-settings';open.textContent=SANDBOX_DEV_SETTINGS;
    open.title=TIP_SBX_SETTINGS;
    // 선택창을 닫고 설정을 연다 — 두 창이 겹치면 어느 쪽이 살아 있는지
    // 알 수 없다.
    open.addEventListener('click',()=>{close();this.app.settings._openSettings('sandbox')});
    hint.appendChild(open);
    return hint;
  }

  /** 등급 배지는 버튼 글자 옆에 선다 — 이름과 한 버튼이어야 무엇의 등급인지 읽힌다. */
  _sbxGradeBadges(foot,list){
    foot.querySelectorAll('.sbx-opt').forEach((b,i)=>{
      const p=list[i];
      const grade=document.createElement('span');
      grade.className='sbx-grade'+(p.isolated?' iso':'');
      grade.textContent=p.isolated?t('sbx.isolated'):t('sbx.not_isolated');
      b.append(' ',grade);
    });
  }

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
  }
}

// 바깥이 부르는 이름 — 레이아웃·슬롯·편집기·Git·설정·`ui/`·e2e·계약.
Controller.delegate(App,'tool',['_isToolBusy','_toolsBusy','_notify','_sbxProgress','_sbxRuntime','_sbxRuntimeModal',
  '_sbxRemember','_pickSandbox','_confirmClose']);
