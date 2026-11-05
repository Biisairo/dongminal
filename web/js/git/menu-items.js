/**
 * Dongminal — Git 컨텍스트 메뉴의 **항목 표** (GIT_SRS §3C.2 / FR-GIT-146)
 *
 * `menu.js`(프레임워크)에서 떼어 냈다 — 모듈 크기 기준선(FR-STR-40)을 지키기 위한
 * 이동이며 내용은 같다. 항목의 모양은 `menu.js` 머리 주석에 있다.
 */

// 항목의 run·disabled 는 패널을 통해 동작한다 — 메뉴는 대상과 항목만 알고, 무엇을
// 실행하는지는 패널이 안다.
function gitMenuPanel(){return (window.app&&app.gitPanel)||null}

// FR-GIT-250.2: 파괴적 태그 항목의 확인 문구에 실을 **지우기 전 oid**. 값을 모르면
// 지어내지 않는다 — 서버가 실행 전에 진짜 oid 로 hint 를 남긴다 (FR-GIT-92).
function gitTagOid(target){
  return GitTag.oidOf(gitMenuPanel(),target)||GIT_TAG_OID_UNKNOWN;
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

// 열 때 서버에 묻는 메뉴 — 대상 → 질의 (SERVER_DRIVEN_ACTIONS_SRS GT-a).
const GIT_MENU_ASK={
  commit:target=>({kind:'commit',oid:target.oid}),
  branch:target=>({kind:'branch',ref:GitBranches.refName(target)}),
};

const GIT_MENUS={
  // 커밋 (FR-GIT-140~144). 저장소를 바꾸는 항목은 checkout 하나다.
  commit:[
    // FR-GIT-141: 18단계의 생성 다이얼로그를 시작점만 이 커밋으로 고정해 연다 —
    // 이름 검증(FR-GIT-159)까지 그것이 이미 안다.
    {id:'branch-from',busy:GIT_ACTION.write,label:t('git.menu.branch_from'),
     run:target=>gitMenuPanel().createBranchFrom(target.oid)},
    // FR-GIT-260: 태그 생성의 **같은 다이얼로그**를 대상만 이 커밋으로 고정해 연다
    // — 이름 검증도 종류 선택도 그것이 이미 안다.
    {id:'tag-from',busy:GIT_ACTION.write,label:GIT_TAG_CREATE_AT,
     run:target=>gitMenuPanel().createTag(target.oid)},
    {id:'copy-hash',   label:t('git.menu.copy_hash'),run:target=>gitMenuPanel().copyText(target.oid)},
    {id:'copy-subject',label:t('git.menu.copy_subject'),run:target=>gitMenuPanel().copyText(target.subject)},
    {sep:true},
    // FR-GIT-144: detached 가 됨을 사전 경고하고, dirty 면 묶음 N 의 3선택을
    // 거친다 — 태그 메뉴와 같은 경로다. 판정을 두 벌로 만들지 않는다.
    {id:'checkout-detached',busy:GIT_ACTION.write,label:'Checkout (detached)',warn:true,
     action:GIT_CHECKOUT_DETACHED_ACT,title:GIT_CHECKOUT_DETACHED_TITLE,
     targets:target=>[target.abbrev+(target.subject?' '+target.subject:'')],
     hint:()=>({note:GIT_DETACHED_NOTE,command:''}),
     run:target=>gitMenuPanel().checkoutRef(target.oid,{detach:true})},
    {sep:true},
    // 묶음 D — 커밋 동작 (GIT_ACTIONS_SRS §3.4 / FR-GIT-263~266).
    //
    // 넷 다 메뉴를 열 때 서버에 묻는다 (SERVER_DRIVEN_ACTIONS_SRS GT-c·f) — 진행 중
    // 작업·칸·대상(HEAD·루트·머지)의 판정은 서버의 답(`act`)이다.
    {id:'cherry-pick',act:GIT_ACTION.commitCherryPick,label:GIT_CO_CHERRY_LABEL,
     run:target=>GitCommitOps.cherryPick(gitMenuPanel(),target)},
    {id:'revert',act:GIT_ACTION.commitRevert,label:GIT_CO_REVERT_LABEL,
     run:target=>GitCommitOps.revert(gitMenuPanel(),target)},
    // reset 은 **파괴 여부가 옵션에서 파생하므로**(`--hard` 만) 여기서
    // destructive 를 선언하지 않는다 — 선언하면 세 모드 전부가 확인을 요구한다.
    {id:'reset',act:GIT_ACTION.commitReset,label:GIT_CO_RESET_LABEL,
     run:target=>GitCommitOps.reset(gitMenuPanel(),target)},
    // drop 은 언제나 파괴적이다 (`commit_drop`). 파괴적 확인과 recovery hint 는
    // 프레임워크가 거친다 — 항목이 확인 코드를 따로 쓰지 않는다 (FR-GIT-89·92).
    {id:'drop',act:GIT_ACTION.commitDrop,label:GIT_CO_DROP_LABEL,destructive:true,
     action:GIT_ACT_COMMIT_DROP,title:GIT_CO_DROP_TITLE,
     targets:target=>[GitCommitOps.label(target)],
     hint:()=>({note:GIT_CO_DROP_NOTE,
       command:GitCommitOps._restoreCmd(gitMenuPanel())}),
     run:target=>GitCommitOps.drop(gitMenuPanel(),target)},
    {sep:true},
    // FR-GIT-267: 커밋 둘을 고르는 길. 기준을 표시해 두면 Compare with 의 리비전
    // 칸이 그것으로 채워진다 — `A..B` 입력도 같은 칸으로 들어온다.
    {id:'compare-mark',label:GIT_CO_MARK_LABEL,
     run:target=>GitCommitOps.mark(gitMenuPanel(),target)},
    {id:'compare-with',label:GIT_CO_COMPARE_LABEL,
     run:target=>GitCommitOps.compare(gitMenuPanel(),target)},
  ],
  // 파일 (S1 목록 / History 상세 목록). 저장소를 바꾸는 항목이 하나도 없다
  // (FR-GIT-41) — 5단계의 GIT_CTX_ITEMS 를 그대로 옮긴 것이다.
  file:[
    {id:'openChanges',label:t('git.menu.file_open_changes'),run:target=>gitMenuPanel().openFileDiff(target)},
    // FR-GIT-236: 행 인라인 동작과 같은 자리를 지난다 — 두 벌로 두면 한쪽만 고쳐진다.
    {id:'openFile',   label:t('git.menu.file_open_file'),run:target=>gitMenuPanel()._run('openFile',[target])},
    // FR-GIT-274: 워킹 트리가 아니라 `HEAD:<path>` 의 내용이다. 여는 자리는
    // Open File 과 같다 — Git 창이 아닌 창이다 (FR-GIT-179·185).
    {id:'openFileHead',label:GIT_FILE_OPEN_HEAD,run:target=>gitMenuPanel().openFileAtHead(target)},
    {id:'copyPath',   label:t('git.menu.file_copy_path'),run:target=>gitMenuPanel().copyText(gitMenuPanel().absPath(target))},
    {sep:true},
    // FR-GIT-275: path 필터가 이미 있으므로(FR-GIT-129) 그것을 채워 탭을 여는 것이
    // 전부다 — 새 조회를 만들지 않는다.
    {id:'fileHistory',label:GIT_FILE_HISTORY,run:target=>gitMenuPanel().openFileHistory(target)},
    // FR-GIT-276: 고정 탭을 늘리지 않는다 — Diff 탭을 blame 모드로 연다 (D8).
    {id:'blame',      label:GIT_FILE_BLAME,  run:target=>gitMenuPanel().openBlame(target)},
    // FR-GIT-273: **git 실행이 아니라 파일 쓰기다.** 저장소 루트의 `.gitignore`
    // 하나만 대상이며, 경로가 그 안인지는 서버가 다시 본다.
    {id:'ignore',busy:GIT_ACTION.write,     label:GIT_FILE_IGNORE,run:target=>gitMenuPanel().ignorePath(target)},
  ],
  // 브랜치·태그 (FR-GIT-154·155·156·160). 로컬과 원격은 **뜻이 다른 두 항목**이다 —
  // 원격 ref 로 그냥 옮겨 가면 detached 가 되므로 같은 이름의 로컬을 만들며 추적을
  // 설정한다 (FR-GIT-156). 어느 쪽이 왜 막혔는지는 사유로 알린다.
  branch:[
    {id:'copy-name',label:t('git.menu.copy_branch_name'),run:target=>gitMenuPanel().copyText(target.short)},
    {id:'checkout',act:GIT_ACTION.branchCheckout, label:'Checkout',
     run:target=>gitMenuPanel().checkoutRef(target.short,{})},
    {id:'checkout-local',act:GIT_ACTION.branchCheckoutLocal,label:GIT_BR_CHECKOUT_LOCAL,
     run:target=>gitMenuPanel().checkoutRemote(target.short)},
    {sep:true},
    // 묶음 B — 접수한 말의 본체 (GIT_ACTIONS_SRS §3.2 FR-GIT-253~259).
    //
    // 판정(진행 중 작업·ref 종류·현재 브랜치)은 메뉴를 열 때 서버가 답한다 (GT-d·f).
    // FR-GIT-259: 커밋 메뉴의 `branch-from` 과 **같은 함수**를 시작점만 바꿔 부른다.
    {id:'branch-from',busy:GIT_ACTION.write,label:GIT_BR_CREATE_FROM,
     run:target=>gitMenuPanel().createBranchFrom(target.short)},
    {id:'rename',act:GIT_ACTION.branchRename,label:GIT_BR_RENAME,
     run:target=>gitMenuPanel().branchRename(target)},
    // BRANCH_MENU_UNIFY_SRS FR-BMU-1~3: **로컬·원격 모두 여기다.**
    // 옛 `remote-pull`(Pull/Merge)은 이것과 **같은 함수**를 부르면서 활성 조건만
    // 반대였다 — 항목이 둘이라 로컬 브랜치에서 Pull 을 누르려던 사용자가 "원격
    // 브랜치에서만" 으로 막혔다. 동작이 하나였으므로 항목도 하나다.
    // ref 종류는 더 이상 비활성 사유가 아니다 (FR-BMU-2).
    {id:'merge',act:GIT_ACTION.branchMerge,label:GIT_BR_MERGE,
     run:target=>gitMenuPanel().branchMerge(target.short)},
    // rebase 는 파괴적이다 (`rebase`) — 커밋 해시가 바뀐다. hint 는 rebase 전 HEAD 다.
    {id:'rebase',act:GIT_ACTION.branchRebase,label:GIT_BR_REBASE,destructive:true,
     action:GIT_ACT_REBASE,title:GIT_BR_REBASE_TITLE,
     targets:target=>[target.short],
     hint:()=>({note:GIT_BR_REBASE_NOTE,
       command:'git reset --hard '+(((gitMenuPanel().statusOf()||{}).oid)||'')}),
     run:target=>gitMenuPanel().branchRebase(target.short)},
    {sep:true},
    {id:'upstream-set',act:GIT_ACTION.branchUpstreamSet,label:GIT_BR_SET_UPSTREAM,
     run:target=>gitMenuPanel().branchSetUpstream(target)},
    {id:'upstream-unset',act:GIT_ACTION.branchUpstreamUnset,label:GIT_BR_UNSET_UPSTREAM,
     run:target=>gitMenuPanel().branchUnsetUpstream(target)},
    {id:'push',act:GIT_ACTION.branchPush,label:GIT_BR_PUSH,
     run:target=>gitMenuPanel().branchPush(target)},
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
    {id:'delete',act:target=>target.kind===GIT_REF_KIND_REMOTE?GIT_ACTION.branchDeleteRemote:GIT_ACTION.branchDelete,destructive:true,
     label:target=>target.kind===GIT_REF_KIND_REMOTE?GIT_BR_REMOTE_DELETE:GIT_BR_DELETE,
     action:target=>target.kind===GIT_REF_KIND_REMOTE?GIT_ACT_REMOTE_REF_DELETE:GIT_ACT_BRANCH_DELETE,
     title:target=>target.kind===GIT_REF_KIND_REMOTE?GIT_BR_REMOTE_DELETE_TITLE:GIT_BR_DELETE_TITLE,
     targets:target=>target.kind===GIT_REF_KIND_REMOTE?[target.short]:gitMenuPanel().branchDeleteTargets(target),
     hint:target=>target.kind===GIT_REF_KIND_REMOTE
       ?({note:GIT_BR_REMOTE_DELETE_NOTE,command:GitBranches.restoreRemoteCmd(target)})
       :({note:GIT_BR_DELETE_NOTE,command:'git branch '+target.short+' '+(target.oid||'')}),
     run:(target,names)=>target.kind===GIT_REF_KIND_REMOTE
       ?gitMenuPanel().branchDeleteRemote(names[0])
       :gitMenuPanel().branchDelete(target,names)},
    // FR-BMU-10·11: 셋째 길 — 로컬과 원격을 한 번에. upstream 이 있는 로컬
    // 브랜치에서만 열린다. 영향 범위에 **둘 다** 실어 무엇이 사라지는지 보인다
    // (FR-BMU-12 / FR-GIT-91).
    /**
     * FR-BMU-16d (D-BMU-6): **이 항목도 문맥을 따른다.**
     *
     * 두 삭제의 뜻을 가르는 축은 *대상*이 아니라 **범위**다 — 위의 `delete` 는
     * 고른 그것만, 이것은 짝지어진 둘이다. 어느 행에서 눌러도 같은 쌍을 지운다.
     *
     * 짝을 켜고 끄는 판정과 실행은 서버가 같은 함수로 한다 (GT-e). 확인창에 보일 짝은
     * `pairOf` 가 센다.
     */
    // 짝 판정(추적 로컬이 정확히 하나·현재 브랜치 아님)은 서버의 답이다 (GT-e). 확인창의
    // 대상·hint 는 보여 줄 목록이라 화면이 짝을 그대로 센다.
    {id:'delete-both',act:GIT_ACTION.branchDeleteBoth,label:GIT_BR_DELETE_BOTH,destructive:true,
     action:GIT_ACT_BRANCH_DELETE,title:GIT_BR_DELETE_BOTH_TITLE,
     targets:target=>{
       const p=gitMenuPanel().branchDeletePair(target);
       return [p.local&&p.local.short,p.remote].filter(Boolean);
     },
     hint:target=>{
       const p=gitMenuPanel().branchDeletePair(target);
       const loc=p.local||{};
       return {note:GIT_BR_DELETE_BOTH_NOTE,
         command:'git branch '+(loc.short||'')+' '+(loc.oid||'')
           +'\n'+GitBranches.restoreRemoteCmd({short:p.remote||'',oid:loc.oid})};
     },
     run:(target,names)=>gitMenuPanel().branchDeleteBoth(target,names)},
    {sep:true},
    // 원격 브랜치의 무리 (FR-GIT-268). 로컬에서는 비활성이고 사유가 보인다.
    //
    // **셋이 하나가 됐다.** FR-BMU-1 이 `remote-pull` 을 폐기했고(위의 `merge` 가
    // 그 일을 한다), FR-BMU-16(D-BMU-6)이 `remote-delete` 를 걷었다(위의 `delete`
    // 가 원격 행에서 그 일을 한다). 남은 것은 fetch 뿐이다 — 그것만이 원격 ref
    // 에서만 뜻을 갖고 다른 항목이 대신할 수 없다.
    {id:'remote-fetch',act:GIT_ACTION.branchFetch,label:GIT_BR_REMOTE_FETCH,
     run:target=>gitMenuPanel().branchFetchInto(target.short)},
  ],
  // 태그 (FR-GIT-260~262). 생성은 대상을 묻지 않고 열린다 — 비우면 HEAD 다.
  //
  // **삭제가 둘인 것이 이 메뉴의 요점이다** (FR-GIT-261): 로컬과 원격은 다른
  // 항목이고 하나가 다른 하나를 자동으로 하지 않는다. 둘 다 `destructive:true`
  // 이므로 파괴적 확인은 프레임워크가 거치고, 항목은 **되살리는 명령**만 선언한다
  // — 그 명령은 지우기 전 oid 를 싣는다 (FR-GIT-92·250.2).
  tag:[
    {id:'create',busy:GIT_ACTION.write,label:GIT_TAG_NEW,run:()=>gitMenuPanel().createTag('')},
    {id:'copy-name',label:t('git.menu.copy_tag_name'),run:target=>gitMenuPanel().copyText(target.short)},
    // 태그는 브랜치가 아니므로 옮겨 가면 detached 다 — 사전 경고를 1단계 거친다
    // (FR-GIT-144 와 같은 규약).
    {id:'checkout',busy:GIT_ACTION.write, label:'Checkout (detached)',warn:true,
     action:GIT_CHECKOUT_DETACHED_ACT,title:GIT_CHECKOUT_DETACHED_TITLE,
     targets:target=>[target.short],
     hint:()=>({note:GIT_DETACHED_NOTE,command:''}),
     run:target=>gitMenuPanel().checkoutRef(target.short,{detach:true})},
    {sep:true},
    // push 는 파괴적이 아니다 — 원격에 없던 ref 를 더할 뿐이다. 원격 작업이므로
    // job 경로를 탄다 (FR-GIT-262·101~104).
    {id:'push',busy:GIT_ACTION.tagPush,    label:GIT_TAG_PUSH,    run:target=>gitMenuPanel().tagPush(target.short)},
    {id:'push-all',busy:GIT_ACTION.tagPush,label:GIT_TAG_PUSH_ALL,run:()=>gitMenuPanel().tagPushAll()},
    {sep:true},
    {id:'delete',busy:GIT_ACTION.write,label:GIT_TAG_DELETE,destructive:true,
     action:GIT_ACT_TAG_DELETE,title:GIT_TAG_DELETE_TITLE,
     targets:target=>[target.short],
     hint:target=>({note:GIT_TAG_DELETE_NOTE,
       command:'git tag '+target.short+' '+gitTagOid(target)}),
     run:target=>gitMenuPanel().tagDelete(target.short)},
    {id:'delete-remote',busy:GIT_ACTION.tagDeleteRemote,label:GIT_TAG_DELETE_REMOTE,destructive:true,
     action:GIT_ACT_REMOTE_REF_DELETE,title:GIT_TAG_DELETE_REMOTE_TITLE,
     targets:target=>[target.short],
     hint:target=>({note:GIT_TAG_DELETE_REMOTE_NOTE,
       command:'git push '+GitTag.remoteOf(gitMenuPanel())+' '+gitTagOid(target)+
         ':refs/tags/'+target.short}),
     run:target=>gitMenuPanel().tagDeleteRemote(target.short)},
  ],
  // stash (FR-GIT-162~164·168). drop 만 파괴적이며 확인은 프레임워크가 거친다 —
  // 항목이 확인 코드를 따로 쓰지 않는다.
  stash:[
    {id:'apply',busy:GIT_ACTION.write,      label:GIT_STASH_APPLY,      run:target=>gitMenuPanel().stashApply(target.oid,false)},
    {id:'apply-index',busy:GIT_ACTION.write,label:GIT_STASH_APPLY_INDEX,run:target=>gitMenuPanel().stashApply(target.oid,true)},
    {id:'pop',busy:GIT_ACTION.write,        label:GIT_STASH_POP,        run:target=>gitMenuPanel().stashPop(target.oid)},
    {sep:true},
    {id:'drop',busy:GIT_ACTION.write,label:GIT_STASH_DROP,destructive:true,
     action:GIT_ACT_STASH_DROP,title:GIT_STASH_DROP_TITLE,
     targets:target=>[GitStash.label(target)],
     // hint 는 지워질 stash 의 sha 로 만든다 — 안내문만 남기면 되살릴 수 없다
     // (FR-GIT-92·168). 서버도 실행 전에 같은 것을 HintLog 에 남긴다.
     hint:target=>({note:GIT_STASH_DROP_NOTE,
       command:'git stash store -m '+gitShQuote(target.message||'')+' '+(target.oid||'')}),
     run:target=>gitMenuPanel().stashDrop(target.oid)},
    {sep:true},
    // FR-GIT-272: 그 stash 를 새 브랜치에 적용하며 옮겨 간다. **파괴적이 아니다**
    // — git 은 적용이 끝난 뒤에만 stash 를 지운다.
    {id:'branch-from',busy:GIT_ACTION.write,label:GIT_STASH_BRANCH,run:target=>gitMenuPanel().stashBranch(target)},
    {id:'copy-name',  label:GIT_STASH_COPY_NAME,run:target=>gitMenuPanel().copyText(GitStash.ref(target.index))},
    {id:'copy-hash',  label:GIT_STASH_COPY_HASH,run:target=>gitMenuPanel().copyText(target.oid)},
  ],
  // 미커밋 변경 행 (FR-GIT-127·277).
  uncommitted:[
    {id:'open-changes',label:t('git.menu.open_changes'),run:()=>gitMenuPanel().openView('changes')},
    {sep:true},
    // FR-GIT-277: 생성 다이얼로그를 그대로 다시 쓴다 — 두 벌로 두면 한쪽만 고쳐진다.
    // 열 수 있는가는 서버의 1층 답이다 (SERVER_DRIVEN_ACTIONS_SRS GR-2b·e).
    {id:'stash',busy:GIT_ACTION.stashNew,label:GIT_UNC_STASH,
     run:()=>gitMenuPanel().stashCreate()},
    // mixed 다 — index 만 HEAD 로 되돌리고 워킹 트리는 그대로 둔다. 파괴적이
    // 아니므로 확인을 붙이지 않는다 (FR-GIT-97).
    {id:'reset',busy:GIT_ACTION.uncommittedReset,label:GIT_UNC_RESET,run:()=>gitMenuPanel().uncommittedReset()},
    // **파괴적이다** (FR-GIT-277). 되살릴 수 없으므로 hint 는 되돌리는 명령이
    // 아니라 먼저 담아 두는 명령이다.
    // 지울 것이 있는가는 서버의 답이다. 확인 목록(targets)은 보여 줄 목록일 뿐이다.
    {id:'clean',busy:GIT_ACTION.uncommittedClean,label:GIT_UNC_CLEAN,destructive:true,
     action:GIT_ACT_CLEAN_UNTRACKED,title:GIT_UNC_CLEAN_TITLE,
     targets:()=>gitMenuPanel().untrackedPaths(),
     hint:()=>({note:GIT_UNC_CLEAN_NOTE,command:GIT_UNC_CLEAN_CMD}),
     run:(_,paths)=>gitMenuPanel().uncommittedClean(paths)},
  ],
};
