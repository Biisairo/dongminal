/**
 * Remote Terminal — 작은 공용 도구 (HTML 이스케이프·오류 문구·상태줄·Run 짧은 id·가시 폴링)
 *
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-6 (FEC-24): 주제가 열하나로 불어 갈랐다 — 경로(path.js)·테마
 * 변수(theme-vars.js)·단축키(shortcuts.js)·설정 상태(settings-state.js)·레이아웃 트리와 탭 이름
 * (layout-tree.js)·git 상태(git-status-helpers.js). 여기에는 어느 주제에도 속하지 않는 것만 남는다.
 */

// ── HTML escaping ──

// escHtml 은 문자열을 HTML 에 넣기 전에 무해하게 만든다 (FR-CAF-17).
//
// **한 벌인 것이 요점이다.** 종전에는 두 벌이 따로 있었고(file-editor 의 `_esc`,
// app-edsearch 의 지역 `esc`), 이미 조용히 갈라져 있었다 — 한쪽은 홑따옴표를
// 막고 다른 쪽은 막지 않았다. 이스케이프가 갈라지는 것은 그 자체로 결함이다:
// 어느 자리가 무엇을 막는지 말할 수 없게 된다.
//
// 홑따옴표까지 막는 쪽으로 통일한다. 값이 `alt="..."` 같은 속성에 들어가는
// 자리가 실재하고(file-editor 의 이미지 뷰어), 속성 따옴표는 어느 쪽이든 될 수
// 있다.
function escHtml(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// FR-OPT-11-5 (FEC-28): 오류 문구는 앞말 + ' — ' + 사유다. 사유가 Error 면 그 message 다.
function errText(prefix,err){ return prefix+' — '+((err&&err.message)||err) }

/**
 * FR-OPT-11-5 (FEC-28): 상태줄의 '진행 중 → 됐음 | 오류' 한 벌.
 *
 * `fn` 은 API 봉투를 돌려준다 — 봉투를 여는 일(목록 채우기·다시 읽기)은 `fn` 안에서
 * 한다. 봉투가 실패면 `apiErrText(r, fail)` 을 적고 `err` 를 단다. 성공이면 `ok` 를
 * 적는다(주지 않으면 그대로 둔다). 봉투는 망 실패에도 던지지 않으므로 여기서 잡는
 * 예외는 `fn` 안의 결함뿐이다 — 그것도 상태줄에 사유를 남긴다 (자리마다 적던 catch 를
 * 한 자리로 모은 것이다).
 */
async function statusRun(el,msgs,fn){
  el.classList.remove('err');
  el.textContent=msgs.pending||'';
  let r=null, err=null;
  try{ r=await fn() }catch(e){ err=e }
  const bad=err?errText(msgs.fail,err):(!r||!r.ok)?apiErrText(r,msgs.fail):null;
  if(bad){ el.textContent=bad; el.classList.add('err'); return false }
  if(msgs.ok!=null) el.textContent=msgs.ok;
  return true;
}

// FR-OPT-11-7 (FEC-31): Run 의 짧은 id (FR-RVZ-8).
function runShortId(id){ return String(id).slice(0,RUN_SHORT_ID_LEN) }

/**
 * 화면이 보일 때만 도는 주기 실행 (REFACTOR_STABILIZATION_SRS FR-RST-23).
 *
 * 같은 일을 하는 `setInterval` 감싸기가 다섯 자리에 있었고 **정확도가 제각각이었다**:
 *
 *   app-statusbar  hidden 스킵 O · 복귀 시 갱신 O
 *   app-git        hidden 스킵 O · 복귀 시 갱신 O   (주석이 statusbar 를 선례로 인정)
 *   app-editor     hidden 스킵 O · 복귀 시 갱신 X
 *   git/console    hidden + isConnected + vis       · 복귀 시 갱신 X
 *   app-agents     **아무 방어 없음**
 *
 * `console.js` 가 가장 정확한 판정에 도달했다 — "`vis` 만 보면 떠난 탭에서도 계속
 * 받는다. 탭을 바꾸면 `_rLayout` 이 본문을 통째로 버리는데 클래스는 그대로 남기
 * 때문이다." 그 지식이 나머지 넷에 전파되지 않았다. 여기서 `when` 으로 받는다.
 *
 * 숨은 탭에서 멈추는 근거는 FR-STAT-17 이다 — 보이지 않는 화면을 위해 요청을 살
 * 이유가 없다. 복귀하면 즉시 한 번 돈다: 멈춰 있던 동안의 낡음을 그때 갚는다.
 *
 * @returns {{stop:Function}} 정지 손잡이. 리스너까지 함께 걷는다.
 */
function visiblePoll(ms, fn, opts){
  opts=opts||{};
  // POLL_INTERVAL_SETTINGS_SRS FR-PIS-13 / D-8: 첫 인자가 **함수면 그대로 넘긴다.**
  // `TimerHub` 는 `every` 를 매 재무장마다 재평가하므로(`_arm`), 그것이 곧 "주기가
  // 설정을 읽는다" 이다. 값을 주는 기존 호출 방식은 그대로 동작한다 — 계약이
  // 넓어질 뿐 깨지지 않는다.
  // EVENT_TIMER_HUB_SRS FR-HUB-6: **이 함수는 이제 `TimerHub` 위의 얇은
  // 래퍼다.** 호출부 다섯은 한 글자도 바뀌지 않는다.
  //
  // 위 주석이 적어 둔 다섯 축 중 이 함수가 흡수한 것은 visibility 하나였다.
  // 나머지 넷(낡은 응답 폐기·single-flight·백오프·시한)은 `TimerHub` 가 갖는다 —
  // `every` 로 등록하면 그것들이 함께 온다.
  //
  // `sched` 를 주입받는 이유는 격리 검사 때문이다. 앱 없이 이 함수만 얹고
  // 계약을 재는 자리가 있고(`event-timer-hub-contract.spec.ts`), 거기에는
  // `window.app` 이 없다.
  const sched=opts.sched||(typeof window!=='undefined'&&window.app&&window.app.timers);
  return sched.every({
    id:opts.id, owner:opts.owner||null,
    every:typeof ms==='function'?ms:()=>ms,
    when:opts.when||(()=>true),
    run:fn,
    immediate:!!opts.immediate,
  });
}
