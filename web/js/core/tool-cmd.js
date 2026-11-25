/**
 * Remote Terminal — App 원격 커맨드의 부팅 껍데기 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * 워크스페이스 동기화·SSE 배선은 `ws-sync-controller.js`(옛 `app-ws-sync.js`)로 갈랐다 (REFACTOR PROD2 §8).
 * `ToolController` 의 부품 `.cmd` 다(REFACTOR3_FE_APPCTL_SRS 9j, 옛 `app-cmd.js`).
 *
 * PERF 3.4.12.5 (perf/M3_BOOT_SCOPE.md §3 `remote`): 본체(`tool-cmd-remote.js`, `REMOTE_ACTIONS` 와 처리기)와
 * `open-url.js` 는 `remote` 묶음이다. 여기 남는 것은 첫 명령 때 그 묶음을 싣는 `_execRemote`, 계약(`app.testing`)이
 * 내놓는 `_echoResult`, 묶음 밖에서 부르는 작은 도우미(`layout-groups.js` 의 `_findTabById`)뿐이다.
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Screens.register('remote');

class ToolCmd extends Controller {
  // REMOTE_COMMAND_RESULT_SRS FR-RCR-6: 생성 명령의 새 엔터티 id 를 reqId 와 묶어
  // 채널 `cmd.result` 로 서버에 echo (CHANNEL_PROTOCOL C2a). best-effort — 실패해도 서버 timeout 이 백스톱 (DC-RCR-3).
  _echoResult(reqId, result){
    const body={
      t:'cmd.result',
      reqId,
      newWindows:result.newWindows||[],
      newPanes:result.newPanes||[],
      newTabs:result.newTabs||[],
    };
    // ISSUE_AGENT_TREE_SRS FR-WGR-30 · FR-ORD-6: 새 그룹 id, 이동의 최종 위치, 실패 사유.
    if(result.newGroups) body.newGroups=result.newGroups;
    if(result.position) body.position=result.position;
    if(result.error) body.error=result.error;
    if(this.app.channel) this.app.channel.send(body);
  }

  /**
   * 구독자 없는 action 의 입구 (FR-OPT-11-2). 본체가 실렸으면 바로 넘긴다.
   *
   * 아니면 받은 순서대로 줄을 세우고 첫 명령이 묶음을 싣는다. 줄이 남아 있는 동안 온 명령은 본체가 이미
   * 섰어도 줄 끝에 선다 — 앞의 명령을 앞지르지 않는다. 실린 뒤 줄은 명령마다 따로 돈다: 하나가 던져도
   * 다음 명령은 돈다(실리기 전에도 명령은 서로 다른 호출이었다). 싣지 못하면 줄을 버린다 — 늦게 도는 닫기
   * 명령이 더 위험하고, 결과를 기다리던 호출자는 서버의 timeout 이 끝낸다(DC-RCR-3).
   */
  _execRemote(action, args){
    if(!this._remoteQ&&this._execRemoteNow){ this._execRemoteNow(action,args); return }
    if(this._remoteQ){ this._remoteQ.push([action,args]); return }
    this._remoteQ=[[action,args]];
    Screens.load('remote').then(()=>{
      const q=this._remoteQ; this._remoteQ=null;
      for(const [a,b] of q) Promise.resolve().then(()=>this._execRemoteNow(a,b));
    },(err)=>{
      const q=this._remoteQ; this._remoteQ=null;
      console.warn('[cmd] remote 묶음을 싣지 못해 명령 '+q.length+'개를 버린다',err);
    });
  }

  // 탭 uuid 로 그 자리를 찾는다. 없으면 null 이다 (FR-RUN-6a).
  _findTabById(id){
    const r=findTabWhere(this.app.ws.windows,tab=>tab.id===id);
    return r&&{windowId:r.win.id,paneId:r.pane.id,tabId:r.tab.id,...r};
  }
}
