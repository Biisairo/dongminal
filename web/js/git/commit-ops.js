/**
 * Dongminal — 커밋 하나를 대상으로 하는 동작 (GIT_ACTIONS_SRS §3.4 / FR-GIT-263~267)
 *
 * History 의 커밋 우클릭이 여는 것들이다: Cherry-pick · Revert · Reset to here ·
 * Drop · Compare with. `GIT_MENUS.commit` 이 항목을 **선언**하고 실행은 여기 있다 —
 * 메뉴는 History 의 어느 자리에서도 열리므로 History 인스턴스에 묶여 있으면 안
 * 된다 (`GitBranches` 가 브랜치 항목에 대해 하는 것과 같은 배치다).
 *
 * 규약 셋을 잃지 않는다:
 *
 * - **확인은 프레임워크가 한다** (FR-GIT-250 의 4겹 중 ④). 항목이 확인 코드를
 *   따로 쓰지 않는다 — Drop 은 `destructive:true` 선언 하나이고, Reset 은 파괴
 *   여부가 **옵션에서 파생하므로**(`--hard` 만 참) 다이얼로그가 값을 받은 뒤에
 *   `GitDialog.confirm` 으로 넘긴다.
 * - **충돌은 실패가 아니다** (FR-GIT-251·252). cherry-pick·revert·drop 이 멈추면
 *   진행 중 상태이고 출구는 Changes 탭 머리에 이미 있다 — 여기서 새 출구를
 *   만들지 않고, 그 결과를 실패로 뭉개지도 않는다.
 * - **새 diff 축을 만들지 않는다** (FR-GIT-267). Compare with 가 고른 두 리비전은
 *   이미 있는 `commit ↔ parent` 축(FR-GIT-138)의 두 끝으로 그대로 들어간다.
 */
class GitCommitOps {
  // ── Cherry-pick (FR-GIT-263) ──

  /**
   * 머지 커밋이면 **기준 부모를 묻는다.** 묻지 않고 고르면 틀린 부모를 집고,
   * 사용자는 결과를 되돌리기 전까지 그것을 모른다. 보통 커밋은 물을 것이 없으므로
   * 다이얼로그를 세우지 않는다 — 빈 다이얼로그는 확인처럼 보이고 확인이 아니다.
   */
  static cherryPick(panel,c){
    if(!GitCommitOps._merge(c))
      return GitCommitOps._send(panel,'/api/git/cherry-pick',{oid:c.oid});
    return GitDialog.open({
      id:'git-cherry-pick',ns:'gco',action:'cherry_pick',
      title:GIT_CO_CHERRY_TITLE,runLabel:GIT_CO_CHERRY_RUN,
      body:GIT_CO_CONFLICT_NOTE,
      fields:[GitCommitOps._mainlineField(c)],
      run:v=>GitCommitOps._send(panel,'/api/git/cherry-pick',
        {oid:c.oid,mainline:GitCommitOps._mainline(v)}),
    });
  }

  // ── Revert (FR-GIT-264) ──

  /**
   * `--no-commit` 이 옵션이므로 보통 커밋에서도 다이얼로그가 있다. 머지 커밋은
   * cherry-pick 과 **같은 부모 선택**을 받는다 — 규약이 두 벌이면 한쪽만 고쳐진다.
   */
  static revert(panel,c){
    const merge=GitCommitOps._merge(c);
    const fields=[];
    if(merge) fields.push(GitCommitOps._mainlineField(c));
    // 옵션의 기본값은 안전한 쪽이다 (FR-GIT-173) — 커밋까지 만드는 것이 기본이다.
    fields.push({key:'noCommit',type:GIT_DIALOG_CHECK,cls:'gco-nocommit',
      label:GIT_CO_REVERT_NOCOMMIT});
    return GitDialog.open({
      id:'git-revert',ns:'gco',action:'revert',
      title:GIT_CO_REVERT_TITLE,runLabel:GIT_CO_REVERT_RUN,
      body:GIT_CO_CONFLICT_NOTE,fields,
      run:v=>GitCommitOps._send(panel,'/api/git/revert',{
        oid:c.oid,noCommit:!!v.noCommit,
        mainline:merge?GitCommitOps._mainline(v):0,
      }),
    });
  }

  // ── Reset to here (FR-GIT-265) ──

  /**
   * 다이얼로그가 **영향 커밋 수**를 실행 전에 보인다 (G11) — 개수를 모르면
   * 사용자는 무엇이 움직이는지 모른 채 고른다. 세지 못하면 그 사실을 적는다:
   * 0 으로 보이면 "아무 일도 없다" 로 읽힌다.
   *
   * **`--hard` 만 파괴적이다.** 그래서 항목에 `destructive:true` 를 걸 수 없고
   * (그러면 세 모드 전부가 2단계가 된다), 값을 받은 뒤 파괴 여부를 파생해
   * `GitDialog.confirm` 으로 넘긴다.
   */
  static async reset(panel,c){
    const n=await GitCommitOps._count(panel,c.oid);
    const body=n===null?GIT_CO_RESET_COUNT_FAIL:GIT_CO_RESET_COUNT.replace('%n',String(n));
    await GitDialog.open({
      id:'git-reset',ns:'gco',action:'reset',
      title:GIT_CO_RESET_TITLE,runLabel:GIT_CO_RESET_RUN,body,
      fields:[{key:'mode',type:GIT_DIALOG_RADIO,cls:'gco-mode',
        label:GIT_CO_RESET_MODE_LABEL,
        opts:GIT_CO_RESET_MODES.map(m=>({v:m,label:GIT_CO_RESET_MODE_LABELS[m]||m}))}],
      // 다이얼로그는 값만 받는다. `--hard` 의 2단계 확인은 그것의 전문가에게
      // 넘긴다 (FR-GIT-172) — 확인 로직이 두 벌이면 한쪽이 조용히 뒤처진다.
      run:v=>{GitCommitOps._reset(panel,c,v.mode||'');return {ok:true}},
    });
  }

  static _reset(panel,c,mode){
    const body={oid:c.oid,mode};
    if(mode!==GIT_CO_RESET_MODE_HARD)
      return GitCommitOps._send(panel,'/api/git/reset',body);
    // `reset_hard` 는 서버의 파괴적 목록에 있는 이름이다 — 단계 수를 여기서
    // 정하지 않는다 (FR-GIT-89·90).
    return GitDialog.confirm({
      action:GIT_ACT_RESET_HARD,title:GIT_CO_RESET_HARD_TITLE,
      targets:[GitCommitOps.label(c)],
      hint:{note:GIT_CO_RESET_HARD_NOTE,command:GitCommitOps._restoreCmd(panel)},
      run:()=>GitCommitOps._send(panel,'/api/git/reset',
        Object.assign({},body,{confirm:true})),
    });
  }

  // ── Drop (FR-GIT-266) ──

  // 2단계 확인과 recovery hint 는 `GIT_MENUS.commit` 의 `destructive:true` 가 이미
  // 거쳤다 — 여기서는 확인을 거쳤음을 함께 보낸다. 서버도 그것을 요구한다.
  static drop(panel,c){
    return GitCommitOps._send(panel,'/api/git/drop',{oid:c.oid,confirm:true});
  }

  // ── Compare with (FR-GIT-267) ──

  // 비교 기준은 패널이 들고 있다 — History 를 떠났다 돌아와도 남아야 하고,
  // 목록이 다시 그려져도 잊히지 않아야 한다.
  static mark(panel,c){
    panel.compareMark={oid:c.oid,label:GitCommitOps.label(c)};
    // 표시가 보이지 않으면 사용자는 자기가 무엇을 골랐는지 모른다.
    if(panel.noteCompareMark) panel.noteCompareMark(panel.compareMark.label);
  }

  /**
   * 두 리비전을 받아 Diff 탭을 연다.
   *
   * **한 자리로 두 길이 들어온다** — 표시해 둔 기준 커밋(History 에서 둘을 고르는
   * 길)이 `rev` 를 미리 채우고, `A..B`·`A...B` 를 직접 적는 길도 같은 필드다.
   * `...` 는 merge-base 를 왼쪽으로 잡으므로 `..` 와 뜻이 다르고, 그 해석은
   * 서버가 한다 (`/api/git/commit-range`).
   */
  static compare(panel,c){
    const mark=panel.compareMark||null;
    const cur=panel._diffTarget&&panel._diffTarget();
    const lines=[GIT_CO_COMPARE_THIS.replace('%s',GitCommitOps.label(c))];
    if(mark) lines.push(GIT_CO_COMPARE_MARKED.replace('%s',mark.label));
    return GitDialog.open({
      id:'git-compare',ns:'gco',action:'compare',
      title:GIT_CO_COMPARE_TITLE,runLabel:GIT_CO_COMPARE_RUN,focus:'rev',
      body:lines.join('\n'),
      fields:[
        {key:'rev',type:GIT_DIALOG_TEXT,cls:'gco-rev',
         placeholder:GIT_CO_COMPARE_REV_PH,value:(mark&&mark.oid)||''},
        {key:'path',type:GIT_DIALOG_TEXT,cls:'gco-path',
         placeholder:GIT_CO_COMPARE_PATH_PH,value:(cur&&cur.path)||''},
      ],
      validate:v=>{
        if(!(v.rev||'').trim()) return GIT_CO_WHY_NO_REV;
        if(!(v.path||'').trim()) return GIT_CO_WHY_NO_PATH;
        return '';
      },
      run:v=>GitCommitOps._compare(panel,c,(v.rev||'').trim(),(v.path||'').trim()),
    });
  }

  static async _compare(panel,c,rev,path){
    const r=GitCommitOps.parseRange(rev,c.oid);
    const q=new URLSearchParams({repo:panel.repo,from:r.from,to:r.to});
    if(r.symmetric) q.set('symmetric','1');
    let res=null,d=null;
    try{res=await fetch('/api/git/commit-range?'+q.toString())}catch{res=null}
    if(res&&res.ok){try{d=await res.json()}catch{d=null}}
    if(!d||!d.from||!d.to) return {ok:false,reason:GIT_CO_COMPARE_FAIL};
    // 이미 있는 축이다 (FR-GIT-138) — 새 조회도 새 축도 만들지 않는다.
    panel.showCommitDiff({repo:panel.repo,axis:GIT_AXIS.COMMIT,
      path,origPath:'',oid:d.to,parentOid:d.from});
    return {ok:true};
  }

  /**
   * 입력을 (왼쪽, 오른쪽) 으로 가른다. 범위 표현이 없으면 적은 리비전이 왼쪽이고
   * 우클릭한 커밋이 오른쪽이다 — 커밋을 고른 자리가 비교의 **대상**이다.
   *
   * `...` 를 먼저 본다. `..` 로 먼저 자르면 `A...B` 가 `A` 와 `.B` 로 갈린다.
   */
  static parseRange(rev,oid){
    const i3=rev.indexOf(GIT_CO_RANGE_SYM);
    if(i3>=0)
      return {from:rev.slice(0,i3),to:rev.slice(i3+GIT_CO_RANGE_SYM.length),symmetric:true};
    const i2=rev.indexOf(GIT_CO_RANGE_TWO);
    if(i2>=0)
      return {from:rev.slice(0,i2),to:rev.slice(i2+GIT_CO_RANGE_TWO.length),symmetric:false};
    return {from:rev,to:oid,symmetric:false};
  }

  // ── 공통 ──

  // 확인 목록·다이얼로그에 보이는 커밋 하나의 이름. 해시만 보이면 무엇을
  // 고쳤는지 알 수 없고, 제목만 보이면 어느 커밋인지 알 수 없다.
  static label(c){
    const h=c.abbrev||(c.oid||'').slice(0,GIT_DIFF_REV_ABBREV);
    return c.subject?h+' '+c.subject:h;
  }

  // 부모가 둘 이상이면 머지 커밋이다. 목록이 이미 `parents` 를 주므로 여기서
  // 다시 묻지 않는다 — 서버도 실행 전에 같은 것을 확인한다 (FR-GIT-250.3).
  static _merge(c){return ((c&&c.parents)||[]).length>1}

  /**
   * HEAD 커밋 자신을 대상으로 하면 뜻이 없다 — cherry-pick 은 빈 커밋이 되고
   * reset 은 제자리다. **막되 사유를 보인다** (FR-GIT-180): 왜 못 누르는지
   * 보이지 않으면 사용자는 고장으로 읽는다.
   */
  static whyHead(c){
    const p=gitMenuPanel();
    const oid=((p&&p.statusOf&&p.statusOf())||{}).oid||'';
    return oid&&c&&c.oid===oid?GIT_CO_WHY_IS_HEAD:'';
  }

  /**
   * `git rebase --onto <oid>^ <oid>` 가 성립하지 않는 두 경우다 (FR-GIT-266):
   * 첫 커밋은 `^` 가 가리킬 것이 없고, 머지 커밋은 첫 부모만 남아 나머지 갈래가
   * 조용히 사라진다. 서버도 실행 전에 같은 것을 거부한다.
   */
  static whyDrop(c){
    const n=((c&&c.parents)||[]).length;
    if(n===0) return GIT_CO_WHY_ROOT;
    if(n>1) return GIT_CO_WHY_MERGE_DROP;
    return '';
  }

  static _mainlineField(c){
    const ps=(c&&c.parents)||[];
    return {key:'mainline',type:GIT_DIALOG_RADIO,cls:'gco-mainline',
      label:GIT_CO_MAINLINE_LABEL,
      opts:ps.map((p,i)=>({v:String(i+1),
        label:GIT_CO_MAINLINE_OPT.replace('%n',String(i+1))
          .replace('%s',String(p).slice(0,GIT_DIFF_REV_ABBREV))}))};
  }

  static _mainline(v){
    const n=parseInt(v&&v.mainline,10);
    return n>0?n:0;
  }

  /**
   * `<oid>..HEAD` 의 커밋 수 (FR-GIT-265 의 G11). 세지 못하면 **null** 이다 —
   * 0 으로 답하면 "아무 일도 없다" 로 읽히고, 그것은 사실이 아니다.
   */
  static async _count(panel,oid){
    const q=new URLSearchParams({repo:panel.repo,from:oid,to:'HEAD'});
    let r=null,d=null;
    try{r=await fetch('/api/git/commit-range?'+q.toString())}catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    return d&&typeof d.count==='number'?d.count:null;
  }

  // 되돌아갈 자리는 **옮기기 전** HEAD 다 (FR-GIT-250.2). 모르면 명령을 지어내지
  // 않는다 — 다른 곳으로 가는 명령을 되살리기용으로 내미는 것이 더 나쁘다.
  static _restoreCmd(panel){
    const oid=((panel.statusOf&&panel.statusOf())||{}).oid||'';
    return oid?'git -C '+gitShQuote(panel.repo||'')+' reset --hard '+oid:'';
  }

  /**
   * 쓰기 하나를 보내고 뒷정리한다.
   *
   * **실패도 status 를 싣고 온다** — 충돌로 멈춘 cherry-pick 은 실패 코드로
   * 오지만 저장소에는 진행 중 상태가 남는다 (FR-GIT-251). 그것을 화면에 반영해야
   * Changes 탭의 출구가 보인다.
   */
  static async _send(panel,url,body){
    const res=await panel.post(url,Object.assign({repo:panel.repo},body));
    panel.afterCommitOp(res);
    if(res.ok) return {ok:true};
    return {ok:false,reason:panel.writeReason(res),
      stderrTail:(res.data&&res.data.message)||''};
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitCommitOps=GitCommitOps;
