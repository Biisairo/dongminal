/**
 * `▾` 옵션 다이얼로그 (FR-GIT-109·110, 검증 V62).
 *
 * 골격은 20단계의 `GitDialog` 다 (FR-GIT-171) — 필드 정의는 GIT_REMOTE_DIALOGS 에
 * 있고 fetch·pull·push 가 같은 골격을 쓰므로 다이얼로그마다 코드를 복제하지 않는다.
 * **첫 선택지가 기본이고 그것이 안전한 쪽이다** (FR-GIT-97·173).
 *
 * 여기 만드는 입력은 체크박스와 라디오뿐이다 — 자격증명을 받는 자리는 없다
 * (FR-GIT-104).
 */
class GitRemoteOpts {
  constructor(remote,kind){
    this.remote=remote;
    this.kind=kind;
    this.def=GIT_REMOTE_DIALOGS[kind];
  }

  _show(){
    return GitDialog.open({
      id:'git-remote-opts',ns:'gro',action:this.kind,
      title:this.def.title,runLabel:this.def.run,fields:this.def.fields,
      // 작업 하나의 수명은 패널의 `.git-job` 이 보인다 (FR-GIT-102·103) — 진행
      // 출력·취소·실패 사유가 거기 있으므로 다이얼로그는 시작만 하고 물러난다.
      run:v=>{this._start(this._body(v));return {ok:true}},
    });
  }

  // 값의 이름은 API 그대로다 (계약 §2.2). tags 는 3상태이므로 null|true|false 로
  // 옮긴다 — null 이면 저장소의 tagOpt 설정을 우리가 덮지 않는다.
  _body(v){
    if(this.kind==='fetch')
      return {prune:!!v.prune,tags:v.tags===''?null:v.tags==='yes'};
    if(this.kind==='pull') return {mode:v.mode||''};
    return {force:v.force||''};
  }

  _start(body){
    if(this.kind==='push'){this.remote._push(body.force);return}
    this.remote.run(this.kind,body);
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitRemoteOpts=GitRemoteOpts;
