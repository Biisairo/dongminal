/**
 * GitWatchdog — 멈춘 관측을 되살리는 워치독 (UX_BATCH9_SRS FR-GLR · GIT_OBSERVE_REVIVE_SRS). 옛 자리는 `git-poll.js` 의
 * `_watchdog` 다 (REFACTOR3_FE_REST5_SRS FR-FR5-21). 부르는 쪽은 `panel.watchdog.run()` 이다. 주기 계산과 다시 걸기는
 * 종전대로 폴링 부품(`this.p.poll`)의 `_cadence`·`_applyCadence` 다.
 */
class GitWatchdog extends GitPart {
  /**
   * UX_BATCH9_SRS FR-GLR-1~4: **멈춰 있으면 스스로 되살아난다.**
   *
   * 종전의 자동 갱신은 두 경로처럼 보였으나 하나였다 (SRS §2.3): 주기 폴링이
   * 멎으면 `/api/git/status` 가 나가지 않고, 그 요청이 곧 서버의 관심 표명이므로
   * 90초 뒤에는 `git_changed` 방송까지 함께 멎는다. 그리고 폴링은 조건이 거짓이면
   * **완전히 멈추며**(`_applyCadence` → `_stop`), 되살아나는 계기는 밖에서 알려
   * 주는 것뿐이다 — 그 계기가 하나라도 새면 그 패널의 자동 갱신은 영구히 죽고,
   * 죽었다는 것을 아무도 알지 못한다. 접수된 증상이 그것이다: 보고 있는데도
   * 바뀌지 않고, 새로고침을 누를 때까지 영영 그대로.
   *
   * 새는 계기를 하나 더 메우는 대신 **조용한 정지를 없앤다** (D-2).
   *
   * 판정은 시각이 아니라 **관측의 나이**다 (D-3) — 타이머의 유무로는 "타이머는
   * 살아 있는데 답이 오지 않는" 모양을 놓친다.
   *
   * 되살릴 때 두 가드를 푼다 (FR-GLR-4). 멈춰 있던 동안의 변화가 "지난번과 같다"
   * 로 판정되면 화면은 낡은 채 남고, 그러면 되살린 뜻이 없다.
   *
   * 요청은 **멈춰 있을 때만** 는다 (FR-GLR-7). 정상 회차에서는 나이가 주기보다
   * 어리므로 이 함수는 산술 몇 번으로 끝난다.
   *
   * GIT_OBSERVE_REVIVE_SRS: "멈춰 있다" 에는 **타이머가 도는데 답이 오지 않는**
   * 것도 든다 (D-3 이 처음부터 그렇게 적었다). 그 회차에서도 수집까지 간다
   * (FR-GOR-1) — 종전에는 경고만 찍었다. 대신 물어보는 일에 주기를 걸어 요청은
   * 멎어 있는 관측기당 주기마다 한 번을 넘지 않는다 (FR-GOR-2).
   */
  run(){
    // FR-GLR-3: 되살리기도 같은 판정을 먼저 지난다 — 아무도 보지 않는 저장소를
    // 깨우지 않는다.
    if(!this.p.poll._pollOk()) return false;
    // REPO_FIX 05 F-6.2: 확정된 "저장소가 아니다" 는 폴링을 멈춘 상태다(FR-DSP-1a). 워치독이
    // 그것을 "멎은 관측" 으로 읽어 되살리면 그 판정이 무의미해진다 — 해제는 git init 성공·
    // 루트 변경·손으로 부른 관측(포커스·새로고침)뿐이다.
    if(this.p._notRepo) return false;
    const st=this.p.poll._cadence(gitStatusInterval);
    /**
     * GIT_REFRESH_LIFECYCLE_SRS FR-GRF-1·2 (`GP-2`): 주기 0 에서 **첫 관측은
     * 한다.**
     *
     *   이전 동작: `if(st<=0) return false` — 워치독이 통째로 물러났다
     *   새  동작: 한 번도 관측이 없으면(`_lastObsAt===null`) 주기와 무관하게
     *            1회 수집한다. **타이머는 여전히 걸지 않는다**
     *   이유:     주기 0 은 "요청을 주기적으로 내지 않는다" 이지 "한 번도
     *            관측하지 않는다" 가 아니다. `_applyCadence` 가
     *            `_pollOn=true, _pollSt=0` 에서 늘 거짓을 돌려주므로
     *            (`:301`) 그 뒤의 모든 `_reschedule()` 이 수집을 걸렀고,
     *            남는 계기는 포커스·새로고침뿐이었다 — status **0건**.
     *            e2e `git-polling` P4 의 확정 원인이다
     */
    const never=!this.p._lastObsAt;
    if(st<=0&&!never) return false;
    const age=never?Infinity:Date.now()-this.p._lastObsAt;
    if(st>0&&this.p._pollOn&&age<st*GIT_WATCHDOG_FACTOR) return false;
    /**
     * GIT_OBSERVE_REVIVE_SRS FR-GOR-2: **물어보는 일에만 주기를 건다.**
     *
     * 아래가 수집까지 가게 된 이상(FR-GOR-1) 이 자리는 요청원이다. 답이 오지
     * 않는 동안 나이는 줄지 않으므로, 문턱이 없으면 렌더마다(1초) 한 건씩 나간다
     * (R-B9-1). 정상 회차는 위 나이 판정에서 이미 돌아갔으므로 이 문턱이 여는
     * 것은 **멎어 있는 관측기당 주기마다 한 번**뿐이다 (NFR-GOR-1).
     *
     * **주기를 다시 거는 일은 이 문턱 밖이다** — 그것은 요청이 아니고, 함께 묶으면
     * 직전에 한 번 물어본 탓에 꺼진 타이머가 한 주기를 더 꺼진 채로 남는다.
     */
    // FR-GRF-3: 주기 0 에는 문턱의 간격을 기본 status 주기로 잡는다 — 0 을
    // 그대로 쓰면 워치독 회차(1초)마다 한 건이 나간다.
    const gap=st>0?st:GIT_STATUS_POLL_MS;
    const ask=!this.p._wdTryAt||Date.now()-this.p._wdTryAt>=gap;
    if(!ask&&this.p._pollOn) return false;   // 걸 것도 물을 것도 없다
    // FR-GLR-6 (FR-GOR-7): 관측기는 **루트마다** 서므로 `repo` 만으로는 어느
    // 표면이 멎었는지 특정되지 않는다 — 같은 문자열이 여럿이다 (SRS §2.4).
    console.warn('[git] 관측이 멈춰 있어 되살립니다 — age='+(age===Infinity?'never':Math.round(age/MS_PER_SEC)+'s')
      +' poll='+(this.p._pollOn?'on':'off')+' repo='+this.p.repo+' root='+(this.p.root||'-'));
    this.p._obsSig=null; this.p._lastViewFp=null;                    // FR-GLR-4
    /**
     * FR-GOR-1: **주기를 다시 걸고, 그 자리에서 한 번 수집한다.**
     *
     *   이전 동작: `_reschedule()` — 수집은 `_applyCadence()` 가 참을 돌려줄
     *             때만 따라왔다. 폴링이 이미 켜져 있고 주기가 그대로면 그 값은
     *             거짓이므로(`:293`) **경고만 찍고 물러났다**
     *   새  동작: 두 일을 따로 부른다
     *   이유:     `_applyCadence` 의 반환값이 답하는 것은 "주기를 다시 걸었는가"
     *             이고 워치독이 묻는 것은 "관측이 낡았는가" 다. 둘을 묶어 둔 탓에
     *             `D-3` 이 이 장치의 존재 이유로 든 상태 — 타이머는 살아 있는데
     *             응답이 오지 않는 모양 — 에서 아무 일도 하지 않았다 (SRS §2.1).
     *             적재 직후 5.4초 동안 관측이 없던 자리가 그것이다 (§2.2 실측)
     *
     * `_reschedule()` 은 건드리지 않는다 — 그쪽은 "조건이 참이 된 순간" 의 규약
     * 이며(FR-GIT-22) 부르는 자리가 여럿이다.
     */
    this.p.poll._applyCadence();
    if(ask){ this.p._wdTryAt=Date.now(); this.p.poll.collect() }
    return true;
  }
}
