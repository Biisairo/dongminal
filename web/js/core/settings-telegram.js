/**
 * Otterminal — 설정창의 **Telegram 패널** (TELEGRAM_BRIDGE_SRS FR-TGB-1·10).
 *
 * 봇 token 은 쓰기 전용이다. 서버는 token 을 돌려주지 않으므로 입력 칸은 늘 비어 있고,
 * 저장한 뒤에도 비운다 (FR-TGB-3). 등록 코드는 만든 응답에만 있어 이 창의 메모리에만 둔다.
 * 코드가 살아 있는 동안 주기적으로 다시 읽어 등록이 끝났는지 본다.
 *
 * REFACTOR3_FE_SETTINGS_SRS 8c: 등록 코드(`_tgPair`)와 그 주기 타이머는 이 섹션이 든다. 서버 값 `_tg` 는 저장 단추
 * 판정(`settings-save-state.js`)이 읽으므로 App 에 남는다(FR-FES-5).
 */

class TelegramSection extends SettingsSection {
  constructor(app){ super(app,'telegram') }

  _tgPaint(v=this.app._tg){
    if(!v||!document.getElementById('panel-telegram')) return;
    document.getElementById('tg-enabled').checked=!!v.enabled;
    document.getElementById('tg-bot').textContent=v.tokenSet
      ?t('tg.bot_set',{name:v.botName?'@'+v.botName:''}):t('tg.bot_none');
    document.getElementById('tg-account').textContent=v.paired?t('tg.paired'):t('tg.unpaired');
    document.getElementById('tg-unpair').hidden=!v.paired;
    const sil=document.getElementById('tg-silence');
    if(document.activeElement!==sil) sil.value=String(v.silenceMin??'');
    this._tgPairPaint();
    if(this.app.settings.saveState._saveBtnsPaint) this.app.settings.saveState._saveBtnsPaint(); // UX_AUDIT_FIX_SRS FR-UXF-72: 서버 값이 새 기준이다
  }

  _tgPairPaint(){
    const v=this.app._tg;
    const mine=this._tgPair;
    const left=mine?edgeRemain(mine.expires,Date.now()):'';
    // 내 코드는 만료되었거나, 서버에 더는 살아 있는 코드가 없을 때(등록됨·해제) 버린다.
    if(mine&&(!left||!(v&&v.pair))) this._tgPair=null;
    const box=document.getElementById('tg-pair-box');
    box.hidden=!this._tgPair;
    document.getElementById('tg-pair-code').value=this._tgPair?'/pair '+this._tgPair.code:'';
    document.getElementById('tg-pair-remain').textContent=this._tgPair?left:'';
  }

  async _tgRead(){
    const r=await apiGet('/api/telegram');
    if(r.ok&&r.data){ this.app._tg=r.data; this._tgPaint() }
    return r;
  }

  _loadTelegramPanel(){
    return statusRun(document.getElementById('tg-token-status'),{fail:t('tg.read_fail')},()=>this._tgRead());
  }

  /** CHANNEL_PROTOCOL C2b (OQ-C1): `telegram` 토픽의 full. 짝맞춤이 끝나면 여기로 온다. */
  _tgTopic(src){ return src.then(r=>this._tgApply(r)) }

  /** 저장 응답이 곧 새 화면 값이다. */
  _tgApply(r){
    if(r.ok&&r.data){ this.app._tg=r.data; this._tgPaint() }
    return r;
  }

  _tgPairShown(){
    const panel=document.getElementById('panel-telegram');
    const overlay=document.getElementById('modal-overlay');
    return !!(this._tgPair&&panel&&!panel.hidden&&overlay&&overlay.classList.contains('open'));
  }

  init(){
    const save=document.getElementById('tg-token-save');
    if(!save) return;
    const tokSt=document.getElementById('tg-token-status');
    this.listen(document.getElementById('tg-enabled'),'change',e=>statusRun(tokSt,
      {ok:t('core.saved'),fail:t('core.save_fail')},
      async()=>this._tgApply(await apiPut('/api/telegram/enabled',{enabled:e.target.checked}))));
    this.listen(save,'click',()=>{
      const inp=document.getElementById('tg-token');
      const token=inp.value.trim();
      if(!token) return;
      statusRun(tokSt,{pending:t('tg.checking'),ok:t('core.saved'),fail:t('core.save_fail')},async()=>{
        const r=this._tgApply(await apiPut('/api/telegram/token',{token}));
        if(r.ok){ inp.value=''; if(this.app.settings.saveState._saveBtnsPaint) this.app.settings.saveState._saveBtnsPaint() }
        return r;
      });
    });
    const pairSt=document.getElementById('tg-pair-status');
    this.listen(document.getElementById('tg-pair-make'),'click',()=>statusRun(pairSt,{fail:t('tg.pair_fail')},async()=>{
      const r=await apiPost('/api/telegram/pair',{});
      if(r.ok&&r.data){
        this._tgPair={code:r.data.code,expires:r.data.expires};
        if(this.app._tg) this.app._tg.pair={expires:r.data.expires};
        this._tgPairPaint();
      }
      return r;
    }));
    this.listen(document.getElementById('tg-unpair'),'click',()=>statusRun(pairSt,
      {ok:t('tg.unpaired'),fail:t('core.save_fail')},
      async()=>this._tgApply(await apiDel('/api/telegram/pair'))));
    this.listen(document.getElementById('tg-silence-save'),'click',()=>statusRun(
      document.getElementById('tg-silence-status'),{ok:t('core.saved'),fail:t('core.save_fail')},
      async()=>this._tgApply(await apiPut('/api/telegram/silence',
        {minutes:parseInt(document.getElementById('tg-silence').value,10)||0}))));
    this.app.timers.every({
      id:'telegram.pair', owner:this, whenHidden:'pause',
      every:()=>TG_PAIR_TICK_MS,
      when:()=>this._tgPairShown(),
      // 등록 여부는 `telegram` 토픽이 준다(`_tgTopic`) — 여기서는 남은 시간만 다시 그린다 (D-9).
      run:()=>this._tgPairPaint(),
    });
  }

  onTab(){ return this._loadTelegramPanel() }
}
