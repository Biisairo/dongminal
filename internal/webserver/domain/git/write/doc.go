// Package write 는 저장소를 **변경하는** 함수들이다 (FR-GIT-3).
//
// 이 패키지가 git 을 실행하는 경로는 core.Service.ExecWrite 하나뿐이다 —
// core.GuardWriteArgs 로 writeCommands 화이트리스트를 통과시키고, 호출자의 파괴적
// 선언과 stdin 바이트 수를 기록에 남긴다 (FR-GIT-8).
//
// 읽기가 필요한 복합 동작(PushSpec 의 upstream 확인, StashPopChecked 의 목록
// 재조회, Discard 의 HEAD 확인)은 query 를 부른다. 읽기는 query 안에서 Exec 을
// 지나므로 두 초크포인트가 유지되고, 의존은 write → query → core 단방향이다
// (FR-GIT-9).
//
// 함수는 리시버 대신 *core.Service 를 첫 인자로 받는다 (FR-GIT-4).
package write
