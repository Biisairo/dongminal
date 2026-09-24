/**
 * Dongminal — Git 컨텍스트 메뉴 프레임워크 (GIT_SRS §3C.2 / FR-GIT-146)
 *
 * 표면 지도 S4 의 46개 항목이 이 위에 선형으로 얹힌다. 대상 종류별로 항목 집합을
 * **선언**하면 렌더·키보드 조작·닫기가 공통 경로를 탄다 — 항목이 늘어도 새 메뉴
 * 코드가 늘지 않는다.
 *
 * 5단계가 만든 파일 우클릭 메뉴(`.git-ctxmenu`)를 이것이 흡수했다. 같은 것을 두 번
 * 만들지 않는다.
 *
 * 항목의 모양:
 *   {id, label, run(target), disabled(target)→사유|'', warn, destructive,
 *    action, title, targets(target)→[문자열], hint(target)→{note,command}}
 *   {sep:true}
 *
 * 확인은 **항목이 따로 쓰지 않는다** — `warn:true` 는 1단계, `destructive:true` 는
 * 9단계 `GitConfirm` 의 확인을 프레임워크가 자동으로 거친다.
 */

// 항목의 run·disabled 는 패널을 통해 동작한다 — 메뉴는 대상과 항목만 알고, 무엇을
// 실행하는지는 패널이 안다.
function gitMenuPanel(){return (window.app&&app.gitPanel)||null}

// FR-GIT-250.2: 파괴적 태그 항목의 확인 문구에 실을 **지우기 전 oid**. 값을 모르면
// 지어내지 않는다 — 서버가 실행 전에 진짜 oid 로 hint 를 남긴다 (FR-GIT-92).
function gitTagOid(t){
  return GitTag.oidOf(gitMenuPanel(),t)||GIT_TAG_OID_UNKNOWN;
}

/**
 * FR-GIT-252: 진행 중 작업이 있으면 **새 작업을 시작할 수 없다.**
 *
 * merge·rebase·cherry-pick·revert 가 멈춘 상태에서 또 하나를 시작하면 git 이
 * 거부하고, 그 거부는 exit 128 의 문구로만 온다. 항목을 막되 **사유를 보인다** —
 * 왜 못 누르는지 보이지 않으면 사용자는 고장으로 읽는다 (FR-GIT-180).
 *
 * 판정 근거는 관측 하나다 (`status.operation`, FR-GIT-251) — 항목마다 다시 세면
 * 한 곳이 빠져도 조용히 지나간다.
 */
function gitOpBusy(){
  const p=gitMenuPanel(); if(!p||typeof p.statusOf!=='function') return '';
  const op=(p.statusOf()||{}).operation;
  const kind=(op&&op.kind)||'';
  if(!kind) return '';
  return GIT_MENU_OP_BUSY.replace('%s',GIT_OP_LABEL[kind]||kind);
}

/**
 * FR-GIT-222: 행 더블클릭이 고르는 후보다. 순서가 우선순위이고, 비활성이 아닌
 * 첫 항목이 그 행의 기본 동작이 된다.
 *
 * **태그는 없다.** 태그 체크아웃은 detached 가 되는 동작이라 경고가 필요하고
 * (FR-GIT-144), 경고가 필요한 것을 가벼운 제스처에 싣지 않는다.
 */
const GIT_MENU_PRIMARY={
  branch:['checkout','checkout-local'],
};

const GIT_MENUS={
  // 커밋 (FR-GIT-140~144). 저장소를 바꾸는 항목은 checkout 하나다.
  commit:[
    // FR-GIT-141: 18단계의 생성 다이얼로그를 시작점만 이 커밋으로 고정해 연다 —
    // 이름 검증(FR-GIT-159)까지 그것이 이미 안다.
    {id:'branch-from',label:t('git.menu.branch_from'),
     run:t=>gitMenuPanel().createBranchFrom(t.oid)},
    // FR-GIT-260: 태그 생성의 **같은 다이얼로그**를 대상만 이 커밋으로 고정해 연다
    // — 이름 검증도 종류 선택도 그것이 이미 안다.
    {id:'tag-from',label:GIT_TAG_CREATE_AT,
     run:t=>gitMenuPanel().createTag(t.oid)},
    {id:'copy-hash',   label:t('git.menu.copy_hash'),run:t=>gitMenuPanel().copyText(t.oid)},
    {id:'copy-subject',label:t('git.menu.copy_subject'),run:t=>gitMenuPanel().copyText(t.subject)},
    {sep:true},
    // FR-GIT-144: detached 가 됨을 사전 경고하고, dirty 면 묶음 N 의 3선택을
    // 거친다 — 태그 메뉴와 같은 경로다. 판정을 두 벌로 만들지 않는다.
    {id:'checkout-detached',label:'Checkout (detached)',warn:true,
     action:GIT_CHECKOUT_DETACHED_ACT,title:GIT_CHECKOUT_DETACHED_TITLE,
     targets:t=>[t.abbrev+(t.subject?' '+t.subject:'')],
     hint:()=>({note:GIT_DETACHED_NOTE,command:''}),
     run:t=>gitMenuPanel().checkoutRef(t.oid,{detach:true})},
    {sep:true},
    // 묶음 D — 커밋 동작 (GIT_ACTIONS_SRS §3.4 / FR-GIT-263~266).
    //
    // 넷 다 `gitOpBusy()` 를 **먼저** 부른다 (FR-GIT-252) — 진행 중 작업이 있으면
    // 새 작업을 시작할 수 없고, 판정 근거는 관측 하나다. 그 뒤에 오는 것이 그
    // 항목만의 사유이며, 사유가 없으면 항목은 늘 열려 있다.
    {id:'cherry-pick',label:GIT_CO_CHERRY_LABEL,
     disabled:t=>gitOpBusy()||GitCommitOps.whyHead(t),
     run:t=>GitCommitOps.cherryPick(gitMenuPanel(),t)},
    {id:'revert',label:GIT_CO_REVERT_LABEL,
     disabled:()=>gitOpBusy(),
     run:t=>GitCommitOps.revert(gitMenuPanel(),t)},
    // reset 은 **파괴 여부가 옵션에서 파생하므로**(`--hard` 만) 여기서
    // destructive 를 선언하지 않는다 — 선언하면 세 모드 전부가 확인을 요구한다.
    {id:'reset',label:GIT_CO_RESET_LABEL,
     disabled:t=>gitOpBusy()||GitCommitOps.whyHead(t),
     run:t=>GitCommitOps.reset(gitMenuPanel(),t)},
    // drop 은 언제나 파괴적이다 (`commit_drop`). 파괴적 확인과 recovery hint 는
    // 프레임워크가 거친다 — 항목이 확인 코드를 따로 쓰지 않는다 (FR-GIT-89·92).
    {id:'drop',label:GIT_CO_DROP_LABEL,destructive:true,
     action:GIT_ACT_COMMIT_DROP,title:GIT_CO_DROP_TITLE,
     disabled:t=>gitOpBusy()||GitCommitOps.whyDrop(t),
     targets:t=>[GitCommitOps.label(t)],
     hint:()=>({note:GIT_CO_DROP_NOTE,
       command:GitCommitOps._restoreCmd(gitMenuPanel())}),
     run:t=>GitCommitOps.drop(gitMenuPanel(),t)},
    {sep:true},
    // FR-GIT-267: 커밋 둘을 고르는 길. 기준을 표시해 두면 Compare with 의 리비전
    // 칸이 그것으로 채워진다 — `A..B` 입력도 같은 칸으로 들어온다.
    {id:'compare-mark',label:GIT_CO_MARK_LABEL,
     run:t=>GitCommitOps.mark(gitMenuPanel(),t)},
    {id:'compare-with',label:GIT_CO_COMPARE_LABEL,
     run:t=>GitCommitOps.compare(gitMenuPanel(),t)},
  ],
  // 파일 (S1 목록 / History 상세 목록). 저장소를 바꾸는 항목이 하나도 없다
  // (FR-GIT-41) — 5단계의 GIT_CTX_ITEMS 를 그대로 옮긴 것이다.
  file:[
    {id:'openChanges',label:t('git.menu.file_open_changes'),run:t=>gitMenuPanel().openFileDiff(t)},
    // FR-GIT-236: 행 인라인 동작과 같은 자리를 지난다 — 두 벌로 두면 한쪽만 고쳐진다.
    {id:'openFile',   label:t('git.menu.file_open_file'),run:t=>gitMenuPanel()._run('openFile',[t])},
    // FR-GIT-274: 워킹 트리가 아니라 `HEAD:<path>` 의 내용이다. 여는 자리는
    // Open File 과 같다 — Git 창이 아닌 창이다 (FR-GIT-179·185).
    {id:'openFileHead',label:GIT_FILE_OPEN_HEAD,run:t=>gitMenuPanel().openFileAtHead(t)},
    {id:'copyPath',   label:t('git.menu.file_copy_path'),run:t=>gitMenuPanel().copyText(gitMenuPanel().absPath(t))},
    {sep:true},
    // FR-GIT-275: path 필터가 이미 있으므로(FR-GIT-129) 그것을 채워 탭을 여는 것이
    // 전부다 — 새 조회를 만들지 않는다.
    {id:'fileHistory',label:GIT_FILE_HISTORY,run:t=>gitMenuPanel().openFileHistory(t)},
    // FR-GIT-276: 고정 탭을 늘리지 않는다 — Diff 탭을 blame 모드로 연다 (D8).
    {id:'blame',      label:GIT_FILE_BLAME,  run:t=>gitMenuPanel().openBlame(t)},
    // FR-GIT-273: **git 실행이 아니라 파일 쓰기다.** 저장소 루트의 `.gitignore`
    // 하나만 대상이며, 경로가 그 안인지는 서버가 다시 본다.
    {id:'ignore',     label:GIT_FILE_IGNORE,run:t=>gitMenuPanel().ignorePath(t)},
  ],
  // 브랜치·태그 (FR-GIT-154·155·156·160). 로컬과 원격은 **뜻이 다른 두 항목**이다 —
  // 원격 ref 로 그냥 옮겨 가면 detached 가 되므로 같은 이름의 로컬을 만들며 추적을
  // 설정한다 (FR-GIT-156). 어느 쪽이 왜 막혔는지는 사유로 알린다.
  branch:[
    {id:'copy-name',label:t('git.menu.copy_branch_name'),run:t=>gitMenuPanel().copyText(t.short)},
    {id:'checkout', label:'Checkout',
     disabled:t=>t.kind===GIT_REF_KIND_REMOTE?GIT_MENU_REMOTE_REF:(t.isHead?GIT_MENU_CURRENT:''),
     run:t=>gitMenuPanel().checkoutRef(t.short,{})},
    {id:'checkout-local',label:GIT_BR_CHECKOUT_LOCAL,
     disabled:t=>t.kind===GIT_REF_KIND_REMOTE?'':GIT_MENU_LOCAL_ONLY,
     run:t=>gitMenuPanel().checkoutRemote(t.short)},
    {sep:true},
    // 묶음 B — 접수한 말의 본체 (GIT_ACTIONS_SRS §3.2 FR-GIT-253~259).
    //
    // merge·rebase 는 **진행 중 작업을 먼저 본다** (FR-GIT-252) — 판정은 gitOpBusy()
    // 한 자리이고, 항목마다 다시 세면 한 곳이 빠져도 조용히 지나간다.
    // FR-GIT-259: 커밋 메뉴의 `branch-from` 과 **같은 함수**를 시작점만 바꿔 부른다.
    {id:'branch-from',label:GIT_BR_CREATE_FROM,
     run:t=>gitMenuPanel().createBranchFrom(t.short)},
    {id:'rename',label:GIT_BR_RENAME,
     disabled:t=>t.kind===GIT_REF_KIND_REMOTE?GIT_BR_LOCAL_ONLY:'',
     run:t=>gitMenuPanel().branchRename(t)},
    // BRANCH_MENU_UNIFY_SRS FR-BMU-1~3: **로컬·원격 모두 여기다.**
    // 옛 `remote-pull`(Pull/Merge)은 이것과 **같은 함수**를 부르면서 활성 조건만
    // 반대였다 — 항목이 둘이라 로컬 브랜치에서 Pull 을 누르려던 사용자가 "원격
    // 브랜치에서만" 으로 막혔다. 동작이 하나였으므로 항목도 하나다.
    // ref 종류는 더 이상 비활성 사유가 아니다 (FR-BMU-2).
    {id:'merge',label:GIT_BR_MERGE,
     disabled:t=>gitOpBusy()||(t.isHead?GIT_BR_WHY_SELF:''),
     run:t=>gitMenuPanel().branchMerge(t.short)},
    // rebase 는 파괴적이다 (`rebase`) — 커밋 해시가 바뀐다. hint 는 rebase 전 HEAD 다.
    {id:'rebase',label:GIT_BR_REBASE,destructive:true,
     action:GIT_ACT_REBASE,title:GIT_BR_REBASE_TITLE,
     disabled:t=>gitOpBusy()||(t.isHead?GIT_BR_WHY_SELF:''),
     targets:t=>[t.short],
     hint:()=>({note:GIT_BR_REBASE_NOTE,
       command:'git reset --hard '+(((gitMenuPanel().statusOf()||{}).oid)||'')}),
     run:t=>gitMenuPanel().branchRebase(t.short)},
    {sep:true},
    {id:'upstream-set',label:GIT_BR_SET_UPSTREAM,
     disabled:t=>t.kind===GIT_REF_KIND_REMOTE?GIT_BR_LOCAL_ONLY:'',
     run:t=>gitMenuPanel().branchSetUpstream(t)},
    {id:'upstream-unset',label:GIT_BR_UNSET_UPSTREAM,
     disabled:t=>t.kind===GIT_REF_KIND_REMOTE?GIT_BR_LOCAL_ONLY:(t.upstream?'':GIT_BR_WHY_NO_UPSTREAM),
     run:t=>gitMenuPanel().branchUnsetUpstream(t)},
    {id:'push',label:GIT_BR_PUSH,
     disabled:t=>t.kind===GIT_REF_KIND_REMOTE?GIT_BR_LOCAL_ONLY:'',
     run:t=>gitMenuPanel().branchPush(t)},
    {sep:true},
    // 삭제는 파괴적이다 (`branch_delete`). hint 는 **지우기 전 oid** 로 만든다
    // (FR-GIT-250.2) — 목록이 그 값을 이미 싣고 있다 (/api/git/refs).
    /**
     * FR-BMU-16 (개정 D-BMU-6): **삭제는 고른 것을 지운다.**
     *
     *   이전 동작: 원격 ref 에서 `Delete` 가 "로컬 브랜치에서만" 으로 죽고,
     *             원격을 지우는 것은 아래의 `remote-delete` 라는 **다른 항목**이었다
     *   새  동작: 한 항목이 문맥을 따른다 — 로컬 행은 로컬을, 원격 행은 그 원격을
     *   이유:     원격 행을 우클릭한 사람이 `Delete` 에서 기대하는 것은 그 원격이다.
     *             메뉴는 고른 대상을 이미 아는데 두 번 고르게 하고 있었다
     *
     * **한쪽만 지우는 길은 그대로다** — 로컬 행은 원격을, 원격 행은 로컬을
     * 건드리지 않는다. 둘을 함께 지우는 것은 여전히 `delete-both` 하나다.
     *
     * `action` 이 갈리는 것이 요점이다 (FR-BMU-16a): 파괴적 확인의 단계와 문안은
     * 서버의 파괴적 목록이 `action` 으로 정하므로, 뭉뚱그리면 원격 삭제가 로컬
     * 삭제의 확인을 입는다.
     */
    {id:'delete',destructive:true,
     label:t=>t.kind===GIT_REF_KIND_REMOTE?GIT_BR_REMOTE_DELETE:GIT_BR_DELETE,
     action:t=>t.kind===GIT_REF_KIND_REMOTE?GIT_ACT_REMOTE_REF_DELETE:GIT_ACT_BRANCH_DELETE,
     title:t=>t.kind===GIT_REF_KIND_REMOTE?GIT_BR_REMOTE_DELETE_TITLE:GIT_BR_DELETE_TITLE,
     // FR-BMU-16c: 원격 ref 에는 막을 사유가 없다. 로컬은 종전대로 현재 브랜치가 죽는다.
     disabled:t=>t.kind===GIT_REF_KIND_REMOTE?'':(t.isHead?GIT_MENU_CURRENT:''),
     targets:t=>t.kind===GIT_REF_KIND_REMOTE?[t.short]:gitMenuPanel().branchDeleteTargets(t),
     hint:t=>t.kind===GIT_REF_KIND_REMOTE
       ?({note:GIT_BR_REMOTE_DELETE_NOTE,command:GitBranches.restoreRemoteCmd(t)})
       :({note:GIT_BR_DELETE_NOTE,command:'git branch '+t.short+' '+(t.oid||'')}),
     run:t=>t.kind===GIT_REF_KIND_REMOTE
       ?gitMenuPanel().branchDeleteRemote(t.short)
       :gitMenuPanel().branchDelete(t)},
    // FR-BMU-10·11: 셋째 길 — 로컬과 원격을 한 번에. upstream 이 있는 로컬
    // 브랜치에서만 열린다. 영향 범위에 **둘 다** 실어 무엇이 사라지는지 보인다
    // (FR-BMU-12 / FR-GIT-91).
    /**
     * FR-BMU-16d (D-BMU-6): **이 항목도 문맥을 따른다.**
     *
     * 두 삭제의 뜻을 가르는 축은 *대상*이 아니라 **범위**다 — 위의 `delete` 는
     * 고른 그것만, 이것은 짝지어진 둘이다. 어느 행에서 눌러도 같은 쌍을 지운다.
     *
     * 짝을 세는 것과 그 사유는 `pairOf` 한 자리가 안다 (FR-BMU-16e) — 비활성
     * 판정과 실행이 같은 답을 봐야 눌러 놓고 아무 일도 안 일어나지 않는다.
     */
    {id:'delete-both',label:GIT_BR_DELETE_BOTH,destructive:true,
     action:GIT_ACT_BRANCH_DELETE,title:GIT_BR_DELETE_BOTH_TITLE,
     disabled:t=>{
       const p=gitMenuPanel().branchDeletePair(t);
       if(p.why) return p.why;
       // FR-BMU-16g: 로컬 먼저라는 순서는 어느 행에서 눌렀는가와 무관하다.
       // 지울 수 없는 로컬이면 원격만 지우고 끝나는 경로를 만들지 않는다.
       return p.local&&p.local.isHead?GIT_MENU_CURRENT:'';
     },
     targets:t=>{
       const p=gitMenuPanel().branchDeletePair(t);
       return [p.local&&p.local.short,p.remote].filter(Boolean);
     },
     hint:t=>{
       const p=gitMenuPanel().branchDeletePair(t);
       const loc=p.local||{};
       return {note:GIT_BR_DELETE_BOTH_NOTE,
         command:'git branch '+(loc.short||'')+' '+(loc.oid||'')
           +'\n'+GitBranches.restoreRemoteCmd({short:p.remote||'',oid:loc.oid})};
     },
     run:t=>gitMenuPanel().branchDeleteBoth(t)},
    {sep:true},
    // 원격 브랜치의 무리 (FR-GIT-268). 로컬에서는 비활성이고 사유가 보인다.
    //
    // **셋이 하나가 됐다.** FR-BMU-1 이 `remote-pull` 을 폐기했고(위의 `merge` 가
    // 그 일을 한다), FR-BMU-16(D-BMU-6)이 `remote-delete` 를 걷었다(위의 `delete`
    // 가 원격 행에서 그 일을 한다). 남은 것은 fetch 뿐이다 — 그것만이 원격 ref
    // 에서만 뜻을 갖고 다른 항목이 대신할 수 없다.
    {id:'remote-fetch',label:GIT_BR_REMOTE_FETCH,
     disabled:t=>t.kind===GIT_REF_KIND_REMOTE?'':GIT_MENU_LOCAL_ONLY,
     run:t=>gitMenuPanel().branchFetchInto(t.short)},
  ],
  // 태그 (FR-GIT-260~262). 생성은 대상을 묻지 않고 열린다 — 비우면 HEAD 다.
  //
  // **삭제가 둘인 것이 이 메뉴의 요점이다** (FR-GIT-261): 로컬과 원격은 다른
  // 항목이고 하나가 다른 하나를 자동으로 하지 않는다. 둘 다 `destructive:true`
  // 이므로 파괴적 확인은 프레임워크가 거치고, 항목은 **되살리는 명령**만 선언한다
  // — 그 명령은 지우기 전 oid 를 싣는다 (FR-GIT-92·250.2).
  tag:[
    {id:'create',label:GIT_TAG_NEW,run:()=>gitMenuPanel().createTag('')},
    {id:'copy-name',label:t('git.menu.copy_tag_name'),run:t=>gitMenuPanel().copyText(t.short)},
    // 태그는 브랜치가 아니므로 옮겨 가면 detached 다 — 사전 경고를 1단계 거친다
    // (FR-GIT-144 와 같은 규약).
    {id:'checkout', label:'Checkout (detached)',warn:true,
     action:GIT_CHECKOUT_DETACHED_ACT,title:GIT_CHECKOUT_DETACHED_TITLE,
     targets:t=>[t.short],
     hint:()=>({note:GIT_DETACHED_NOTE,command:''}),
     run:t=>gitMenuPanel().checkoutRef(t.short,{detach:true})},
    {sep:true},
    // push 는 파괴적이 아니다 — 원격에 없던 ref 를 더할 뿐이다. 원격 작업이므로
    // job 경로를 탄다 (FR-GIT-262·101~104).
    {id:'push',    label:GIT_TAG_PUSH,    run:t=>gitMenuPanel().tagPush(t.short)},
    {id:'push-all',label:GIT_TAG_PUSH_ALL,run:()=>gitMenuPanel().tagPushAll()},
    {sep:true},
    {id:'delete',label:GIT_TAG_DELETE,destructive:true,
     action:GIT_ACT_TAG_DELETE,title:GIT_TAG_DELETE_TITLE,
     targets:t=>[t.short],
     hint:t=>({note:GIT_TAG_DELETE_NOTE,
       command:'git tag '+t.short+' '+gitTagOid(t)}),
     run:t=>gitMenuPanel().tagDelete(t.short)},
    {id:'delete-remote',label:GIT_TAG_DELETE_REMOTE,destructive:true,
     action:GIT_ACT_REMOTE_REF_DELETE,title:GIT_TAG_DELETE_REMOTE_TITLE,
     targets:t=>[t.short],
     hint:t=>({note:GIT_TAG_DELETE_REMOTE_NOTE,
       command:'git push '+GitTag.remoteOf(gitMenuPanel())+' '+gitTagOid(t)+
         ':refs/tags/'+t.short}),
     run:t=>gitMenuPanel().tagDeleteRemote(t.short)},
  ],
  // stash (FR-GIT-162~164·168). drop 만 파괴적이며 확인은 프레임워크가 거친다 —
  // 항목이 확인 코드를 따로 쓰지 않는다.
  stash:[
    {id:'apply',      label:GIT_STASH_APPLY,      run:t=>gitMenuPanel().stashApply(t.oid,false)},
    {id:'apply-index',label:GIT_STASH_APPLY_INDEX,run:t=>gitMenuPanel().stashApply(t.oid,true)},
    {id:'pop',        label:GIT_STASH_POP,        run:t=>gitMenuPanel().stashPop(t.oid)},
    {sep:true},
    {id:'drop',label:GIT_STASH_DROP,destructive:true,
     action:GIT_ACT_STASH_DROP,title:GIT_STASH_DROP_TITLE,
     targets:t=>[GitStash.label(t)],
     // hint 는 지워질 stash 의 sha 로 만든다 — 안내문만 남기면 되살릴 수 없다
     // (FR-GIT-92·168). 서버도 실행 전에 같은 것을 HintLog 에 남긴다.
     hint:t=>({note:GIT_STASH_DROP_NOTE,
       command:'git stash store -m '+gitShQuote(t.message||'')+' '+(t.oid||'')}),
     run:t=>gitMenuPanel().stashDrop(t.oid)},
    {sep:true},
    // FR-GIT-272: 그 stash 를 새 브랜치에 적용하며 옮겨 간다. **파괴적이 아니다**
    // — git 은 적용이 끝난 뒤에만 stash 를 지운다.
    {id:'branch-from',label:GIT_STASH_BRANCH,run:t=>gitMenuPanel().stashBranch(t)},
    {id:'copy-name',  label:GIT_STASH_COPY_NAME,run:t=>gitMenuPanel().copyText(GitStash.ref(t.index))},
    {id:'copy-hash',  label:GIT_STASH_COPY_HASH,run:t=>gitMenuPanel().copyText(t.oid)},
  ],
  // 미커밋 변경 행 (FR-GIT-127·277).
  uncommitted:[
    {id:'open-changes',label:t('git.menu.open_changes'),run:()=>gitMenuPanel().openView('changes')},
    {sep:true},
    // FR-GIT-277: 생성 다이얼로그를 그대로 다시 쓴다 — 두 벌로 두면 한쪽만 고쳐진다.
    {id:'stash',label:GIT_UNC_STASH,
     disabled:()=>gitMenuPanel().dirtyCount()?'':GIT_UNC_NOTHING,
     run:()=>gitMenuPanel().stashCreate()},
    // mixed 다 — index 만 HEAD 로 되돌리고 워킹 트리는 그대로 둔다. 파괴적이
    // 아니므로 확인을 붙이지 않는다 (FR-GIT-97).
    {id:'reset',label:GIT_UNC_RESET,run:()=>gitMenuPanel().uncommittedReset()},
    // **파괴적이다** (FR-GIT-277). 되살릴 수 없으므로 hint 는 되돌리는 명령이
    // 아니라 먼저 담아 두는 명령이다.
    {id:'clean',label:GIT_UNC_CLEAN,destructive:true,
     action:GIT_ACT_CLEAN_UNTRACKED,title:GIT_UNC_CLEAN_TITLE,
     disabled:()=>gitMenuPanel().untrackedPaths().length?'':GIT_UNC_NOTHING,
     targets:()=>gitMenuPanel().untrackedPaths(),
     hint:()=>({note:GIT_UNC_CLEAN_NOTE,command:GIT_UNC_CLEAN_CMD}),
     run:()=>gitMenuPanel().uncommittedClean()},
  ],
};

class GitMenu {
  /**
   * open 은 항목 집합을 렌더하고 키보드 조작을 붙인다. 한 번에 하나만 열린다 —
   * 겹치면 어느 대상의 메뉴인지 알 수 없다.
   *
   * ev 는 좌표만 쓴다 (`clientX`/`clientY`) — 합성 객체로도 열 수 있어야 검증이
   * 프레임워크만 볼 수 있다 (V52).
   */
  /**
   * FR-GIT-222: 행의 **기본 동작**. 더블클릭이 메뉴와 같은 경로로 가도록 항목을
   * 여기서 고른다 — 조건을 두 곳에 적으면 두 진입점의 뜻이 갈라진다.
   *
   * 후보를 순서대로 보고 **비활성이 아닌 첫 항목**을 고른다. 후보가 없거나
   * (태그처럼) 전부 비활성이면 아무 일도 하지 않는다 — 더블클릭이 메뉴보다
   * 관대해지면 사용자가 메뉴에서 막힌 것을 제스처로 통과시킬 수 있다.
   */
  static primary(kind,target){
    const ids=GIT_MENU_PRIMARY[kind]; if(!ids) return null;
    const items=GIT_MENUS[kind]||[];
    for(const id of ids){
      const it=items.find(x=>!x.sep&&x.id===id);
      if(!it||(it.disabled&&it.disabled(target))) continue;
      return it;
    }
    return null;
  }

  // 확인 게이트(_pick)를 그대로 지난다 — 더블클릭이 확인을 건너뛰지 않는다.
  static runPrimary(kind,target){
    const it=GitMenu.primary(kind,target);
    if(!it) return false;
    GitMenu._pick(it,target);
    return true;
  }

  static open(kind,target,ev){
    GitMenu.openList(GIT_MENUS[kind],kind,target,ev);
  }

  /**
   * openList 는 **항목을 인자로** 받는다 — 리포 목록처럼 선언으로 고정할 수 없는
   * 것을 위한 자리다 (FR-GIT-282).
   *
   * open 과 같은 _pick 을 지난다. 확인 게이트를 두 벌로 두면 한쪽만 고쳐진다.
   */
  static openList(items,kind,target,ev){
    GitMenu.close();
    if(!items||!items.length) return;
    /**
     * CONTEXT_MENU_UNIFY_SRS FR-CMU-6 / D-CMU-1: **어댑터**다. 항목 표의 어휘
     * (`run`·`disabled(target)`·`tip`·`cur`)를 키트 항목으로 옮기고 `UIKit.menu` 를
     * 부른다 — DOM·키 이동·닫힘은 키트의 것이다. 옛 이름(`git-menu*`)은 함께
     * 붙는다 (FR-CMU-5, e2e 가 짚는다). 확인 게이트 `_pick` 만 여기 남는다.
     */
    const kit=items.map(it=>{
      if(it.sep) return {sep:true};
      const why=it.disabled?(it.disabled(target)||''):'';
      return {
        id:it.id,label:GitMenu._val(it.label,target),cur:!!it.cur,
        // 사유가 있으면 그것이 title 이고, 없으면 툴팁(`tip`)이다 — `title` 은
        // 확인 다이얼로그의 제목으로 이미 쓰인다.
        disabled:why||false,title:why?'':(it.tip||''),
        onClick:()=>GitMenu._pick(it,target),
      };
    });
    const m=UIKit.menu(kit,{
      at:{x:(ev&&ev.clientX)||0,y:(ev&&ev.clientY)||0},
      cls:'git-menu',itemCls:'git-menu-item',sepCls:'git-menu-sep',
    });
    m.dataset.kind=kind;
  }

  /**
   * BRANCH_MENU_UNIFY_SRS FR-BMU-16b: 항목의 값이 **대상을 볼 수 있다.**
   *
   * `disabled`·`targets`·`hint` 는 이미 `t=>...` 꼴이었고 `label`·`title`·
   * `action` 만 상수였다. 그래서 한 항목이 문맥에 따라 다른 것을 지우게 만들 수
   * 없었다 — 규약을 하나로 맞춘다. 상수는 그대로 상수로 지난다.
   */
  static _val(v,target){return typeof v==='function'?v(target):v}

  static close(){UIKit.closeMenu()}

  /**
   * 실행 전 확인은 여기 한 곳에만 있다 (계약 §4.2) — 항목이 확인 코드를 따로
   * 쓰면 새 항목마다 방어를 다시 만들어야 하고, 한 곳이 빠지면 조용히 사라진다.
   *
   * `stages:1` 을 늘 넘긴다. 파괴적 목록(서버 `/api/git/policy`)에 든 action 은
   * `GitConfirm` 이 요청과 무관하게 확인을 세운다 — 목록에 없는 action 이
   * 확인 없이 지나가는 일이 없게 바닥을 1단계로 둔다.
   */
  static async _pick(it,target){
    GitMenu.close();
    if(typeof it.run!=='function') return;
    if(it.warn||it.destructive){
      const ok=await GitDialog.confirm({
        action:GitMenu._val(it.action,target)||it.id,
        title:GitMenu._val(it.title,target)||GitMenu._val(it.label,target),
        targets:it.targets?it.targets(target):[],
        hint:it.hint?it.hint(target):null,
        stages:1,
      });
      if(!ok) return;
    }
    await it.run(target);
  }
}


// 고전 스크립트의 class·const 선언은 window 의 속성이 되지 않는다 — GitPanel 과
// e2e 가 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitMenu=GitMenu;
window.GIT_MENUS=GIT_MENUS;
window.GIT_MENU_PRIMARY=GIT_MENU_PRIMARY;
window.gitOpBusy=gitOpBusy;
