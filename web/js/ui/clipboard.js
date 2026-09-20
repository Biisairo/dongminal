/**
 * Dongminal — OS 클립보드에 **쓰는 한 자리** (STRUCTURE_CLEANUP_SRS 묶음 A ·
 * FR-STR-10~16)
 *
 * 몸통은 새로 쓴 것이 아니다. `ui/term-clipboard.js` 가 2026-09-15 에 세운
 * 3단(`EXPLORER_TRANSFER_IGNORE_SRS` FR-ETR-40 · D-12)을 **구간 이동**했을
 * 뿐이며 한 줄도 바뀌지 않았다.
 *
 * **옮긴 이유는 이름이다.** 그 파일의 이름이 터미널을 말하고 있어서, 뒤따른 네
 * 자리가 3단을 못 보고 각자 1단이나 2단만 다시 만들었다:
 *
 *   git/panel-poll.js  1·2단      git/dialog.js   2단만
 *   git/confirm.js     2단만      core/app-tool.js 1단만  ← 조용히 실패했다
 *
 * 마지막 자리가 결함이었다 — `navigator.clipboard` 는 secure context 밖에서
 * **아예 없으므로** `writeText` 호출이 `TypeError` 로 던지고 빈 `catch{}` 가
 * 그것을 삼켰다. 사용자에게는 "버튼을 눌러도 아무 일이 안 일어나는 것" 이었다.
 *
 * **쓰기가 세 단으로 내려가는 것이 이 파일의 전부다** (FR-ETR-40, D-12):
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
 *
 * **읽기는 여기 없다** (FR-STR-18). 브라우저가 주지 않는 것에는 폴백이 없어
 * 같은 잣대로 잴 수 없는 물음이다 — `term-pane.js` 가 자기 자리에서 거절을
 * 사용자에게 말한다.
 *
 * CSS 클래스(`.tc-copy*`)·카탈로그 키(`TERM_COPY_*`)·`TERM_COPY_ID` 는
 * **그대로 둔다** (FR-STR-12). 외형도 낱말도 이 묶음의 대상이 아니고 e2e 가 그
 * 이름을 단정한다.
 *
 * 전역 이름이 `Clipboard` 가 **아닌 이유**: 그것은 브라우저가 이미 가진 인터페이스
 * 이름이다 (`navigator.clipboard instanceof Clipboard`). 덮으면 벤더 코드의
 * `instanceof` 가 조용히 갈리고, eslint 의 전역 목록과도 부딪힌다.
 */

const ClipboardWriter={
  /**
   * FR-ETR-40: 세 단으로 내려간다. 앞 단이 **없거나** 실패하면 다음 단이다.
   *
   * 던지지 않는다 — 호출자는 실패에서 화면을 되돌려야 하므로 흐름이 갈리는 것이
   * 아니라 **값이 갈려야 한다** (`edFs` 와 같은 규약).
   *
   * `toolId` 는 선택이다. 있으면 FR-ETR-44 의 게이트가 3단에 걸린다 — 셸이 보낸
   * OSC 52 처럼 **사용자가 부르지 않은 복사**에만 뜻이 있다.
   */
  async write(text,toolId){
    if(navigator.clipboard&&navigator.clipboard.writeText){
      try{ await navigator.clipboard.writeText(text); return true }catch{}
    }
    if(ClipboardWriter._execCopy(text)) return true;
    // FR-ETR-44: 3단은 **사용자가 지금 그 터미널을 보고 있는 브라우저에서만** 선다.
    if(!ClipboardWriter._watchedHere(toolId)) return false;
    ClipboardWriter.prompt(text);
    return false;
  },

  /**
   * FR-ETR-44: 이 브라우저가 지금 그 도구를 보고 있는가.
   *
   * 한 도구의 출력은 **붙어 있는 모든 브라우저로** 간다. 게이트가 없으면 OSC 52
   * 하나에 창마다 복사창이 서고, 사용자는 자기가 보던 창이 아닌 곳에서 그것을
   * 만난다 — 어느 복사의 창인지도 알 수 없고, 닫아도 다른 창에 그대로 남는다.
   *
   * 판정은 `attnUserIsWatching` 을 **그대로 빌린다** (FR-ATA-7). 알림은 보고
   * 있으면 억제하고 복사창은 보고 있을 때만 서지만, "사용자가 지금 이것을 보고
   * 있는가" 라는 물음 자체는 하나다 — 두 벌로 두면 한쪽만 고쳐진다.
   *
   * 판정할 수 없으면(app 이 아직 없거나 toolId 를 모르는 부름) 종전대로 띄운다.
   * 이 게이트가 막으려는 것은 **엉뚱한 창**이지 복사 자체가 아니다.
   */
  _watchedHere(toolId){
    if(!toolId) return true;
    const app=(typeof window!=='undefined')?window.app:null;
    if(!app||typeof app.attnUserIsWatching!=='function') return true;
    return !!app.attnUserIsWatching(toolId);
  },

  /**
   * 숨긴 textarea 를 거쳐 `execCommand('copy')` 를 부른다. 성공 여부를
   * **돌려준다** — 실패를 알아야 다음 단으로 내려간다.
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
    ClipboardWriter.close();
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
    copy.type='button'; copy.className='ui-btn ui-btn-sm ui-btn-primary tc-copy-do'; copy.textContent=TERM_COPY_DO;
    copy.title=TIP_COPY_DO;
    copy.addEventListener('click',()=>{
      // 이 클릭이 곧 제스처다 — 2단이 여기서는 통한다 (D-12).
      ta.focus(); ta.select();
      if(ClipboardWriter._execCopy(text)) ClipboardWriter.close();
      else copy.textContent=TERM_COPY_MANUAL;
    });
    const close=document.createElement('button');
    close.type='button'; close.className='ui-btn ui-btn-sm tc-copy-close'; close.textContent=TERM_COPY_CLOSE;
    close.title=TIP_COPY_CLOSE;
    close.addEventListener('click',()=>ClipboardWriter.close());
    row.appendChild(copy); row.appendChild(close);
    box.appendChild(row);

    // 터미널의 전역 단축키가 타이핑을 먹지 않게 여기서 멈춘다 — 탐색기의 인라인
    // 입력과 같은 이유다 (file-tree.js `_elInput`).
    box.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(e.key==='Escape'){e.preventDefault();ClipboardWriter.close()}
    });

    document.body.appendChild(box);
    ClipboardWriter._cur=box;
    // 붙기 전에는 focus 가 아무 일도 하지 않는다.
    TIMERS.frame(()=>{
      if(!box.isConnected) return;
      ta.focus(); ta.select();
      try{ta.setSelectionRange(0,text.length)}catch{}
    },{owner:this,label:'clip-frame'});
  },

  close(){
    const b=ClipboardWriter._cur;
    ClipboardWriter._cur=null;
    if(b&&b.isConnected) b.remove();
  },

  _cur:null,
};

// 고전 스크립트의 const 는 window 의 속성이 되지 않는다 — e2e 가 창 밖에서
// 부르므로 명시적으로 붙인다 (file-tree.js 와 같은 규약).
window.ClipboardWriter=ClipboardWriter;
