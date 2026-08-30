/**
 * Dongminal — 터미널의 클립보드 (EXPLORER_TRANSFER_IGNORE_SRS 묶음 F ·
 * FR-ETR-37~43)
 *
 * **xterm.js 는 OSC 52 를 스스로 처리하지 않는다.** 그래서 셸이 보낸 클립보드
 * 쓰기는 받는 사람 없이 버려졌고, 사용자에게는 "복사가 원격에서만 안 된다"로
 * 보였다 — 서버가 열린 자리에서는 iTerm2·Terminal.app 이 그 일을 대신하고 있었을
 * 뿐이다 (§2.5).
 *
 * 쓰기가 **세 단으로 내려가는 것이 이 파일의 전부다** (FR-ETR-40, D-12):
 *
 *   1. `navigator.clipboard.writeText` — secure context 에서만 존재한다.
 *      원격 접속은 `http://100.x` 라 여기서 이미 없다.
 *   2. `document.execCommand('copy')` — 사용자 제스처가 없으면 거부될 수 있다.
 *      OSC 52 는 셸이 보내는 것이라 제스처가 없다.
 *   3. 복사창 — 사용자의 클릭을 빌려 2단의 보장을 만든다. 마지막 수단이지만
 *      **환경이 무엇이든 통하는 유일한 단**이다.
 *
 * 1·2 가 실패하는 것은 코드의 잘못이 아니라 환경이 정하는 것이므로, 3 이 없으면
 * 이 기능은 "될 때도 있고 안 될 때도 있는 것" 이 된다.
 */

// FR-ETR-43: 셸이 보낸 것을 그대로 메모리에 올리는 자리다. 상한이 **있다**는
// 것이 값보다 중요하다.
const OSC52_MAX_BYTES=1<<20;

const TermClipboard={
  /**
   * FR-ETR-37: 터미널에 OSC 52 핸들러를 붙인다. 부르는 쪽은 term 을 만든 직후다.
   *
   * 핸들러는 언제나 `true` 를 돌려준다 — `false` 면 xterm 이 처리되지 않은 것으로
   * 보고 잔재를 화면에 찍는다 (FR-ETR-42). 내용을 버리는 경우(읽기 요청·상한
   * 초과)에도 "우리가 처리했다" 는 사실은 같다.
   */
  attach(term){
    if(!term||!term.parser||typeof term.parser.registerOscHandler!=='function') return;
    try{
      term.parser.registerOscHandler(52,data=>{TermClipboard._onOsc(String(data||''));return true});
    }catch{}
  },

  _onOsc(data){
    // 형식은 `<targets>;<base64>` 다. targets 는 가르지 않는다 — 브라우저에는
    // 클립보드가 하나뿐이라 c·p·s 를 나눌 자리가 없다.
    const i=data.indexOf(';');
    if(i<0) return;
    const payload=data.slice(i+1);
    // FR-ETR-39 (D-13): `?` 는 **읽기 요청**이다. 응답하지 않는다 — 원격의 셸에
    // 사용자의 클립보드를 넘기는 통로를 열지 않는다.
    if(payload==='?') return;
    if(payload.length>OSC52_MAX_BYTES) return;
    const text=TermClipboard._decode(payload);
    if(!text) return;
    TermClipboard.write(text);
  },

  /**
   * FR-ETR-38: base64 를 **바이트로 풀고 UTF-8 로 읽는다.**
   *
   * `atob` 의 결과를 그대로 쓰면 한글이 깨진다 — 그것은 코드 유닛 하나가 바이트
   * 하나인 문자열이지, 사람이 읽을 문자열이 아니다.
   */
  _decode(b64){
    try{
      const bin=atob(b64);
      const bytes=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }catch{return ''}
  },

  /**
   * FR-ETR-40: 세 단으로 내려간다. 앞 단이 **없거나** 실패하면 다음 단이다.
   */
  async write(text){
    if(navigator.clipboard&&navigator.clipboard.writeText){
      try{ await navigator.clipboard.writeText(text); return true }catch{}
    }
    if(TermClipboard._execCopy(text)) return true;
    TermClipboard.prompt(text);
    return false;
  },

  /**
   * 숨긴 textarea 를 거쳐 `execCommand('copy')` 를 부른다. Git 패널의
   * `_copyFallback` 과 같은 수법이며(panel.js), 여기서는 성공 여부를 **돌려준다** —
   * 실패를 알아야 다음 단으로 내려간다.
   *
   * `readOnly` 를 쓰지 않는 이유: iOS 는 readOnly 인 요소의 선택을 무시한다.
   */
  _execCopy(text){
    const ta=document.createElement('textarea');
    ta.value=text;
    ta.setAttribute('aria-hidden','true');
    // 화면 밖으로 밀되 `display:none` 은 쓰지 않는다 — 보이지 않는 요소는 선택할
    // 수 없어 복사도 되지 않는다.
    ta.style.cssText='position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    let ok=false;
    try{
      ta.focus(); ta.select();
      ta.setSelectionRange(0,text.length);
      ok=document.execCommand('copy');
    }catch{ok=false}
    ta.remove();
    return ok;
  },

  /**
   * FR-ETR-40·41: 마지막 수단. 내용을 담은 창을 띄우고 **미리 선택해 둔다** —
   * 누르지 않고 `Cmd/Ctrl+C` 로 끝낼 수 있어야 한다.
   *
   * 한 번에 하나다. 겹치면 어느 내용의 창인지 알 수 없다.
   */
  prompt(text){
    TermClipboard.close();
    const box=document.createElement('div');
    box.className='tc-copy';
    box.id=TERM_COPY_ID;

    const head=document.createElement('div');
    head.className='tc-copy-head';
    head.textContent=TERM_COPY_TITLE;
    box.appendChild(head);

    const why=document.createElement('div');
    why.className='tc-copy-why';
    why.textContent=TERM_COPY_WHY;
    box.appendChild(why);

    const ta=document.createElement('textarea');
    ta.className='tc-copy-text';
    ta.value=text;
    ta.spellcheck=false;
    box.appendChild(ta);

    const row=document.createElement('div');
    row.className='tc-copy-row';
    const copy=document.createElement('button');
    copy.type='button'; copy.className='tc-copy-do'; copy.textContent=TERM_COPY_DO;
    copy.addEventListener('click',()=>{
      // 이 클릭이 곧 제스처다 — 2단이 여기서는 통한다 (D-12).
      ta.focus(); ta.select();
      let ok=false;
      try{ok=document.execCommand('copy')}catch{ok=false}
      if(ok) TermClipboard.close();
      else copy.textContent=TERM_COPY_MANUAL;
    });
    const close=document.createElement('button');
    close.type='button'; close.className='tc-copy-close'; close.textContent=TERM_COPY_CLOSE;
    close.addEventListener('click',()=>TermClipboard.close());
    row.appendChild(copy); row.appendChild(close);
    box.appendChild(row);

    // 터미널의 전역 단축키가 타이핑을 먹지 않게 여기서 멈춘다 — 탐색기의 인라인
    // 입력과 같은 이유다 (file-tree.js `_elInput`).
    box.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(e.key==='Escape'){e.preventDefault();TermClipboard.close()}
    });

    document.body.appendChild(box);
    TermClipboard._cur=box;
    // 붙기 전에는 focus 가 아무 일도 하지 않는다.
    requestAnimationFrame(()=>{
      if(!box.isConnected) return;
      ta.focus(); ta.select();
      try{ta.setSelectionRange(0,text.length)}catch{}
    });
  },

  close(){
    const b=TermClipboard._cur;
    TermClipboard._cur=null;
    if(b&&b.isConnected) b.remove();
  },

  _cur:null,
};

// 고전 스크립트의 const 는 window 의 속성이 되지 않는다 — e2e 가 창 밖에서
// 부르므로 명시적으로 붙인다 (file-tree.js 와 같은 규약).
window.TermClipboard=TermClipboard;
