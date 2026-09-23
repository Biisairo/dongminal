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
  attach(term,toolId,pane){
    if(!term||!term.parser||typeof term.parser.registerOscHandler!=='function') return;
    try{
      term.parser.registerOscHandler(52,data=>{TermClipboard._onOsc(String(data||''),toolId,pane);return true});
    }catch{}
  },

  /**
   * COPY_POPUP_ORIGIN_SRS FR-CPO-1·2·3: 출력이 **도착한 순간**에 판정한다.
   *
   *   이전 동작: 판정(FR-ETR-44)은 xterm 이 OSC 52 를 **처리하는 순간**에 물었다
   *   새  동작: 바이트가 WebSocket 으로 닿는 순간 묻고, 그 답을 그 바이트와 함께 넘긴다
   *   이유:     처리는 도착보다 늦을 수 있다. 뒤에 있던 B 가 포커스를 받은 **뒤**에
   *             파싱하면 그때 판정이 참이 되어, A 에서 한 복사의 창이 B 에서 섰다
   *             (접수 2026-09-24). 재생은 옛 OSC 52 를 다시 파싱해 같은 일을 했다
   *
   * 라이브로 도착한 것만 복사다 (FR-CPO-2) — 좌표(`OpSeq`) 전의 바이트는 재생이다.
   * 한 flush 에 묶이는 조각들은 **모두** 쓰는 화면에서 도착해야 참이다 (FR-CPO-5).
   */
  arrive(pane){
    const ok=!!pane._seqLive&&TermClipboard._usingHere(pane);
    pane._clipOk=(pane._clipOk!==false)&&ok;
  },

  /**
   * FR-CPO-5 · NFR-CPO-2: xterm 에 넘기는 한 번의 쓰기에 그 묶음의 판정을 싣는다.
   *
   * xterm 은 쓰기를 넣은 순서대로 처리하고, 콜백은 그 쓰기의 파싱이 **끝난 뒤**에
   * 부른다. 그래서 핸들러가 불리는 동안 큐의 머리가 곧 그 쓰기의 판정이다.
   *
   * 보류된 조각(`_outputBuf`, FR-FTR-8)이 남으면 판정을 **이어 간다** — 그 조각도
   * 같은 도착들의 것이다. 남은 것이 없을 때만 다음 묶음을 새로 판정한다.
   */
  feed(pane,text){
    const ok=pane._clipOk===true;
    if(!pane._outputBuf) pane._clipOk=undefined;
    if(!text) return;
    (pane._clipQ||(pane._clipQ=[])).push(ok);
    pane.term.write(text,()=>{pane._clipQ.shift()});
  },

  /**
   * FR-CPO-3: 사용자가 지금 **이 브라우저로** 그 도구를 쓰고 있는가.
   *
   * OS 포커스·활성 탭(`attnUserIsWatching`)만으로는 모자란다 — 다른 컴퓨터는 각자
   * OS 포커스를 가져, 사용자가 보고 있지 않은 기기도 참이 된다. 여러 기기를 가로질러
   * "지금 쓰는 화면" 을 아는 것은 소유권 하나다 (`resizeCheck` — FR-XDF-2). 드래그의
   * 클릭이 그 화면을 주인으로 세운다.
   */
  _usingHere(pane){
    const app=(typeof window!=='undefined')?window.app:null;
    if(!app) return false;
    const watch=typeof app.attnUserIsWatching==='function'?app.attnUserIsWatching(pane.id):false;
    const own=typeof app.resizeCheck==='function'?app.resizeCheck(pane.id,pane._slot):false;
    return !!watch&&!!own;
  },

  _onOsc(data,toolId,pane){
    // FR-CPO-1·4·6: 이 쓰기가 **도착 때 받은 판정**이 거짓이면 세 단 모두 하지 않는다.
    // 판정이 없으면(도착 경로를 지나지 않은 쓰기 — 열리기 전 버퍼 등) 참으로 읽지 않는다.
    if(!pane||!pane._clipQ||!pane._clipQ[0]) return;
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
