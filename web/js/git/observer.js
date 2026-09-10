// @ts-check
/**
 * Git 의 **관측** — SLOT_VIEW_STATE_SRS 묶음 O (FR-SVS-30~35).
 *
 * `git status` 와 그 파생(소실·실패 누적·signature)은 **누가 보든 같은 사실**이므로
 * 앱에 하나다. 칸이 넷이어도 요청은 한 벌만 나간다 (FR-SVS-31) — single-flight
 * (`_busy`)와 주기 타이머가 여기 살기 때문이다.
 *
 * 선택·접힘·미리보기 같은 **조작 상태는 들어오지 않는다.** 그것은 보는 자리의
 * 것이고 칸마다 다르다 (FR-SVS-43). 그래서 `GitPanel` 이 칸마다 서고, 그 안의
 * 하위 뷰 모듈 일곱은 한 줄도 바뀌지 않는다 (D-3).
 *
 * 뷰를 **모른 채** 갱신을 알린다 (D-4) — `paintAll` 은 "다시 칠하라" 만 말하고,
 * 무엇을 그릴지는 각 패널이 자기 시선으로 정한다.
 *
 * panel.js 에서 갈라져 나왔다 (SPLIT_REFACTOR_SRS 묶음 B) — 앱에 하나인 것과 칸마다
 * 하나인 것이 같은 파일에 있으면 그 둘의 차이가 읽히지 않는다.
 */
class GitObserver {
  constructor(app){
    this.app=app;
    this.panels=new Set();

    this._gen=0;
    this._status=null;   // /api/git/status 의 마지막 유효 응답
    // UX_BATCH9_SRS FR-GLR-2·5: **마지막으로 성공한 관측의 시각.**
    //
    // "타이머가 걸려 있는가" 로는 멈춤을 알 수 없다 — 타이머는 살아 있는데 응답이
    // 오지 않는 모양이 실재하고(FR-RMS-29 가 그것을 고쳤다), 반대로 타이머가
    // 조용히 걷힌 뒤 아무도 다시 걸어 주지 않는 모양도 있다 (SRS §2.4). 사용자가
    // 겪는 것은 둘 다 "화면이 낡았다" 이고, 그 값이 바로 이것이다.
    this._lastObsAt=0;
    this._lastSig=null;  // FR-GIT-19 의 비교 대상
    this._lastViewFp=null; // FR-GVR-8 의 비교 대상 (Changes 밖의 뷰)
    this._errMsg=null;
    this._staleNote=false;
    this._refreshing=false;       // FR-GIT-238 의 새로고침이 도는 중
    this._gitMissing=false;
    this._seq=0;                  // status 요청 일련번호 (single-flight 소유권)
    this._missing=null;           // 소실 상태의 저장소 경로 (FR-RMS-6)
    this._failStreak=0;           // 연속 실패 수. 주기 백오프의 근거 (FR-RMS-22)
    this._obsSig=null;            // FR-GIT-227: 마지막으로 그린 관측
    // FR-SVS-45: 쓰기 한 번은 한 번이다. 칸마다 두면 두 칸이 같은 쓰기를 함께 보낸다.
    this._writing=false;
    // single-flight 와 주기. 칸이 늘어도 이것들이 하나이므로 요청이 늘지 않는다.
    // `_sigT` 는 즉시 신호의 150ms 합치기 창이다 — 지워진 signature 폴링과
    // 이름만 비슷하고 성질이 다르다 (FR-PIS-3).
    this._busy=false; this._again=false; this._sigT=null;
    this._pollOn=false; this._pollSt=null; this._stPoll=null;
    // GIT_OBSERVE_REVIVE_SRS FR-GOR-2 / D-2: 워치독이 **되살리기를 시도한** 시각.
    //
    // `_lastObsAt` 으로 절제할 수 없다 — 그것은 **성공한** 관측의 것이라 실패가
    // 이어지면 영영 낡은 채이고, 그 값으로 문턱을 세우면 렌더마다 요청이 나간다.
    // 시도는 시도대로 세어야 절제가 절제가 된다.
    this._wdTryAt=0;
  }

  attach(p){ this.panels.add(p) }
  detach(p){ this.panels.delete(p) }

  // 살아 있는 패널 하나. 주기 타이머가 딛는 자리다 — 콜백이 특정 패널을 캡처하면
  // 그 칸이 사라진 뒤에도 죽은 패널을 붙들고 부른다.
  any(){ for(const p of this.panels) return p; return null }

  /**
   * GIT_OBSERVE_REVIVE_SRS FR-GOR-4·5 / D-3: **이 관측기가 폴링할 이유가 있는가.**
   *
   * 판정은 패널마다이지만(`_pollOk` 은 그 칸의 표면을 본다) 타이머는 관측기의
   * 것이다. 그 둘이 어긋나 있었다 — 패널 하나가 자기 판정으로 공유 타이머를 껐고,
   * 보이지 않는 칸이 **보이는 칸의 폴링까지** 멈췄다 (SRS §2.3, 실측). 전 패널을
   * 도는 자리(`_gitRescheduleAll`)에서는 마지막에 도는 패널이 이겼다.
   *
   * 소유와 판정을 같은 자리에 둔다: 딸린 패널 중 하나라도 보고 있으면 돈다.
   */
  pollOkAny(){ for(const p of this.panels) if(p._pollOk()) return true; return false }

  // FR-SVS-32: 관측이 갱신되면 살아 있는 **모든** 패널이 칠한다.
  paintAll(){ for(const p of this.panels) p._paint() }
  paintAllViews(){ for(const p of this.panels) p._paintAllViews() }
  reloadViewsAll(){ for(const p of this.panels) p._reloadViews() }
  reloadStaleViewsAll(sig){ for(const p of this.panels) p._reloadStaleViews(sig) }
  // UX_BATCH6_SRS FR-GLV-1: 열려 있는 Diff 는 **관측 회차마다** 다시 받는다.
  // `_viewFp` 에 업히지 않는 이유는 그 근거가 작업 트리의 **내용**을 보지 않기
  // 때문이다 (SRS §2.4) — 파일이 또 고쳐져도 fp 는 한 톨도 움직이지 않는다.
  reloadDiffAll(){ for(const p of this.panels) p.reloadDiff() }
  notifyStatusAll(){ for(const p of this.panels) if(p._remoteView) p._remoteView.notifyStatus() }

  // 주기 타이머의 종단. 패널이 하나도 없으면 폴 이유가 없다.
  // FR-PIS-1: 갈래가 사라졌다 — 걸리는 계층이 status 하나뿐이다.
  tick(){
    const p=this.any();
    if(!p){ this.stopPolling(); return }
    p.collect();
  }
  stopPolling(){
    if(this._stPoll){this._stPoll.stop();this._stPoll=null}
    this._pollOn=false;
  }

  /**
   * UX_BATCH6_SRS FR-GLV-4: 패널 하나가 물러난 뒤 **남은 패널로 주기를 다시
   * 세운다.**
   *
   *   이전 동작: `GitPanel.detach()` 의 `_stop()` 이 관측자의 공유 타이머를 껐고,
   *             다시 거는 자리가 없었다
   *   새  동작: 끈 뒤 이 함수를 지난다 — 조건이 참인 패널이 남아 있으면 그것으로
   *             주기를 다시 걸고 즉시 1회 수집한다
   *   이유:     타이머는 **관측자의 것**이고(`panel.js` 의 통로 접근자), 패널은
   *             칸마다 있다. 칸을 늘렸다 줄이면 초과 칸의 패널이 `destroy()` 되면서
   *             — 남은 칸의 Git 창이 눈앞에 있는데도 — 그 저장소의 폴링이 통째로
   *             멎었다 (SRS §2.5)
   *
   * 조건이 참인 패널이 하나도 없으면 아무것도 하지 않는다 (FR-GLV-5) — 멎어 있는
   * 것이 옳은 상태다.
   */
  resettle(){
    for(const p of this.panels){
      if(!p._pollOk()) continue;
      p._reschedule();
      return;
    }
  }
}

