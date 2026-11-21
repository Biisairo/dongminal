/**
 * 상태바 인코딩 항목 — 포커스 편집기 문서의 인코딩, 다시 열기·UTF-8 변환 저장
 * (REPO_FIX 03 §3A-2 · 사용자 결정 "인코딩 왕복 + 수동 선택 + UTF-8 로 변환해 저장")
 *
 * 편집기 자체에는 상태 표시줄이 없으므로 전역 상태바가 포커스 칸의 것을 보인다 —
 * `termsize` 가 포커스 터미널일 때만 서는 것과 같은 규약이다.
 *
 * `StatusBarEnc` 는 `StatusBarController` 의 부품이다(`statusbar.enc`, REFACTOR3_FE_APPCTL_SRS 9b).
 */
class StatusBarEnc extends Controller {

  // 포커스 칸의 텍스트 문서 편집기와 그 문서. 버퍼가 없으면(로딩·이진) 없다.
  _sbEncDoc(){
    const v=this.app._edActiveEditor();
    if(!v||v.render||!v._doc||!v._doc.buf) return null;
    return {v,d:v._doc};
  }

  _sbEncLabel(d){
    const base=ENC_LABEL[d.encoding]||d.encoding||ENC_LABEL['utf-8'];
    const withBom=d.encoding==='utf-8'&&d.bom?base+' BOM':base;
    return d.decodable===false?withBom+' · '+ENC_READONLY:withBom;
  }

  // updateStatusBar 가 부른다. 그릴 것이 없으면 빈 문자열이다.
  _sbEncHtml(){
    const got=this._sbEncDoc();
    if(!got) return '';
    const e=escHtml;
    return `<span class="sb-item sb-enc" role="button" tabindex="0" title="${e(ENC_TITLE)}"><span class="mono">${e(this._sbEncLabel(got.d))}</span></span>`;
  }

  /**
   * UX_AUDIT_FIX_SRS FR-UXF-83: 띠를 한 번 보인 언어의 파일인데 서버가 아직 없으면 서는 표식.
   * 켜고 끄는 지표가 아니라 상황 표식이다. 누르면 그 편집기에 띠를 다시 연다.
   */
  _sbLspHtml(){
    const v=this.app._edActiveEditor();
    const s=v&&this.app.lspOfferPending(v);
    if(!s) return '';
    const e=escHtml;
    return `<span class="sb-item sb-lsp-offer" role="button" tabindex="0" title="${e(LSP_OFFER_MARK_TITLE.replace('%s',s.id))}">${e(LSP_OFFER_MARK)}</span>`;
  }

  // 상태바에 한 번만 건다 — 항목은 reconcile 로 새로 만들어지므로 위임한다.
  _sbEncBind(bar){
    if(bar._encBound) return;
    bar._encBound=true;
    const lsp=()=>{const v=this.app._edActiveEditor(); if(v) this.app.lspOfferReopen(v)};
    const open=(el)=>{
      const got=this._sbEncDoc();
      if(!got) return;
      const r=el.getBoundingClientRect();
      this._sbEncMenu(got,{x:r.left,y:r.top});
    };
    bar.addEventListener('click',(ev)=>{
      const el=/** @type {HTMLElement} */ (ev.target).closest('.sb-enc');
      if(el) open(el);
      if(/** @type {HTMLElement} */ (ev.target).closest('.sb-lsp-offer')) lsp();
    });
    bar.addEventListener('keydown',(ev)=>{
      if(ev.key!=='Enter'&&ev.key!==' ') return;
      const el=/** @type {HTMLElement} */ (ev.target).closest('.sb-enc');
      if(el){ev.preventDefault();open(el)}
      if(/** @type {HTMLElement} */ (ev.target).closest('.sb-lsp-offer')){ev.preventDefault();lsp()}
    });
  }

  _sbEncMenu({v,d},at){
    const path=v.filePath;
    const items=[{label:ENC_REOPEN,static:true}];
    for(const id of serverMeta.encodings){
      items.push({id:'reopen-'+id,label:ENC_LABEL[id]||id,cur:d.encoding===id,
        onClick:()=>this.app.edDocReopen(path,id)});
    }
    items.push({sep:true});
    // 변환할 수 있는지는 서버의 답이다 (SERVER_DRIVEN_ACTIONS_SRS X-e).
    const st=actionState(d.actions?d.actions['file.convert_utf8']:null,false);
    items.push({id:'to-utf8',label:ENC_CONVERT,disabled:st.enabled?false:st.why,onClick:()=>this.app.edDocConvertUtf8(path)});
    UIKit.menu(items,{at,cls:'sb-enc-menu',flipGap:4});
  }
}
