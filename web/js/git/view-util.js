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
