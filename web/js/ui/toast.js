/**
 * Toast — 창 하단 알림 팝업 (TERM_XFER_NOTICE_SRS FR-TXN-2~7).
 *
 * 셸이 소유한 터미널 화면에 남이 쓰면 그 화면은 어긋난다 (§1.2) — 전송 알림은
 * 그래서 화면 밖으로 나왔다.
 *
 * `show` 는 손잡이를 돌려준다. 진행 중인 알림을 **같은 자리에서** 성공·실패로
 * 바꾸기 위한 것이다 (FR-TXN-3).
 */
const Toast = {
  _wrap: null,

  /**
   * NFR-TXN-2 · FR-A11Y-19: 호스트는 **`index.html` 이 정적으로 세운다** — 리전은
   * 내용보다 먼저 있어야 읽힌다. 여기서는 그것을 찾아 쓰고, 소프트 리로드가 body 를
   * 비운 뒤에만 다시 세운다 (`isConnected` 를 함께 보는 이유).
   *
   * 다시 세울 때도 **같은 속성**을 준다. 속성을 `index.html` 에만 적으면 소프트
   * 리로드 뒤의 호스트는 리전이 아니게 되고, 그것은 조용히 일어난다.
   */
  _host(){
    if(this._wrap&&this._wrap.isConnected) return this._wrap;
    const found=document.getElementById('toast-host');
    if(found&&found.isConnected){this._wrap=found;return found}
    const w=document.createElement('div');
    w.className='toast-host'; w.id='toast-host';
    w.setAttribute('role','status');
    w.setAttribute('aria-live','polite');
    w.setAttribute('aria-atomic','false');
    document.body.appendChild(w);
    this._wrap=w; return w;
  },

  /**
   * `kind` 는 ''(진행)·'ok'·'err' 다. `ms` 가 0 이면 스스로 사라지지 않는다
   * (FR-TXN-5).
   *
   * `opts`: `{id, cls, textCls, actions:[{label,title,cls,onClick}]}`
   *
   * **동작 버튼을 받는 것이 `UX-8` 의 요구다.** 종전에는 되돌리기(`.git-undo-toast`)
   * 와 진행(`.sbx-progress`)이 각자 DOM·타이머·닫는 길을 갖고 있었고, 그래서
   * 알림이 넷이었다. 셋을 여기로 모으면 **라이브 리전도 한 자리**가 된다 —
   * 리전이 넷이면 보조기술이 넷을 각각 감시하고, 새 알림을 만드는 사람이 다섯
   * 번째 리전을 잊는다.
   */
  show(text,kind,ms,opts){
    const o=opts||{};
    const acts=o.actions||[];
    const el=document.createElement('div');
    let timer=null;
    const close=()=>{if(timer){timer.stop();timer=null}el.remove()};
    const arm=d=>{
      if(timer){timer.stop();timer=null}
      if(d>0) timer=TIMERS.after(d,close,{owner:'toast',label:'toast'});
    };
    el.className=['toast',kind||'',o.cls||''].filter(Boolean).join(' ');
    if(o.id) el.id=o.id;

    // 문구는 **자기 요소**를 갖는다. 버튼이 붙는 알림에서 글자와 버튼이 나란히
    // 서야 하고, 리전 판정(`liveRegionOf`)도 글자가 든 요소에서 올라간다.
    let textEl=null;
    if(acts.length){
      textEl=document.createElement('span');
      textEl.className=['toast-text',o.textCls||''].filter(Boolean).join(' ');
      textEl.textContent=text;
      el.appendChild(textEl);
      for(const a of acts){
        const b=document.createElement('button');
        b.type='button';
        b.className=['toast-act',a.cls||''].filter(Boolean).join(' ');
        b.textContent=a.label;
        if(a.title) b.title=a.title;
        b.addEventListener('click',ev=>{ev.stopPropagation();if(a.onClick)a.onClick()});
        el.appendChild(b);
      }
    }else{
      el.textContent=text;
      // FR-TXN-6: 자동 소멸을 기다리는 것 말고 출구를 준다.
      //
      // **버튼이 있는 알림에는 주지 않는다.** 거기서는 버튼이 출구이고, 아무 데나
      // 눌러 닫히면 되돌리기를 누르려다 기회를 없앤다.
      el.addEventListener('click',close);
    }
    this._host().appendChild(el);
    arm(ms===undefined?TOAST_MS:ms);
    return {
      el,
      close,
      update(t,k,d){
        if(textEl) textEl.textContent=t; else el.textContent=t;
        el.className=['toast',k||'',o.cls||''].filter(Boolean).join(' ');
        arm(d===undefined?TOAST_MS:d);
      },
    };
  },
};
