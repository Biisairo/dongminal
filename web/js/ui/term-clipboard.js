/**
 * Dongminal — 터미널의 OSC 52 어댑터 (EXPLORER_TRANSFER_IGNORE_SRS 묶음 F ·
 * FR-ETR-37~43 · STRUCTURE_CLEANUP_SRS FR-STR-11)
 *
 * **xterm.js 는 OSC 52 를 스스로 처리하지 않는다.** 그래서 셸이 보낸 클립보드
 * 쓰기는 받는 사람 없이 버려졌고, 사용자에게는 "복사가 원격에서만 안 된다"로
 * 보였다 — 서버가 열린 자리에서는 iTerm2·Terminal.app 이 그 일을 대신하고 있었을
 * 뿐이다 (§2.5).
 *
 * **쓰기는 여기 없다.** 3단(`navigator.clipboard` → `execCommand` → 복사창)은
 * `ui/clipboard.js` 의 `ClipboardWriter` 로 나갔다 (FR-STR-10). 그 3단은 이
 * 파일이 세운 것이지만 이름이 터미널을 말해서 **뒤따른 네 자리가 그것을 못 보고
 * 각자 다시 만들었다** — 이 파일의 `_execCopy` 가 *"Git 패널의 `_copyFallback`
 * 과 같은 수법"* 이라고 **스스로 적고 있었다.**
 *
 * 남는 것은 이름이 말하는 그대로다: **OSC 52 를 받아 풀어서 넘기는 일.**
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
  attach(term,toolId){
    if(!term||!term.parser||typeof term.parser.registerOscHandler!=='function') return;
    try{
      term.parser.registerOscHandler(52,data=>{TermClipboard._onOsc(String(data||''),toolId);return true});
    }catch{}
  },

  _onOsc(data,toolId){
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
    // `toolId` 를 넘기는 것이 이 자리의 몫이다 (FR-ETR-44) — 셸이 보낸 복사는
    // 사용자가 부른 것이 아니므로, 3단의 창은 **그 도구를 보고 있는 브라우저**
    // 에서만 서야 한다.
    ClipboardWriter.write(text,toolId);
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
   * 종전 진입점 셋. e2e 와 `term-pane.js` 가 창 밖에서 부르므로 **남긴다**
   * (FR-STR-13 · D-STR-2) — 몸통만 옮겼고 계약은 그대로다.
   */
  write(text,toolId){return ClipboardWriter.write(text,toolId)},
  prompt(text){return ClipboardWriter.prompt(text)},
  close(){return ClipboardWriter.close()},
};

// 고전 스크립트의 const 는 window 의 속성이 되지 않는다 — e2e 가 창 밖에서
// 부르므로 명시적으로 붙인다 (file-tree.js 와 같은 규약).
window.TermClipboard=TermClipboard;
