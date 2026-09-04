/**
 * 탐색기의 **관측** — SLOT_VIEW_STATE_SRS 묶음 X (FR-SVS-20~24).
 *
 * 디렉터리 목록 캐시·git 색·무시된 이름은 **누가 보든 같은 사실**이므로 루트마다
 * 하나다. 칸이 넷이어도 `/api/fs/list`·`/api/git/status` 는 한 벌만 나간다
 * (FR-SVS-20). 펼침·선택·스크롤은 이것에 들어오지 않는다 — 그것은 보는 자리의
 * 것이고 칸마다 다르다 (FR-SVS-21).
 *
 * 규약의 원본은 터미널이다: PTY 는 서버에 하나이고 xterm 은 칸마다 하나다. 여기서
 * store 가 PTY 의 자리, `FileTree` 가 xterm 의 자리다.
 *
 * 뷰를 **모른 채** 갱신을 알린다 (D-4) — `paintAll` 은 등록된 뷰에게 "다시 칠하라"
 * 만 말하고, 무엇을 그릴지는 각 뷰가 자기 시선으로 정한다.
 */
class FileTreeStore {
  constructor(app,root){
    this.app=app;
    this.root=root;
    this.views=new Set();

    // path → {entries,truncated,err}. 지연 로드의 캐시이자 그리기의 근거다 (FR-EDT-59).
    this.kids=new Map();
    this.busy=new Set();
    // M4 의 색. rel path → 상태문자. 폴더는 접어 올린 값이 따로 산다 (FR-EDT-73).
    this.st=new Map();
    this.partial=new Set();
    this.dirSt=new Map();
    // GIT_DIR_ENTRY_SRS FR-DIR-10: **디렉터리 항목** 자신의 상태 — 서브모듈과
    // 중첩 저장소다. 접어 올린 값(dirSt)과 자리를 나누는 이유는 둘의 근거가
    // 다르기 때문이다: 이쪽은 git 이 그 폴더를 두고 한 보고이고, 저쪽은 하위의
    // 요약이다. 섞으면 어느 쪽이 이기는지 말할 수 없다 (FR-DIR-11).
    this.dirOwn=new Map();
    // FR-DIR-41: 저장소 루트에서 이 트리 루트까지의 접두. 루트가 저장소 루트면
    // 빈 문자열이다. status 의 경로를 트리 기준으로 옮기는 데 쓴다.
    this.repoPrefix='';
    // FR-EDT-69: 루트에 저장소가 없으면 색이 없다.
    //
    // **`gitOff` 는 이제 503 에만 쓴다** (FR-DIR-31 / D-DIR-7). 404 처럼
    // `git init` 이 뒤집을 수 있는 사유는 굳히지 않고 `gitRetryAt` 으로 늦춘다 —
    // 굳혀 두면 init 직후에도 색이 없어 사용자가 init 을 실패로 읽는다.
    this.gitOff=false;
    this.gitRetryAt=0;
    this.gitBusy=false;
    // FR-ETR-5·6: 무시된 이름. 겹별 Set.
    this.ign=new Map();
    this.ignOff=false;

    // NOTES_LIVE_EXPLORER_SRS FR-FSL-6: 겹별 마지막 스탬프. **관측의 것**이므로
    // 루트마다 하나이고, 같은 루트를 보는 칸이 넷이어도 요청은 한 벌이다
    // (FR-SVS-20). 값은 해석하지 않는다 — 같은지 다른지만 본다 (FR-FSL-2).
    this.stamps=new Map();
    this.stampBusy=false;
    // FR-FSL-12: 종단이 없거나 4xx 면 이 루트에서는 다시 묻지 않는다
    // (`gitOff`·`ignOff` 와 같은 관례). 굳히지 않으면 옛 서버에 붙은 새
    // 브라우저가 주기마다 영영 404 를 받는다.
    this.stampOff=false;
  }

  attach(v){ this.views.add(v) }

  // FR-SVS-23: 마지막 뷰가 떠나면 관측도 거둔다 — 남겨 두면 아무도 보지 않는
  // 루트의 폴링이 계속된다. 레지스트리에서 지우는 것이 그 정지다 (폴링의 대상은
  // `_edActiveStore` 가 고른다).
  detach(v){
    this.views.delete(v);
    if(!this.views.size&&this.app._edStores) this.app._edStores.delete(this.root);
  }

  // FR-SVS-22: 관측이 갱신되면 그 루트를 보는 **모든** 칸이 다시 칠해진다.
  paintAll(){ for(const v of this.views) v.paint() }
}

