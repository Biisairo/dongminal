// @ts-check
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
    // `UX-25`: 마지막 status 응답이 **저장소의 것**이었나. 색이 비어 있어도(깨끗한
    // 저장소) 참이다 — 삭제 뒤 복구 힌트가 "추적 중인 파일이었다" 를 판정하는 근거.
    this.gitOn=false;
    // FR-ETR-5·6: 무시된 이름. 겹별 Set.
    this.ign=new Map();
    this.ignOff=false;

    // NOTES_LIVE_EXPLORER_SRS FR-FSL-6 · REPO_FIX 04 §3A-2: 겹별 관측 상태
    // (unseen·ok(stamp)·failed·gone — `file-tree-obs.js`). **관측의 것**이므로 루트마다
    // 하나이고, 같은 루트를 보는 칸이 넷이어도 요청은 한 벌이다 (FR-SVS-20).
    this.obs=new Map();
    this.stampBusy=false;
    // REPO_FIX 04 §3A-1: 폴더별 로드 세대(낙관 반영이 올린다)와 진행 중 로드(대기 1건).
    this.gen=new Map();
    this.loadQ=new Map();
    // REPO_FIX 04 §3A-6: 직전에 적용한 git 관측의 키(저장소·접두·mark). 같으면 다시
    // 계산하지 않는다.
    this.gitKey='';
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
    if(!this.views.size&&this.app.edStores) this.app.edStores.delete(this.root);
  }

  // FR-SVS-22: 관측이 갱신되면 그 루트를 보는 **모든** 칸이 다시 칠해진다.
  paintAll(){ for(const v of this.views) v.paint() }

  // §3A-1: 낙관 반영으로 그 폴더의 목록을 직접 고쳤다 — 그 전에 출발한 응답은 버린다.
  bump(dir){ this.gen.set(dir,(this.gen.get(dir)||0)+1) }

  /**
   * §3A-2 (T-3.1): 스탬프 질의 대상은 **그 루트의 모든 뷰**가 펼친 폴더의 합집합이다
   * (루트 먼저, 중복 제거, 서버 상한으로 자름).
   *
   *   이전 동작: 뷰마다 자기 펼침만 물었고 공유 busy 에 둘째 뷰가 걸려 즉시 돌아갔다 —
   *             같은 루트를 두 칸에 띄우면 뒤 칸의 펼친 폴더가 관측되지 않았다 (#32)
   *   새  동작: store 가 한 번에 합집합을 묻는다
   */
  stampDirs(){
    const out=[this.root], seen=new Set(out);
    for(const v of this.views) for(const p of v._open){
      if(seen.has(p)||!(this.kids.has(p)||this.obs.has(p))) continue;
      seen.add(p); out.push(p);
    }
    return out.length>FS_STAMP_MAX?out.slice(0,FS_STAMP_MAX):out;
  }

  async pollStamp(){
    if(this.stampOff||this.stampBusy||!this.root) return;
    const dirs=this.stampDirs();
    this.stampBusy=true;
    const r=await apiPost(FS_STAMP_API,{root:this.root,dirs});
    this.stampBusy=false;
    if(r.status===0) return;   // 전송 실패는 판정이 아니다
    // FR-FSL-12: 4xx 는 "이 루트로는 물을 수 없다" 는 서버의 답이다.
    if(!r.ok){ if(r.status>=400&&r.status<500) this.stampOff=true; return }
    const st=r.data&&r.data.stamps;
    if(!st||typeof st!=='object') return;
    const {reload,gone}=ftObsPoll(this.obs,dirs,st,Date.now());
    // T-2.3: 사라진 겹의 옛 목록은 버린다 — 펼침은 남는다. 다시 생기면 새로 읽는다.
    for(const d of gone) this.kids.delete(d);
    if(gone.length) this.paintAll();
    // 순차로 읽는다 — 병렬이면 응답마다의 paint 가 중간 상태를 깜빡인다.
    for(const d of reload){
      const v=[...this.views].find(x=>d===this.root||x._open.has(d));
      if(v) await v.reload(d);
    }
  }
}

