/**
 * FileTreeSelect — 탐색기의 선택·클릭·펼침 (EXPLORER_MULTI_SELECT_SRS · FR-EDT-60·61 · FR-RTU-42).
 *
 * `FileTree` 의 부품이다 (REFACTOR3_FE_REST5_SRS FR-FR5-31 — 옛 `Object.assign(FileTree.prototype, …)`). 상태(펼침·선택·
 * 조작·관측 통로)는 종전대로 탐색기 인스턴스에 있고, 이 부품은 그것을 `this.tree` 로 읽고 쓴다. 제 이름은 `this.X`, 탐색기와 다른 부품의 이름은 `this.tree.X`·`this.tree.<부품>.X` 로
 * 부른다 — 시험·e2e 가 부품 인스턴스에 갈아 끼운 것을 부품끼리도 본다. 이 부품의 이름은 `FileTree` 원형에 없다 (REFACTOR3_FE_DELEG_SRS).
 *
 * 앵커 하나와 집합의 선택(`_sel*`), 클릭·더블클릭·키 이동, 펼침(`toggle`)과 경로 드러내기(`revealPath`). 옛 자리는 `file-tree-paint.js` 다.
 */
class FileTreeSelect {
  constructor(tree){
    this.tree=tree;
  }

  /**
   * 이 경로가 트리에 **보이게** 한다 — 조상 폴더를 루트까지 펼치고, 아직 읽지
   * 않은 겹은 읽고, 그 행으로 스크롤한다.
   *
   * 검색으로 연 파일이 트리 어디에 있는지는 그 자체가 답의 일부다. 파일만 열고
   * 탐색기를 그대로 두면 사용자가 경로를 눈으로 따라가며 폴더를 하나씩 펼쳐야
   * 한다 — 검색이 방금 알려 준 것을 손으로 다시 찾는 셈이다.
   *
   * 겹은 **순차로** 읽는다. 병렬로 던지면 각 응답의 paint 가 서로를 덮어 중간
   * 상태가 깜빡인다. 펼친 것은 되접지 않는다 (`_springSchedule` 과 같은 근거).
   */
  async revealPath(p){
    if(!p||!this.tree.root) return;
    const root=String(this.tree.root).replace(/[\\/]+$/,'');
    if(!pathUnder(root,p)) return;   // 이 트리의 것이 아니다
    // 부모부터 위로 훑어 루트 바로 아래까지 모은다. 상한을 두는 이유는 `_parent`
    // 가 최상위에서 `'/'` 를 내기 때문이다 — 루트가 `'/'` 면 멈추지 않는다.
    const chain=[];
    let d=this.tree.painter._parent(p);
    for(let i=0;i<EDITOR_TREE_REVEAL_MAX&&d&&d!==root&&pathUnder(root,d);i++){
      chain.unshift(d);
      d=this.tree.painter._parent(d);
    }
    for(const dir of chain){
      this.tree._open.add(dir);
      if(!this.tree._kids.has(dir)) await this.tree.loader.load(dir);
    }
    this._selOnly(p);
    this.tree._paintAll();
    const row=this.tree.list.querySelector('.ed-row.sel');
    if(row&&row.scrollIntoView) row.scrollIntoView({block:'nearest'});
  }

  toggle(p){
    if(this.tree._open.has(p)){
      this.tree._open.delete(p);
      /**
       * FR-FSP-15: 접으면 **이어 받은 쪽을 버린다.** 접는 것은 "이제 안 본다"
       * 는 말이고, 그 상태를 무한히 들고 있을 이유가 없다.
       *
       * **첫 쪽은 남긴다** — 다시 펴는 것이 빈 화면이어서는 안 되고, 여기서
       * 캐시를 통째로 지우면 "이미 읽어 둔 폴더는 다시 묻지 않는다"(FR-EDT-67)
       * 가 모든 폴더에 대해 깨진다.
       */
      const st=this.tree._kids.get(p);
      if(st&&st.page0&&st.entries.length>st.page0){
        st.entries=st.entries.slice(0,st.page0);
        st.truncated=true; st.moreBusy=false; st.moreErr=false;
      }
      this.tree._paintAll();return;
    }
    this.tree._open.add(p);
    this.tree._paintAll();
    // 이미 읽어 둔 폴더는 다시 묻지 않는다 — 갱신의 계기는 FR-EDT-67 의 셋뿐이다.
    if(!this.tree._kids.has(p)) this.tree.loader.load(p);
  }

  /**
   * FR-EMS-1 / R-EMS-1: **집합을 바꾸는 자리는 이 셋뿐이다.**
   *
   * 흩어 두면 앵커와 집합이 어긋나고, 그때 화면이 보이는 것과 조작이 지우는 것이
   * 갈린다 — 그 어긋남은 지운 뒤에야 드러난다.
   */
  _selOnly(p){
    this.tree._sel=p||'';
    this.tree._selSet=new Set(p&&p!==this.tree.root?[p]:[]);
  }

  // FR-EMS-3: 토글. 들어온 행이 새 앵커이며, 마지막 하나를 빼면 선택이 빈다.
  _selToggle(p){
    if(!p||p===this.tree.root) return;
    if(this.tree._selSet.has(p)){
      this.tree._selSet.delete(p);
      if(this.tree._sel===p) this.tree._sel=this.tree._selSet.size?[...this.tree._selSet][this.tree._selSet.size-1]:'';
      return;
    }
    this.tree._selSet.add(p);
    this.tree._sel=p;
  }

  /**
   * FR-EMS-4: 앵커부터 그 행까지 **보이는 순서**의 범위.
   *
   * 앵커는 움직이지 않는다 — 움직이면 범위를 다시 잡을 수 없고, 사용자는 매번
   * 처음부터 고르게 된다.
   */
  _selRange(p){
    if(!p||p===this.tree.root) return;
    const rows=this.tree.painter._items().filter(it=>it.t==='row').map(it=>it.path);
    const a=rows.indexOf(this.tree._sel),b=rows.indexOf(p);
    if(a<0||b<0){this._selToggle(p);return}
    const [lo,hi]=a<=b?[a,b]:[b,a];
    this.tree._selSet=new Set(rows.slice(lo,hi+1).filter(x=>x!==this.tree.root));
    this.tree._selSet.add(this.tree._sel);
  }

  // UX_BATCH12 FR-EXK-5: 보이는 행 전부(루트 제외). 앵커가 그 밖이면 첫 행이 앵커다.
  _selAll(){
    const rows=this.tree.painter._items().filter(it=>it.t==='row'&&it.path!==this.tree.root).map(it=>it.path);
    if(!rows.length) return false;
    this.tree._selSet=new Set(rows);
    if(!this.tree._selSet.has(this.tree._sel)) this.tree._sel=rows[0];
    return true;
  }

  // UX_BATCH12 FR-EXM-1: 사각형 선택. 시작 때의 선택(`base`)에 든 행을 더한다.
  _selMarquee(base,hits,anchor){
    this.tree._selSet=new Set([...base,...hits]);
    this.tree._sel=hits.length?hits[hits.length-1]:anchor;
  }

  // 이 행이 지금 선택에 들어 있는가. 그리기와 드래그가 함께 읽는다.
  _selHas(p){ return !!p&&this.tree._selSet.has(p) }

  // 조작이 받을 대상. **조상이 함께 선택된 자손은 뺀다** (FR-EMS-22) — 조상과
  // 함께 사라질 것을 다시 지우려 하면 그 실패가 사용자에게 거짓말을 한다.
  _selTargets(fallback){
    const all=this.tree._selSet.size?[...this.tree._selSet]:(fallback?[fallback]:[]);
    return all.filter(p=>!all.some(q=>q!==p&&p.startsWith(q+'/')||q!==p&&p.startsWith(q+'\\')));
  }

  // UX_BATCH12 FR-EXM-3: `_selTargets` 를 화면 순서로. 경로 복사가 이 순서를 쓴다.
  _selOrdered(fallback){
    const at=new Map(this.tree.painter._items().filter(it=>it.t==='row').map((it,i)=>[it.path,i]));
    const ix=p=>at.has(p)?at.get(p):Infinity;
    return this._selTargets(fallback).sort((a,b)=>ix(a)-ix(b));
  }

  /**
   * FR-EXR-1·2: 이 자리가 뜻하는 것이 루트일 때. 판정은 드롭과 같은 것을 쓴다
   * (`_dropDirAt` — FR-FTR-20). "헤더와 빈 여백이면 루트다" 를 두 벌로 적으면
   * 한쪽만 고쳐진다.
   */
  _selectRoot(){
    if(this.tree._edit) this.tree.edits.cancelEdit();
    this.tree.painter._clearErr();
    // FR-EMS-8: 루트를 고르는 것도 "하나" 다. 집합은 비운다 (FR-EMS-6).
    this._selOnly('');
    this.tree._sel=this.tree.root;
    this.tree._paintAll();
  }

  _onClick(e){
    // FR-EXM-1: 사각형 끌기 뒤에 따라오는 클릭은 빈 여백 클릭이 아니다.
    if(this.tree._mqEat){this.tree._mqEat=false;return}
    // §3A-3: 실패 표시의 닫기.
    if(e.target.closest('.ed-op-err-x')){this.tree.painter._clearErr();return}
    // 인라인 입력 자신을 누른 것은 행 선택이 아니다 — 캐럿을 옮기는 중이다.
    if(e.target.closest('.ed-edit')) return;
    const row=e.target.closest('.ed-row');
    // FR-EXR-1: 행이 아닌 자리는 루트다. 종전에는 여기서 그냥 나갔고, 그래서
    // 같은 자리에 **놓을 수는 있는데 고를 수는 없었다**.
    if(!row||!this.tree.list.contains(row)){
      if(this.tree.xfer._dropDirAt(e.target)===this.tree.root) this._selectRoot();
      return;
    }
    // 다른 자리를 누르면 쓰다 만 이름은 버린다. 커밋하지 않는 이유는 클릭 한 번이
    // 파일을 만드는 것보다 잃는 쪽이 안전하기 때문이다 (FR-GIT-97 과 같은 근거).
    if(this.tree._edit) this.tree.edits.cancelEdit();
    const p=row.dataset.path,kind=row.dataset.kind;
    /**
     * FR-EMS-3·4·5: **고르는 클릭은 여는 클릭이 아니다.**
     *
     * `Mod` 는 Ctrl 과 Meta 중 정확히 하나다 (`shortcuts.js` 의 규약) — 둘 다 누른
     * 조합까지 받으면 그것을 따로 쓰는 사람의 손짓을 가로챈다.
     */
    if(e.shiftKey&&!e.altKey){
      this.tree.painter._clearErr();
      this._selRange(p);
      this.tree._paintAll();
      return;
    }
    if(e.ctrlKey!==e.metaKey&&!e.altKey&&!e.shiftKey){
      this.tree.painter._clearErr();
      this._selToggle(p);
      this.tree._paintAll();
      return;
    }
    // FR-WBR-2: 다른 자리를 고른 것은 그 사유를 다 읽었다는 뜻이다. 이것이
    // 없으면 상태를 바꾸지 않는 실패(자기 하위로의 이동 거부 — FR-EDT-85)의
    // 메시지가 **영영 남는다** — 지우는 계기가 성공한 조작뿐이었다.
    this.tree.painter._clearErr();
    // FR-EMS-2: 평범한 클릭은 집합을 그 하나로 되돌린다 — 기존 동작 그대로다.
    this._selOnly(p);
    // FR-EDT-60: 링크는 펼치지도 열지도 않는다 — 선택만 바뀐다. 링크된 디렉터리를
    // 파일로 취급하면 `apiFileRead` 가 not a file 400 을 낸다 (§2.6).
    if(kind==='dir') this.toggle(p);
    // REPO_TAB_UNIFY_SRS FR-RTU-40·43: 한 번 클릭은 **미리보기**다. 트리를 훑는
    // 일이 탭 20개가 되면 목록을 보는 것 자체가 정리를 부른다 (D-RTU-9).
    // 고정하려면 더블클릭한다 (FR-RTU-42).
    else if(kind==='file') this.tree.app.editor.file.edOpenFile(p,{preview:true});
    else this.tree._paintAll();
  }

  // FR-RTU-42(④): 행 더블클릭은 그 파일의 탭을 고정한다. 여는 일은 앞선 클릭이
  // 이미 했다 (`_onClick`).
  /**
   * FR-EXR-51: 선택을 **보이는 순서**로 옮긴다. 순서의 근거는 `_items()` 의 행
   * 항목이며(FR-EXR-52) 펼침 상태를 그대로 따른다 — 별도의 순서 계산을 만들면
   * 화면과 어긋난다.
   *
   * 선택이 없거나 루트면 끝에서 들어온다.
   */
  _moveSel(d){
    const rows=this.tree.painter._items().filter(it=>it.t==='row');
    if(!rows.length) return;
    const i=rows.findIndex(it=>it.path===this.tree._sel);
    const n=i<0?(d>0?0:rows.length-1)
      :Math.min(rows.length-1,Math.max(0,i+d));
    // FR-EMS-8: 키보드 이동은 집합을 하나로 되돌린다.
    this._selOnly(rows[n].path);
    this.tree._paintAll();
    // 선택이 화면 밖으로 나가면 옮겨 보인다 — `revealPath` 와 같은 손짓이다.
    const row=this.tree.list.querySelector('.ed-row.sel');
    if(row&&row.scrollIntoView) row.scrollIntoView({block:'nearest'});
  }

  _onDbl(e){
    const row=e.target.closest('.ed-row');
    // FR-EXR-10·11: 빈 여백의 더블클릭은 **루트에 새 파일**이다. 폴더가 아니다 —
    // 폴더는 툴바·메뉴로만 만든다.
    if(!row||!this.tree.list.contains(row)){
      if(this.tree.xfer._dropDirAt(e.target)===this.tree.root) this.tree.edits.startCreate(false,this.tree.root);
      return;
    }
    if(row.dataset.kind!=='file') return;
    this.tree.app.editor.pane.edPinTabFor(row.dataset.path);
  }
}
