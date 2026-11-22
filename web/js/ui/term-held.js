/**
 * TerminalTool — 끊긴 동안의 입력 배너 (UX_BATCH11_SRS FR-HIN-4~8). 보류함 자체는 `TermSocket` 이 갖는다.
 *
 * 부품 `TermHeld`(터미널의 `heldBar`) 이다 (REFACTOR3_FE_REST5_SRS D-FR5-9). 상태를 갖지 않는다 — 필드는 종전대로 터미널 인스턴스에
 * 있고 이 부품은 그것을 `this.pane` 으로 읽고 쓴다. 터미널의 이름은 전부 `this.pane.X` 로 부른다 — e2e·시험이 인스턴스에 갈아 끼운
 * 것을 부품도 본다. 파일 끝의 위임자 표가 이 부품의 이름을 `TerminalTool` 원형에 둔다.
 */
class TermHeld {
  constructor(pane){
    this.pane=pane;
  }

  // ── 끊긴 동안의 입력 (UX_BATCH11_SRS FR-HIN-4~8) ──
  // FR-HIN-4: 다시 붙었고 보류분이 있으면 배너를 세운다. 저절로 보내지 않는다.
  _heldMaybeShow(){ if(this.pane._sock.heldBytes>0) this.pane._heldBanner() }
  _heldBanner(){
    let b=this.pane.el.querySelector('.tp-held');
    if(!b){
      b=document.createElement('div');b.className='tp-held';
      b.setAttribute('role','status');
      const msg=document.createElement('div');msg.className='tp-held-msg';
      const pre=document.createElement('code');pre.className='tp-held-pre ui-scroll-sm';
      const acts=document.createElement('div');acts.className='tp-held-acts';
      acts.appendChild(UIKit.button({label:t('term.held_send'),kind:'primary',size:'sm',onClick:()=>this.pane._heldSend()}));
      acts.appendChild(UIKit.button({label:t('term.held_discard'),size:'sm',onClick:()=>this.pane._heldDiscard()}));
      b.append(msg,pre,acts);
      this.pane.el.appendChild(b);
    }
    const n=this.pane._sock.heldBytes;
    b.querySelector('.tp-held-msg').textContent=t('term.held_title').replace('%d',n)+(this.pane._sock.heldOver?' '+t('term.held_over'):'');
    // 공유 `dec` 를 쓰지 않는다 — 프레임 경계에서 갈린 글자를 잇느라 stream 상태를 쥔다.
    const d=new TextDecoder();
    b.querySelector('.tp-held-pre').textContent=termHeldPreview(this.pane._sock.held.map(m=>d.decode(m.subarray(1),{stream:true})).join('')+d.decode());
  }
  _heldHide(){ const b=this.pane.el.querySelector('.tp-held'); if(b) b.remove() }
  // FR-HIN-5: 담긴 순서대로. 그 사이 다시 끊기면 다시 보류된다.
  _heldSend(){
    for(const m of this.pane._sock.takeHeld()) this.pane._sendUserFrame(m);
    this.pane._heldHide();
    this.pane.focus();
  }
  _heldDiscard(){
    this.pane._sock.takeHeld();
    this.pane._heldHide();
    this.pane.focus();
  }
}

// 터미널 원형의 이름 — 앱·e2e·시험과 다른 부품이 `TerminalTool` 에서 부른다 (REFACTOR3_FE_REST5_SRS D-FR5-9).
Controller.delegate(TerminalTool,'heldBar',['_heldMaybeShow','_heldBanner','_heldHide','_heldSend','_heldDiscard']);
