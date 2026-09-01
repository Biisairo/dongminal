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
    this._busy=false; this._again=false; this._sigBusy=false; this._sigT=null;
    this._pollOn=false; this._pollSig=null; this._pollSt=null;
    this._sigPoll=null; this._stPoll=null;
    this._inited=false;           // 문서 이벤트 등록은 앱당 한 번이다
  }

  attach(p){ this.panels.add(p) }
  detach(p){ this.panels.delete(p) }

  // 살아 있는 패널 하나. 주기 타이머가 딛는 자리다 — 콜백이 특정 패널을 캡처하면
  // 그 칸이 사라진 뒤에도 죽은 패널을 붙들고 부른다.
  any(){ for(const p of this.panels) return p; return null }

  // FR-SVS-32: 관측이 갱신되면 살아 있는 **모든** 패널이 칠한다.
  paintAll(){ for(const p of this.panels) p._paint() }
  paintAllViews(){ for(const p of this.panels) p._paintAllViews() }
  reloadViewsAll(){ for(const p of this.panels) p._reloadViews() }
  notifyStatusAll(){ for(const p of this.panels) if(p._remoteView) p._remoteView.notifyStatus() }

  // 주기 타이머의 종단. 패널이 하나도 없으면 폴 이유가 없다.
  tick(kind){
    const p=this.any();
    if(!p){ this.stopPolling(); return }
    if(kind==='sig') p._pollSignature(); else p.collect();
  }
  stopPolling(){
    if(this._sigPoll){clearInterval(this._sigPoll);this._sigPoll=null}
    if(this._stPoll){clearInterval(this._stPoll);this._stPoll=null}
    this._pollOn=false;
  }
}

