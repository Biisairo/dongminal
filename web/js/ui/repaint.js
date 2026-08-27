/**
 * Dongminal — 바깥 계기의 다시 그리기 규약 (GIT_REVIEW4_SRS §3.2 / FR-RPT-1~7)
 *
 * 목록을 `innerHTML=''` 로 비우고 다시 만드는 것은 **사용자가 부른 다시 그리기에서만**
 * 옳다. 폴링·서버 푸시처럼 사용자가 만들지 않은 계기에서는 값으로 되살릴 수 없는
 * 것이 함께 사라진다: `:hover`, 진행 중인 transition, 더블클릭의 첫 클릭, native
 * 드래그 세션, 글자 선택, 표시 중인 `title` 툴팁.
 *
 * 그 방어를 목록마다 손으로 쓰지 않고 여기 둔다 (FR-RPT-6) — 이 저장소는 같은
 * 함정을 네 곳에서 네 번 다르게 막았고, 여섯 곳이 빠져 있었다.
 *
 * 두 가지를 준다.
 *
 *   paintIfChanged  그릴 내용이 지금 그려진 것과 같으면 그리지 않는다 (FR-RPT-1)
 *   reconcileList   내용이 바뀐 회차에도 바뀌지 않은 항목의 요소를 유지한다 (FR-RPT-3)
 *
 * 둘 다 **판정 근거를 문자열로 받는다.** 근거는 그 렌더러가 읽는 값 전부여야 한다
 * (FR-RPT-2) — 좁히면 갱신이 조용히 멈춘다. 요소 상태는 값이 아니므로 근거가 아니다.
 */

// 근거를 담는 자리. dataset 을 쓰면 DOM 검사로 보이고, 요소가 버려질 때 함께 사라진다.
const RPT_SIG='psig';
const RPT_KEY='rkey';
const RPT_ROW_SIG='rsig';

/**
 * FR-RPT-1·2: sig 가 지난 회차와 같으면 draw 를 부르지 않는다.
 *
 * draw 가 던지면 근거를 남기지 않는다 — 반쯤 그린 화면을 "그린 것"으로 기록하면
 * 다음 회차가 그것을 고치지 못한다.
 *
 * 첫 그리기(근거 없음)는 언제나 그린다. 반환값은 그렸는지 여부다.
 */
function paintIfChanged(el,sig,draw){
  if(!el) return false;
  const s=String(sig);
  if(el.dataset[RPT_SIG]===s) return false;
  draw();
  el.dataset[RPT_SIG]=s;
  return true;
}

// 근거를 버려 다음 회차가 반드시 그리게 한다. 값 밖의 이유로 화면이 바뀌었을 때
// (테마 전환·리포 교체 등) 쓴다.
function forgetPaint(el){ if(el) delete el.dataset[RPT_SIG] }

/**
 * FR-RPT-3·4: container 의 자식을 items 에 맞춘다.
 *
 *   o.key(item)   항목의 동일성. 목록 안에서 유일해야 한다
 *   o.sig(item)   항목의 **보이는 값 전부**. 다르면 요소를 다시 만든다
 *   o.build(item) 요소를 만든다. null 을 주면 그 항목을 건너뛴다
 *
 * - 키가 같고 값도 같으면 **같은 요소를 그대로 둔다** — 그것이 이 함수의 목적이다.
 * - 순서가 바뀌면 요소를 **옮긴다**. 지우고 다시 만들지 않는다.
 * - 사라진 항목의 요소는 제거한다.
 *
 * 규약을 지키지 않는(키가 없는) 자식은 제거한다 — 옛 방식으로 그려 둔 것과 섞이면
 * 순서가 어긋난다.
 */
function reconcileList(container,items,o){
  if(!container) return 0;
  const old=new Map();
  for(const el of Array.from(container.children)){
    const k=el.dataset[RPT_KEY];
    // 같은 키가 두 번 나오면 앞의 것을 버린다 — 남기면 아무도 지우지 않는다.
    if(k===undefined||old.has(k)){container.removeChild(el);continue}
    old.set(k,el);
  }
  let n=0;
  for(const item of items){
    const k=String(o.key(item)),s=String(o.sig(item));
    let el=old.get(k);
    if(el){
      old.delete(k);
      if(el.dataset[RPT_ROW_SIG]!==s){container.removeChild(el);el=null}
    }
    if(!el){
      el=o.build(item);
      if(!el) continue;
      el.dataset[RPT_KEY]=k; el.dataset[RPT_ROW_SIG]=s;
    }
    // 처리한 항목은 앞쪽 n개를 차지한다. 이미 그 자리에 있으면 손대지 않는다 —
    // insertBefore 는 같은 자리라도 요소를 떼었다 붙이므로 드래그를 깨뜨린다.
    const at=container.children[n];
    if(at!==el) container.insertBefore(el,at||null);
    n++;
  }
  for(const el of old.values()) container.removeChild(el);
  return n;
}

// 고전 스크립트의 const 선언은 window 의 속성이 되지 않는다 — e2e 가 창 밖에서
// 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.paintIfChanged=paintIfChanged;
window.forgetPaint=forgetPaint;
window.reconcileList=reconcileList;
