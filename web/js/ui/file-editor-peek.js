/**
 * EdDiffPeek — 변경 표시의 칸 하나의 클릭과 팝업 (EDITOR_DIRTY_DIFF_SRS FR-EDD-30~37). `FileEditor` 의 부품이다
 * (REFACTOR3_FE_REST5_SRS FR-FR5-23 — 옛 `file-editor-diff.js` 의 `Object.assign(FileEditor.prototype, …)` `_dd*`).
 *
 * 팝업은 **칸의 것**이다 — block widget 이 칸의 상태에 있고, 두 칸이 같은 파일을
 * 볼 때 한쪽에서 연 팝업이 다른 칸의 화면을 밀어야 할 이유가 없다. 조각과 기준은
 * 문서의 것이므로(`EdDirtyDiff`) 여기서 다시 계산하지 않는다.
 *
 * 문서의 변경 표시(`EdDirtyDiff`)는 칸이 `_dd` 로 들고, 그 관리자의 칸 목록에도 칸(`this.ed`)이 선다 — 거터 클릭과
 * 관리자의 `_sync` 가 칸의 `peek` 를 부른다.
 */
class EdDiffPeek {
  constructor(ed) {
    this.ed = ed;
    this.node = null;
    this.change = null;
  }

  init(){
    const app=window.app;
    if(!app||!app.edDirtyDiff||!this.ed._view||!this.ed._buf) return;
    this.ed._dd=app.edDirtyDiff(this.ed.filePath);
    this.ed._dd.views.add(this.ed);
    this.ed._dd.attach(this.ed._buf);
    // 이미 계산이 끝난 문서를 두 번째 칸이 붙였을 수 있다 — 그때는 attach 가
    // 아무것도 하지 않으므로 여기서 한 번 칠한다.
    if(this.ed._dd.settled) this.ed._dd.recompute();
  }

  // FR-CMR-41: 표식을 누르면 그 조각의 팝업, 표식이 없는 줄이면 닫는다.
  click(line){
    const ch=this.ed._dd?this.ed._dd.changeAt(line):null;
    if(!ch){this.close();return}
    this.open(ch);
  }

  open(ch){
    this.close();
    const dd=this.ed._dd,view=this.ed._view;
    if(!dd||!view) return;
    const old=dd.baseLines(ch);
    const node=document.createElement('div');
    node.className='fe-dd-peek';
    node.innerHTML=
      '<div class="fe-dd-peek-bar">'+
        '<button type="button" class="ui-btn ui-btn-sm fe-dd-peek-act" data-act="revert" title="'+
          escHtml(ED_DD_REVERT_TITLE)+'">'+escHtml(ED_DD_REVERT)+'</button>'+
        '<button type="button" class="ui-btn ui-btn-sm fe-dd-peek-act" data-act="stage" title="'+
          escHtml(ED_DD_STAGE_TITLE)+'">'+escHtml(ED_DD_STAGE)+'</button>'+
        '<span class="fe-dd-peek-note"></span>'+
        '<button type="button" class="ui-btn ui-btn-icon ui-btn-sm ui-btn-ghost fe-dd-peek-close" title="'+
          escHtml(ED_DD_PEEK_CLOSE_TITLE)+'" aria-label="'+escHtml(ED_DD_PEEK_CLOSE_TITLE)+'">'+
          UIKit.iconHTML('x')+'</button>'+
      '</div>'+
      '<pre class="fe-dd-peek-old ui-scroll"></pre>';
    // FR-EDD-32: 파일의 내용은 **텍스트 노드**로 넣는다. 마크업으로 넣으면 파일이
    // 화면을 고친다.
    const pre=node.querySelector('.fe-dd-peek-old');
    if(old.length) pre.textContent=old.join('\n');
    else{ pre.textContent=ED_DD_PEEK_ADDED; pre.classList.add('none') }
    pre.style.maxHeight=(ED_DD_PEEK_MAX_LINES*view.defaultLineHeight)+'px';

    node.querySelector('.fe-dd-peek-close').addEventListener('click',()=>this.close());
    for(const b of node.querySelectorAll('.fe-dd-peek-act')){
      b.addEventListener('click',()=>this.act(b.dataset.act,b));
    }
    // 조각 위에 뜬다. 삭제 조각의 자리도 같다 — 지워진 줄이 있던 자리가 그 위다.
    const doc=view.state.doc;
    const at=ch.line>doc.lines?{pos:doc.length,side:1}:{pos:doc.line(Math.max(1,ch.line)).from,side:-1};
    view.dispatch({effects:edDdPeek().set.of({node,pos:at.pos,side:at.side})});
    this.node=node;
    this.change=ch;
  }

  async act(act,btn){
    const dd=this.ed._dd,ch=this.change;
    if(!dd||!ch) return;
    if(act==='revert'){
      dd.revert(ch,this.ed);
      this.close();
      return;
    }
    // FR-EDD-44: 저장이 앞설 수 있으므로 시간이 걸린다 — 침묵은 고장과 구별되지
    // 않는다.
    this.note(ED_DD_STAGING);
    for(const b of (this.node?this.node.querySelectorAll('.fe-dd-peek-act'):[])) b.disabled=true;
    const res=await dd.stage(ch,this.ed);
    if(!res.ok){
      this.note(res.msg);
      for(const b of (this.node?this.node.querySelectorAll('.fe-dd-peek-act'):[])) b.disabled=false;
      return;
    }
    // 넓게 올렸으면 그 사실을 말한다 (FR-EDD-46 ③). 조각은 곧 사라지므로
    // 팝업은 그 다음 계산이 닫는다 (FR-EDD-36).
    if(res.wide) this.note(ED_DD_STAGE_WIDE);
    else this.close();
  }

  note(text){
    const el=this.node&&this.node.querySelector('.fe-dd-peek-note');
    if(el) el.textContent=text||'';
  }

  // FR-EDD-36: 조각이 사라지면 팝업도 닫힌다. 없는 조각에 대한 동작 버튼을
  // 남기지 않는다.
  sync(){
    const ch=this.change;
    if(!ch) return;
    const live=(this.ed._dd&&this.ed._dd.changes||[]).some(c=>
      c.type===ch.type&&c.line===ch.line&&c.count===ch.count&&c.baseStart===ch.baseStart);
    if(!live) this.close();
  }

  close(){
    if(this.node&&this.ed._view) this.ed._view.dispatch({effects:edDdPeek().set.of(null)});
    this.node=null;
    this.change=null;
  }

  drop(){
    this.close();
    if(this.ed._dd) this.ed._dd.views.delete(this.ed);
    this.ed._dd=null;
  }
}
