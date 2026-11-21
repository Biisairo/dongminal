/**
 * 원격 생성 다이얼로그 (FR-GIT-269).
 *
 * **URL 을 받는 자리는 자격증명을 받는 자리가 아니다** (FR-GIT-104). 여기서 받는
 * 것은 `git remote add` 의 두 번째 인자이며 git 이 저장소 설정에 그대로 적는 값이다
 * — dongminal 은 그것을 보관하지도, 인증에 쓰지도 않고, 밖으로 나갈 때는 서버가
 * 자격증명 자리를 지운다. 비밀을 따로 묻는 입력은 만들지 않는다.
 */
class GitRemoteAdd {
  constructor(list){
    this.list=list;
    this.panel=list.panel;
    this.repo=list.panel.repo;
    // 이름·URL·이미 있는 이름은 서버가 판정한다 (SERVER_DRIVEN_ACTIONS_SRS GV-c).
    this._answer=new GitInputAnswer({repo:this.repo,id:GIT_ACTION.remoteAdd,
      params:v=>({name:(v.name||'').trim(),url:(v.url||'').trim()}),
      fail:res=>this.panel.writeReason(res)||GIT_RM_ADD_FAIL});
  }

  _show(){
    return GitDialog.open({
      id:'git-remote-add',ns:'gra',action:'remote_add',
      title:GIT_RM_CREATE_TITLE,runLabel:GIT_RM_CREATE_RUN,focus:'name',
      fields:[
        {key:'name',type:GIT_DIALOG_TEXT,cls:'gra-name',placeholder:GIT_RM_NAME_PH},
        {key:'url',type:GIT_DIALOG_TEXT,cls:'gra-url',placeholder:GIT_RM_URL_PH},
      ],
      validate:(v,d)=>this._answer.why(v,d),
      run:v=>this._run(v),
    });
  }

  async _run(v){
    const res=await this.panel.post(GIT_API.remoteAdd,{
      repo:this.repo,name:(v.name||'').trim(),url:(v.url||'').trim(),
    });
    if(this.list.adoptWrite(res)) return {ok:true};
    // 실패 사유는 다이얼로그 안에 남는다 — 닫아 버리면 읽을 자리가 사라진다
    // (FR-GIT-175).
    return {ok:false,reason:this.panel.writeReason(res)||GIT_RM_ADD_FAIL,
      stderrTail:(res.data&&res.data.message)||''};
  }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — GitPanel 과 e2e 가
// 창 밖에서 부르므로 명시적으로 붙인다 (git-confirm.js 와 같은 규약).
window.GitRemoteAdd=GitRemoteAdd;
