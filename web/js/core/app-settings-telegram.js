/**
 * Dongminal — 설정창의 **Telegram 패널** (TELEGRAM_BRIDGE_SRS FR-TGB-1·10).
 *
 * 봇 token 은 쓰기 전용이다. 서버는 token 을 돌려주지 않으므로 입력 칸은 늘 비어 있고,
 * 저장한 뒤에도 비운다 (FR-TGB-3). 등록 코드는 만든 응답에만 있어 이 창의 메모리에만 둔다.
 * 코드가 살아 있는 동안 주기적으로 다시 읽어 등록이 끝났는지 본다.
 */

/** 등록 코드의 남은 시간과 등록 여부를 다시 보는 주기. */
const TG_PAIR_TICK_MS=2000;

Object.assign(App.prototype, {
  _tgPaint(v=this._tg){
    if(!v||!document.getElementById('panel-telegram')) return;
    document.getElementById('tg-enabled').checked=!!v.enabled;
    document.getElementById('tg-bot').textContent=v.tokenSet
      ?t('tg.bot_set',{name:v.botName?'@'+v.botName:''}):t('tg.bot_none');
    document.getElementById('tg-account').textContent=v.paired?t('tg.paired'):t('tg.unpaired');
    document.getElementById('tg-unpair').hidden=!v.paired;
    const sil=document.getElementById('tg-silence');
    if(document.activeElement!==sil) sil.value=String(v.silenceMin??'');
    this._tgPairPaint();
  },

  _tgPairPaint(){
    const v=this._tg;
    const mine=this._tgPair;
    const left=mine?peerRemain(mine.expires,Date.now()):'';
    // 내 코드는 만료되었거나, 서버에 더는 살아 있는 코드가 없을 때(등록됨·해제) 버린다.
    if(mine&&(!left||!(v&&v.pair))) this._tgPair=null;
    const box=document.getElementById('tg-pair-box');
    box.hidden=!this._tgPair;
    document.getElementById('tg-pair-code').value=this._tgPair?'/pair '+this._tgPair.code:'';
    document.getElementById('tg-pair-remain').textContent=this._tgPair?left:'';
  },

  async _tgRead(){
    const r=await apiGet('/api/telegram');
    if(r.ok&&r.data){ this._tg=r.data; this._tgPaint() }
    return r;
  },

  _loadTelegramPanel(){
    return statusRun(document.getElementById('tg-token-status'),{fail:t('tg.read_fail')},()=>this._tgRead());
  },

  /** 저장 응답이 곧 새 화면 값이다. */
  _tgApply(r){
    if(r.ok&&r.data){ this._tg=r.data; this._tgPaint() }
    return r;
  },

  _tgPairShown(){
    const panel=document.getElementById('panel-telegram');
    const overlay=document.getElementById('modal-overlay');
    return !!(this._tgPair&&panel&&!panel.hidden&&overlay&&overlay.classList.contains('open'));
  },

  _initTelegramPanel(){
    const save=document.getElementById('tg-token-save');
    if(!save) return;
    const tokSt=document.getElementById('tg-token-status');
    document.getElementById('tg-enabled').addEventListener('change',e=>statusRun(tokSt,
      {ok:t('core.saved'),fail:t('core.save_fail')},
      async()=>this._tgApply(await apiPut('/api/telegram/enabled',{enabled:e.target.checked}))));
    save.addEventListener('click',()=>{
      const inp=document.getElementById('tg-token');
      const token=inp.value.trim();
      if(!token) return;
      statusRun(tokSt,{pending:t('tg.checking'),ok:t('core.saved'),fail:t('core.save_fail')},async()=>{
        const r=this._tgApply(await apiPut('/api/telegram/token',{token}));
        if(r.ok) inp.value='';
        return r;
      });
    });
    const pairSt=document.getElementById('tg-pair-status');
    document.getElementById('tg-pair-make').addEventListener('click',()=>statusRun(pairSt,{fail:t('tg.pair_fail')},async()=>{
      const r=await apiPost('/api/telegram/pair',{});
      if(r.ok&&r.data){
        this._tgPair={code:r.data.code,expires:r.data.expires};
        if(this._tg) this._tg.pair={expires:r.data.expires};
        this._tgPairPaint();
      }
      return r;
    }));
    document.getElementById('tg-unpair').addEventListener('click',()=>statusRun(pairSt,
      {ok:t('tg.unpaired'),fail:t('core.save_fail')},
      async()=>this._tgApply(await apiDel('/api/telegram/pair'))));
    document.getElementById('tg-silence-save').addEventListener('click',()=>statusRun(
      document.getElementById('tg-silence-status'),{ok:t('core.saved'),fail:t('core.save_fail')},
      async()=>this._tgApply(await apiPut('/api/telegram/silence',
        {minutes:parseInt(document.getElementById('tg-silence').value,10)||0}))));
    this.timers.every({
      id:'telegram.pair', owner:'telegram', whenHidden:'pause',
      every:()=>TG_PAIR_TICK_MS,
      when:()=>this._tgPairShown(),
      run:()=>this._tgRead(),
    });
  },
});
