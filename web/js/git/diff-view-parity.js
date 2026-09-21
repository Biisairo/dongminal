/**
 * Dongminal — Diff 탭이 **편집기와 같은 것을 하는** 자리 (UX_BATCH10_SRS 묶음 D)
 *
 * `GitDiffView` 에서 갈라 나온 주제 하나다 — 이 저장소가 `FileEditor` 에 이미
 * 쓰는 방식과 같다 (`file-editor-find.js`·`file-editor-diff.js`): 뼈대 클래스는
 * 자기 파일에 남고, 주제는 `Object.assign(X.prototype, …)` 로 얹는다.
 *
 * 여기 있는 것은 셋이다 — **표시 설정**(FR-UXB-40·41·42) · **찾기 패널**
 * (FR-UXB-44·45) · **언어 기능의 경로 되돌림**(FR-UXB-47·48). 셋이 한 파일인
 * 이유는 셋 다 *"diff 를 편집기와 같게 만든다"* 라는 한 요구에서 나왔고, 셋 다
 * **편집기 쪽의 한 벌을 빌려 쓴다**는 점에서 같기 때문이다.
 *
 * `diff-view.js` 뒤, `file-editor-find.js` 뒤에 실려야 한다 — 얹을 prototype 과
 * 빌려 쓸 덩이(`ED_FIND_MIXIN`)가 그때 있다.
 */
Object.assign(GitDiffView.prototype, {
  /**
   * UX_BATCH10_SRS FR-UXB-40·41·42: **설정이 바뀌면 열려 있는 diff 도 따라간다.**
   *
   * 편집기 탭의 `applyWordWrap`·`applyFontSize`·`applyMinimap` 셋에 대응하는
   * 자리이며, 셋이 아니라 하나인 것은 딛는 것이 덩이 하나이기 때문이다
   * (D-UXB-9). `updateOptions` 이므로 모델도 스크롤도 잃지 않는다.
   */
  applyTextOptions(){
    if(!this._editor) return;
    this._editor.updateOptions(edTextOptions());
    this._applyMinimapSides();
  },

  /**
   * FR-UXB-42 / D-UXB-8: 미니맵은 **수정 쪽 하나**다.
   *
   * Monaco 의 diff 는 좌우가 독립 편집기라 내용이 합쳐진 미니맵은 없다. 양쪽에
   * 두면 좁은 칸에서 폭을 두 번 내주고, 그것이 M9_SRS D-M9-5 가 미니맵을 아예
   * 끈 이유였다. 우측 하나면 diff 개요 눈금(FR-DOR-1)과 나란히 서서 "문서의
   * 어디인가" 와 "어디가 바뀌었나" 를 함께 읽는다.
   */
  _applyMinimapSides(){
    if(!this._editor) return;
    this._editor.getOriginalEditor().updateOptions({minimap:edMinimapOpts(false)});
    this._editor.getModifiedEditor().updateOptions({minimap:edMinimapOpts(diffMinimap)});
  },

  /**
   * FR-UXB-44·45·46: **편집기 탭과 같은 찾기 패널.**
   *
   * 패널의 구현은 `file-editor-find.js` 한 벌이다 (`ED_FIND_MIXIN`). 그것이
   * 기대하는 것은 둘뿐이라 — `el`(패널이 살 자리)과 `_editor`(찾을 모델을 든
   * 편집기) — 그 둘을 든 그릇 하나면 그대로 선다. 패널을 다시 쓰지 않고 새로
   * 만들면 정규식·대소문자·단어 단위와 하이라이트 규약이 두 벌이 된다.
   *
   * **편집기는 포커스가 있는 쪽이다.** diff 는 두 쪽이고, 사용자가 보고 있는
   * 쪽에서 찾는 것이 "편집기와 같다" 의 뜻이다 (FR-UXB-49 — 원본에서도 찾을 수
   * 있다. 고칠 수 없을 뿐이다).
   */
  _findHostFor(){
    if(!this._editor) return null;
    if(!this._findPanel){
      this._findPanel=Object.assign({},ED_FIND_MIXIN,{el:this._host,_editor:null});
    }
    const orig=this._editor.getOriginalEditor(),mod=this._editor.getModifiedEditor();
    const side=orig.hasTextFocus()?orig:mod;
    // 쪽이 바뀌면 앞 쪽의 하이라이트를 먼저 걷는다 — 두 쪽에 동시에 남으면
    // "지금 어디를 찾고 있는가" 가 화면에서 갈린다.
    if(this._findPanel._editor&&this._findPanel._editor!==side) this._findPanel.findClose();
    this._findPanel._editor=side;
    return this._findPanel;
  },

  /**
   * FR-UXB-44: **여는 문 하나.** 키 판정은 app 이 한 벌로 갖는다 (FR-EKB-1·5) —
   * `_edFindInFile` 이 편집기 탭과 이 자리를 가른다. 여기서 조합을 다시 적으면
   * 설정에서 바꾼 키가 diff 에서만 듣지 않는다.
   */
  findOpen(){
    const h=this._findHostFor();
    if(h) h.findOpen();
  },

  /**
   * FR-UXB-44: Monaco 자신의 find 위젯을 **양쪽에서** 닫는다.
   *
   * 편집기 탭이 인스턴스별로 거는 것과 같은 목록이다 (FR-EFP-4). 전역 키 처리가
   * 먼저 삼키는 경로가 대부분이지만, 그것은 포커스가 어디에 있느냐에 달려 있고
   * 위젯을 여는 길은 `Mod+F` 하나가 아니다 (`Mod+E`·`F3`·`Mod+G`…).
   */
  _findKillWidgetKeys(){
    if(this._findKeysOn) return;
    this._findKeysOn=true;
    for(const ed of [this._editor.getOriginalEditor(),this._editor.getModifiedEditor()]){
      ED_FIND_MIXIN._findKillMonacoKeys.call({_editor:ed});
    }
  },

  /**
   * UX_BATCH10_SRS FR-UXB-47·48 / D-UXB-10·11: **이 모델이 가리키는 파일.**
   *
   * 언어 서버는 디스크를 딛는다. 그러므로 답하는 것은 **오른쪽이 디스크의
   * 파일인 축**에서 수정 쪽 모델 하나뿐이다 (`GIT_AXIS_EDITABLE`, FR-RTU-50).
   * 커밋 간 비교의 본문은 과거의 내용이고, 그 좌표로 받은 답은 없는 답보다
   * 나쁘다 — 그때는 빈 문자열이고 호버·정의이동이 조용히 아무 일도 하지 않는다.
   *
   * 모델에 파일 URI 를 붙이지 않는 이유는 D-UXB-10 이다: 같은 URI 의 모델은
   * Monaco 에 하나뿐이라 편집기 탭이 이미 연 파일과 충돌한다.
   */
  lspPathOf(model){
    if(!model||!this._editable||!this._editTarget) return '';
    return model===this._mod?this._editTarget:'';
  },
});
