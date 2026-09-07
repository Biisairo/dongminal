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

  // NFR-TXN-2: 처음 부를 때 만든다. 소프트 리로드가 body 를 비운 뒤에도 다시
  // 서야 하므로 `isConnected` 를 함께 본다.
  _host(){
    if(this._wrap&&this._wrap.isConnected) return this._wrap;
    const w=document.createElement('div');
    w.className='toast-host'; w.id='toast-host';
    document.body.appendChild(w);
    this._wrap=w; return w;
  },

  /**
   * `kind` 는 ''(진행)·'ok'·'err' 다. `ms` 가 0 이면 스스로 사라지지 않는다
   * (FR-TXN-5).
   */
  show(text,kind,ms){
    const el=document.createElement('div');
    let timer=null;
    const close=()=>{if(timer){timer.stop();timer=null}el.remove()};
    const arm=d=>{
      if(timer){timer.stop();timer=null}
      if(d>0) timer=TIMERS.after(d,close,{owner:'toast',label:'toast'});
    };
    el.className='toast'+(kind?' '+kind:'');
    el.textContent=text;
    // FR-TXN-6: 자동 소멸을 기다리는 것 말고 출구를 준다.
    el.addEventListener('click',close);
    this._host().appendChild(el);
    arm(ms===undefined?TOAST_MS:ms);
    return {
      el,
      close,
      update(t,k,d){
        el.textContent=t;
        el.className='toast'+(k?' '+k:'');
        arm(d===undefined?TOAST_MS:d);
      },
    };
  },
};
