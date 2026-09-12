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
    // FR-LAY-3: 숨김은 `[hidden]` 하나다 — 종전 `.hidden` 클래스를 옮겼다.
    if(!bar.hidden){this.closeSearch();return}
    bar.hidden=false;
    document.getElementById('search-input').focus();
    for(const pane of this.tools.values())if(pane.el.classList.contains('vis'))pane.doFit();
  },
  closeSearch(){
    const bar=document.getElementById('search-bar');
    bar.hidden=true;
    document.getElementById('search-input').value='';
    document.getElementById('search-count').textContent='';
    this.clearAllSearchDecorations();
    this.focusedTerminal()?.focus();
    for(const pane of this.tools.values())if(pane.el.classList.contains('vis'))pane.doFit();
  },
  clearAllSearchDecorations(){
    for(const p of this.tools.values())if(p.search)p.search.clearDecorations();
  },
  _searchOpen(){return !document.getElementById('search-bar').hidden},
  researchIfOpen(){
    if(!this._searchOpen())return;
    this.timers.after(50,()=>this.doSearch('next'),{owner:'app',label:'search-first'});
  },
  focusedTerminal(){
    if(!this.focused)return null;
    const s=this.aw();if(!s)return null;
    const pn=findPane(s.layout,this.focused);if(!pn)return null;
    const tab=pn.tabs.find(t=>t.id===this.paneTab(pn));
    if(!tab||tab.type!=='terminal')return null;
    return this.tools.get(tab.toolId);
  },
  // FUI-15: 토글 하나의 상태. id 하나로 묻는 자리가 넷이라 여기 모은다.
  _searchOpt(id){
    const el=document.getElementById(id);
    return !!(el&&el.classList.contains('active'));
  },

  /**
   * `12-func-ui.md FUI-15`: **일치 수와 자리를 보인다.**
   *
   *   이전 동작: `#search-count` 는 `''`(찾음) 또는 `'없음'` 둘뿐이었다. 몇
   *             번째인지도 몇 개인지도 알 수 없어, 사용자는 Enter 를 눌러 가며
   *             처음 본 자리로 돌아오는지 세야 했다
   *   새  동작: `n/N` 이다. 편집기 찾기 줄이 이미 그렇게 한다
   *   이유:     벤더 addon 이 `onDidChangeResults({resultIndex,resultCount})` 를
   *             **이미 내고 있었다** — 쓰지 않고 있었을 뿐이다
   *
   * 구독은 패널마다 한 번이다. `findNext` 마다 붙이면 같은 콜백이 쌓인다.
   */
  _searchBindResults(p){
    if(!p||!p.search||p._searchSub) return;
    if(typeof p.search.onDidChangeResults!=='function') return;
    p._searchSub=p.search.onDidChangeResults(r=>{
      // 이 패널이 더 이상 검색 대상이 아니면 남의 수를 적지 않는다.
      if(this.focusedTerminal()!==p) return;
      this._searchPaintCount(r);
    });
  },

  /**
   * 결과 하나를 `n/N` 으로 적는다.
   *
   * addon 은 정규식이 깨졌을 때도 `resultCount:0` 을 낸다 — "없음" 과 구분되지
   * 않으므로 **정규식의 유효성은 우리가 판정한다** (아래 `doSearch`).
   */
  _searchPaintCount(r){
    const el=document.getElementById('search-count');
    if(!el) return;
    if(!r||!r.resultCount){el.textContent=SEARCH_NONE;return}
    // `resultIndex` 는 0-based 이고 아무것도 고르지 않았으면 -1 이다.
    const at=(typeof r.resultIndex==='number'&&r.resultIndex>=0)?(r.resultIndex+1):0;
    el.textContent=at?(at+'/'+r.resultCount):String(r.resultCount);
  },

  doSearch(dir){
    const p=this.focusedTerminal();if(!p||!p.search)return;
    const q=document.getElementById('search-input').value;
    const count=document.getElementById('search-count');
    if(!q){count.textContent='';this.clearAllSearchDecorations();return}
    const cs=this._searchOpt('search-case');
    const word=this._searchOpt('search-word');
    const regex=this._searchOpt('search-regex');
    // FUI-15: 깨진 정규식은 **그 사실을 말한다.** addon 은 그때도 0건을 내므로
    // "없음" 과 구분되지 않는다 — 사용자는 자기 패턴이 틀렸다는 것을 알아야 한다.
    if(regex){
      try{ new RegExp(q) }catch{ count.textContent=SEARCH_BAD_REGEX; return }
    }
    this._searchBindResults(p);
    const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const ab=getComputedStyle(document.documentElement).getPropertyValue('--accent-border').trim();
    const danger=getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    const opts={regex,wholeWord:word,caseSensitive:cs,incremental:true,
      decorations:{matchBackground:hexToRgba(accent,.4),matchBorder:ab,
        activeMatchBackground:hexToRgba(danger,.5),activeMatchBorder:danger}};
    const found=dir==='prev'?p.search.findPrevious(q,opts):p.search.findNext(q,opts);
    // 구독이 없는(옛) addon 에서도 화면이 비지 않게 여기서 한 번 적는다.
    // 구독이 있으면 그쪽이 같은 값을 곧 덮는다.
    if(!p._searchSub) count.textContent=found!==undefined?(found?'':SEARCH_NONE):'';
    else if(found===false) count.textContent=SEARCH_NONE;
  },
});
