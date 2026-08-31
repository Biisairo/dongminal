/**
 * Remote Terminal — App 검색 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 7개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  // ── Search ──
  toggleSearch(){
    const bar=document.getElementById('search-bar');
    if(!bar.classList.contains('hidden')){this.closeSearch();return}
    bar.classList.remove('hidden');
    document.getElementById('search-input').focus();
    for(const pane of this.tools.values())if(pane.el.classList.contains('vis'))pane.doFit();
  },
  closeSearch(){
    const bar=document.getElementById('search-bar');
    bar.classList.add('hidden');
    document.getElementById('search-input').value='';
    document.getElementById('search-count').textContent='';
    this._clearAllSearchDecorations();
    this._focusedTerminal()?.focus();
    for(const pane of this.tools.values())if(pane.el.classList.contains('vis'))pane.doFit();
  },
  _clearAllSearchDecorations(){
    for(const p of this.tools.values())if(p.search)p.search.clearDecorations();
  },
  _searchOpen(){return !document.getElementById('search-bar').classList.contains('hidden')},
  _researchIfOpen(){
    if(!this._searchOpen())return;
    setTimeout(()=>this._doSearch('next'),50);
  },
  _focusedTerminal(){
    if(!this.focused)return null;
    const s=this._aw();if(!s)return null;
    const pn=findPane(s.layout,this.focused);if(!pn)return null;
    const tab=pn.tabs.find(t=>t.id===this.paneTab(pn));
    if(!tab||tab.type!=='terminal')return null;
    return this.tools.get(tab.toolId);
  },
  _doSearch(dir){
    const p=this._focusedTerminal();if(!p||!p.search)return;
    const q=document.getElementById('search-input').value;
    const cs=document.getElementById('search-case').classList.contains('active');
    if(!q){document.getElementById('search-count').textContent='';return}
    const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const ab=getComputedStyle(document.documentElement).getPropertyValue('--accent-border').trim();
    const danger=getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    const opts={regex:false,wholeWord:false,caseSensitive:cs,incremental:true,
      decorations:{matchBackground:hexToRgba(accent,.4),matchBorder:ab,
        activeMatchBackground:hexToRgba(danger,.5),activeMatchBorder:danger}};
    const found=dir==='prev'?p.search.findPrevious(q,opts):p.search.findNext(q,opts);
    document.getElementById('search-count').textContent=found!==undefined?(found?'':'없음'):'';
  },
});
