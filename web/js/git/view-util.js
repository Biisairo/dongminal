/**
 * Git 뷰들이 공유하는 조각 (REFACTOR_STABILIZATION_SRS FR-RST-21).
 *
 * `Worktrees`·`Submodules`·`Stash` 는 서로 다른 것을 보이지만 **받아 오는 방식과
 * 사유를 알리는 방식은 같다.** 실제로 `_load` 는 worktrees 와 submodules 가 주석까지
 * 바이트 동일했고 다른 것은 세 토큰(종단·에러 문구·응답 키)뿐이었으며, `_paintNote`
 * 는 세 뷰가 CSS 접두어만 달랐다.
 *
 * 두 벌로 두면 한쪽만 고쳐진다 — `gitEchoOk` 가 아는 함정(서버가 정규화한 `d.repo`
 * 로 비교하면 목록이 영원히 실패로 남는다)을 세 곳이 각자 기억해야 했다.
 *
 * 로드 순서: `api.js` 보다 **앞**이다 (gitFetch 는 호출 시점에만 필요하다).
 */

/**
 * 목록 하나를 받아 뷰에 얹는다.
 *
 * stale 가드는 **보낸 값의 echo** 로 짝을 맞춘다 (FR-GIT-16). `d.repo` 는 서버가
 * 정규화한 루트라 보낸 값과 다를 수 있고, 그것으로 비교하면 목록이 영원히 실패로
 * 남는다 — `gitEchoOk` 가 그 함정을 안다.
 *
 * 응답 짝은 뷰의 표(`GitView.ticket('load')`)가 본다 (REFACTOR3_FE_GITVIEW_SRS FR-FEV-7).
 * 새 조회는 앞선 조회를 끊는다 (FR-GRF-31) — 버려질 값을 위해 큰 저장소에서 git 을
 * 끝까지 돌리지 않는다. 끊긴 요청은 새 요청이 `_loading=true` 를 세운 **뒤에** 깨어나므로,
 * 밀린 응답(`superseded`)은 잠금을 건드리지 않는다.
 *
 * @param view  `GitView` 하위 — `_repo`·`_loading`·`_err`·`_list`·`el`
 * @param spec  {url, key, failMsg} — 종단, 응답에서 배열을 꺼낼 키, 실패 문구
 */
async function gitLoadList(view, spec){
  const repo=view._repo; if(!repo) return;
  const tk=view.ticket('load');
  view._loading=true;
  const res=await gitFetch(spec.url,{repo},
    {stale:()=>view.stale(tk),echo:{repo},signal:tk.signal});
  if(view.superseded(tk)) return;
  // FR-GRF-24: 낡은 응답은 **그 값을 쓰지 않는 것**이지 잠금을 영원히 쥐는 것이
  // 아니다. 종전에는 여기서 `_loading=true` 인 채로 빠져나갔다.
  view._loading=false;
  if(res.stale) return;
  if(!res.ok){
    view._err=spec.failMsg;
    if(view.el) view.paint();
    return;
  }
  const d=res.data;
  view._err=null;
  view._list=Array.isArray(d[spec.key])?d[spec.key]:[];
  if(view.el) view.paint();
}

/**
 * 뷰 머리의 사유 상자를 칠한다.
 *
 * `prefix` 는 그 뷰의 CSS 접두어다 (`git-stash`·`git-wt`·`git-sub`). 클래스 이름을
 * 조립하는 것이 세 곳에 흩어져 있던 유일한 차이였다.
 */
function gitPaintNote(el, prefix, note){
  const box=el&&el.querySelector('.'+prefix+'-note');
  if(!box) return;
  box.classList.toggle('vis',!!note);
  box.dataset.kind=(note&&note.kind)||'';
  const msg=box.querySelector('.'+prefix+'-note-msg');
  if(msg) msg.textContent=(note&&note.msg)||'';
}

// ── diff 의 조각 (REFACTOR3_FE_REST5_SRS FR-FR5-21: `diff-view.js` 머리에서 옮겼다 — 여러 뷰가 부른다) ──

/**
 * recovery hint 의 명령에 넣을 경로를 감싼다 (FR-GIT-92). 저장소에는 공백·따옴표·
 * 한글이 든 경로가 있고, 사용자가 그 명령을 **붙여 그대로 실행**하므로 셸이 읽는
 * 형태여야 한다.
 */
/**
 * `gitHunkSpan` 이 여기 있었다 (FR-GIT-278) — 조각 머리의 텍스트 한 조각을 만드는
 * 함수였다. 하단 조각 목록이 폐기되면서(DIFF_HUNK_BAR_SRS FR-DHB-2) 부르는 자리가
 * 없어졌다.
 *
 * **그 함수가 지킨 규약은 남는다**: 사용자의 파일 내용이 닿는 자리는 언제나
 * `textContent` 다 (NFR-DHB-3). 새 코드에서 그 자리는 Diff 탭 머리의 안내
 * 한 줄(`_hunkNote`)과 revert 확인 대화의 대상 라벨이다.
 */

function gitShQuote(p){
  const s=String(p==null?'':p);
  if(/^[A-Za-z0-9._\/@=+:,-]+$/.test(s)) return s;
  return "'"+s.replace(/'/g,"'\\''")+"'";
}

/**
 * 바이트 수를 사람이 읽는 한 조각으로 만든다. 나누는 단위는 상태바·전송량 표시와
 * 같은 1024 계열이다 — 같은 화면 안에서 두 계산법이 섞이면 값이 어긋나 보인다.
 */
function gitFmtBytes(n){
  const b=Number(n)||0;
  if(b<1024) return b+' B';
  if(b<1048576) return (b/1024).toFixed(1)+' KB';
  if(b<1073741824) return (b/1048576).toFixed(1)+' MB';
  return (b/1073741824).toFixed(1)+' GB';
}

/**
 * 본문을 그리지 못하는 쪽의 메타 한 줄 (FR-GIT-46·47·48).
 *
 * LFS 포인터는 **가리키는 객체**의 oid·크기다 — 포인터 파일 자신의 134 B 는
 * 사용자가 묻는 것이 아니다. 서버가 싣지 않은 값은 만들지 않는다.
 */
function gitBlobMeta(side){
  const s=side||{};
  if(s.kind===GIT_LFS_KIND){
    const oid=s.lfsOid?GIT_LFS_OID_PREFIX+s.lfsOid.slice(0,GIT_LFS_OID_ABBREV)+'…':'';
    const size=s.lfsSize?gitFmtBytes(s.lfsSize):'';
    return [oid,size].filter(Boolean).join(GIT_META_SEP);
  }
  if(GIT_META_SIZED.has(s.kind)) return s.size?gitFmtBytes(s.size):'';
  if(s.kind===GIT_SUBMODULE_KIND) return s.oid?s.oid.slice(0,GIT_COMMIT_ABBREV):'';
  return '';
}

/**
 * 양쪽 메타를 안내 아래 줄들로 만든다. 같으면 한 줄이다 — 같은 값을 두 번 보이면
 * 사용자는 두 쪽이 다르다고 읽는다.
 */
function gitBlobMetaLines(orig,mod){
  const a=gitBlobMeta(orig),b=gitBlobMeta(mod);
  if(a&&b&&a!==b){
    return [GIT_META_SIDE.orig+GIT_META_LABEL_SEP+a,GIT_META_SIDE.mod+GIT_META_LABEL_SEP+b];
  }
  return [a||b].filter(Boolean);
}
