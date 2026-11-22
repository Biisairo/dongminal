/**
 * Diff 의 그림 보기 (M9_SRS FR-M9-20 · D-M9-12·13) — `GitDiffView` 의 부품 (REFACTOR3_FE_REST5_SRS FR-FR5-21).
 *
 * 두 판을 `<img>` 로 나란히·겹쳐 그리고, SVG 처럼 텍스트 diff 도 갖는 파일에는 두 보기 사이를 오가는 길을 둔다.
 * 보기 방식(`_imgMode`)과 그릴 자리·안내·편집기는 뷰의 것이다 — 여기는 `this.v` 로 읽고 부른다.
 */
class GitDiffImage {
  constructor(view){
    this.v=view;
  }

  /** 한쪽의 바이트를 가리키는 주소. `<img src>` 가 이것을 그대로 건다. */
  blobURL(target,side){
    let u=GIT_BLOB_API+'?repo='+encodeURIComponent(target.repo)+
      '&axis='+encodeURIComponent(target.axis)+'&path='+encodeURIComponent(target.path)+
      '&side='+encodeURIComponent(side);
    if(target.origPath) u+='&origPath='+encodeURIComponent(target.origPath);
    if(target.oid) u+='&oid='+encodeURIComponent(target.oid);
    if(target.parentOid) u+='&parentOid='+encodeURIComponent(target.parentOid);
    return u;
  }

  /**
   * 두 판을 그린다.
   *
   * **`<img>` 로만 그린다** — SVG 도 그렇다 (D-M9-13 / FR-DRV-14·23). 인라인
   * `<svg>` 로 넣으면 그 안의 스크립트가 돈다.
   *
   * 크기(px)와 용량을 각 판에 적는 것이 이 화면의 절반이다 — 같은 그림처럼 보이는
   * 두 판을 가르는 것이 대개 그 둘이다.
   */
  draw(target,mime,a,b){
    this.v._dropEditor();
    this.v._setNote('');
    const mode=this.v._imgMode||GIT_IMG_MODE_SIDE;
    this.v._imgMode=mode;
    this.v._host.textContent='';
    const wrap=document.createElement('div');
    wrap.className='git-img-diff mode-'+mode;
    wrap.appendChild(this.bar(target,mime,a,b));
    const body=document.createElement('div');
    body.className='git-img-body ui-scroll';
    for(const side of [GIT_IMG_SIDE_ORIGINAL,GIT_IMG_SIDE_MODIFIED]){
      body.appendChild(this.pane(target,side,side===GIT_IMG_SIDE_ORIGINAL?a:b));
    }
    wrap.appendChild(body);
    this.v._host.appendChild(wrap);
  }

  bar(target,mime,a,b){
    const bar=document.createElement('div');
    bar.className='git-img-bar';
    for(const m of [GIT_IMG_MODE_SIDE,GIT_IMG_MODE_OVER]){
      bar.appendChild(UIKit.button({label:GIT_IMG_MODE_LABEL[m],size:'sm',
        cls:'git-img-mode'+(this.v._imgMode===m?' active':''),dataset:{mode:m},onClick:()=>{
          if(this.v._imgMode===m) return;
          this.v._imgMode=m;
          this.draw(target,mime,a,b);
        }}));
    }
    // SVG 는 텍스트 diff 도 갖는다 — 돌아갈 길을 같은 줄에 둔다.
    if(GIT_DIFF_DRAWABLE.has(a.kind)&&GIT_DIFF_DRAWABLE.has(b.kind)){
      const back=UIKit.button({label:GIT_IMG_AS_TEXT,size:'sm',cls:'git-img-as-text'});
      // **다시 받지 않는다.** `show()` 를 부르면 stale 가드의 토큰이 없어
      // 그 호출이 자기 세대에 걸러지고(실측), 무엇보다 우리가 이미 두 벌의
      // 본문을 손에 들고 있다 — 같은 것을 다시 묻는 것은 왕복 하나를 버리는 일이다.
      back.addEventListener('click',()=>{
        this.v._imgMode=null;
        this.v._draw(target.path,a.content||'',b.content||'','',target);
        this.addToggle(target,mime,a,b);
      });
      bar.appendChild(back);
    }
    return bar;
  }

  pane(target,side,meta){
    const pane=document.createElement('div');
    pane.className='git-img-pane git-img-'+side;
    pane.dataset.side=side;
    const head=document.createElement('div');
    head.className='git-img-head'; head.textContent=GIT_IMG_SIDE_LABEL[side];
    pane.appendChild(head);
    if(meta&&meta.kind==='absent'){
      // 추가·삭제다 — 없는 쪽을 빈 그림으로 그리면 "검은 그림" 으로 읽힌다.
      const none=document.createElement('div');
      none.className='git-img-none'; none.textContent=GIT_IMG_ABSENT;
      pane.appendChild(none);
      return pane;
    }
    const img=document.createElement('img');
    img.className='git-img'; img.alt='';
    const foot=document.createElement('div');
    foot.className='git-img-meta';
    img.addEventListener('load',()=>{
      // 크기는 **브라우저가 읽은 값**이다 — 서버가 다시 세지 않는다.
      const dim=img.naturalWidth+'\u00d7'+img.naturalHeight;
      foot.textContent=meta&&meta.size?dim+GIT_META_SEP+gitFmtBytes(meta.size):dim;
    });
    img.addEventListener('error',()=>{ foot.textContent=GIT_IMG_FAIL });
    img.src=this.blobURL(target,side);
    pane.appendChild(img); pane.appendChild(foot);
    return pane;
  }

  /** 텍스트 diff 위에 "그림으로" 를 얹는다 (SVG 의 갈래). */
  addToggle(target,mime,a,b){
    this.v._setNote('',null,[{label:GIT_IMG_AS_IMAGE,title:GIT_IMG_AS_IMAGE,
      run:()=>{ this.v._imgMode=GIT_IMG_MODE_SIDE; this.draw(target,mime,a,b) }}]);
  }
}
