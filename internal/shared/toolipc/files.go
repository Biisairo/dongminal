package toolipc

// DaemonBuildFile 은 도는 데몬이 자기 지문을 남기는 자리다
// (DAEMON_STALENESS_SRS FR-DFP-4). 홈 안에서 `paned.pid` 의 옆이며 수명도 같다 —
// 하나는 **누가** 도는지, 하나는 **무엇이** 도는지다.
//
// 이름이 이 패키지에 있는 이유는 `ProtocolVersion` 과 같다: 남기는 것은 데몬
// (`daemon/ipc`)이고 읽는 것은 제어 명령(`ctl/cli`)이라, 두 축이 **같은 한 벌**을
// 봐야 한다. 두 벌로 적으면 한쪽만 고쳐지고 그때 판정은 영영 "모른다" 가 된다.
const DaemonBuildFile = "paned.build"
