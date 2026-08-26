// Package query 는 저장소를 **읽는** 함수들이다 (FR-GIT-2).
//
// 이 패키지의 git 실행은 전부 core.Service.Exec 을 지난다 — 그것이 읽기
// 초크포인트이며 readCommands 화이트리스트·타임아웃·출력상한·기록이 거기 걸려
// 있다 (FR-GIT-8). core.execGit 은 core 밖으로 나오지 않으므로 우회 경로가
// 구조적으로 없다.
//
// 함수는 리시버 대신 *core.Service 를 첫 인자로 받는다 (FR-GIT-4). Go 는 타입의
// 메서드를 그 타입을 선언한 패키지에 강제하므로, Service 를 core 에 두고 조회를
// 여기로 가르는 유일한 형태다.
//
// Status·Signature·Preflight·CommitDetail·DiffContent 는 **타입 이름이 이미
// 쓰고 있어서** 함수 이름에 `Of` 를 붙였다 (StatusOf 등). 같은 패키지에서 타입과
// 함수가 이름을 나눠 가질 수 없다.
package query
