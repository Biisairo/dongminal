# Next Session Prompts

본 문서는 별도 세션에서 이어 작업할 때 그대로 복사·붙여넣기 할 수 있는 진입 프롬프트 두 개를 보관한다.

---

## A. 남은 Design Review 항목 (S4 / S6 / L2 / L3 / L5 / L6 / L7) 처리 세션

```
docs/internal/DESIGN_REVIEW_FOLLOWUP.md 의 §4 작업 큐에서 미처리(⏸️)인 design review 항목을 이어서 처리한다.

이번 세션 목표: 사용자가 선택한 항목을 Spec → Test → Code 순으로 구현·검증·문서화 완료까지.

진행 절차:
1. 컨텍스트 로드:
   - docs/internal/DESIGN_REVIEW_FOLLOWUP.md (§2 Strategic concerns, §3 Localized issues, §4 작업 큐)
   - docs/internal/SAFETY_WARMUP_SRS.md / WORKSPACE_SNAPSHOT_SRS.md / HANDLERS_API_ROUTER_SRS.md / PANE_MANAGER_DECOMPOSE_SRS.md / APP_DECOMPOSE_SRS.md (이전 세션의 SRS 양식 참고)
   - 변경 대상 파일은 LSP/Serena 로 우선 탐색.
2. 화면 첫 응답에 미처리 항목 요약을 노출하고 사용자에게 한 번에 묻는다:
   - 이번 세션에서 다룰 항목 (S4 / S6 / L2 / L3 / L5 / L6 / L7 다중 선택 가능)
   - 각 항목의 범위 한정
   - 단일 PR vs phase 분할 여부
3. 답변 후 항목별로 다음 사이클을 반복한다 (CLAUDE.md SDD+TDD 강제):
   a. 최소 Spec 작성/갱신 — IEEE 29148 양식. 새 항목이면 docs/internal/<NAME>_SRS.md 생성, 기존 SRS 가 있으면 추가 섹션. FR/NFR/완료 조건 명확.
   b. 테스트 먼저 작성/수정 — 실패 확인. 프론트는 e2e/, Go 는 internal/<pkg>/*_test.go.
   c. 구현 — 외과적 변경. 단일 진입점/단일 불변식으로 구조화.
   d. go test -race ./... 와 npx playwright test 전부 통과 확인.
   e. SRS 의 완료 조건 체크리스트 갱신, web/index.html 의 ?v= 캐시 버스터 bump (프론트 변경 시).
4. 변경 요약을 사용자에게 보고하고 다음 항목 선택을 묻는다.

각 항목 요약 (DESIGN_REVIEW_FOLLOWUP.md 기준):
- S4 (outbuf 얕은 모듈성): internal/outbuf/stream.go — Subscribe backpressure 정책 명시 또는 backlog 카운터 노출.
- S6 (MCP typed Bind helper): internal/mcptool/registry.go — Bind[Req,Resp](name, fn) 도입으로 tools/*.go 중복 ~100 줄 감축.
- L2 (단축키 dispatch 테이블화): web/app.js InputBinding.bind 의 if-else 사슬 → shortcut→action 테이블.
- L3 (pane.go reentrancy): exit 콜백 + broadcast 가 같은 mutex 안에서 호출되는 위험.
- L5 (commands.go SSE 클라이언트 맵 락 누락 가능성): broadcast vs add/remove 동시 mutate 시 race 점검.
- L6 (codeserver graceful shutdown): 외부 프로세스 정리 timeout 의존성 제거, signal 추가.
- L7 (mcptool/tools/readpane.go ANSI strip 중복): outbuf 에 이미 strip 가 있는지 확인 후 통합.

제약 (반드시 준수):
- 커밋은 사용자 확인 후에만. Claude Co-Author 시그니처 삽입 금지 (organization rule).
- Spec 없이 코드 변경 금지. Test 없이 구현 금지.
- TypeScript 룰 (CLAUDE.md): public 키워드 생략, any 금지, try/catch 제어 흐름 금지.
- LSP/Serena 우선 탐색. grep/find 는 파일명·패턴 검색 한정.
- 외과적 변경. 같은 PR 내 무관한 리팩터링 금지.
- 파일 이동은 mv, 작성은 Write/Edit 로.

권장 시작 항목 (의견 없으면 이 순서):
1) L3, L5 (concurrency 안전성 — 작은 면적, 큰 가치)
2) L7 (중복 제거)
3) S4 (outbuf 정책 명시)
4) L6 (codeserver shutdown)
5) S6 (Bind helper — 더 큰 작업, 여러 tool 변경)
6) L2 (UI 단축키 테이블화)

세션 종료 시 처리한 항목과 미처리 항목을 DESIGN_REVIEW_FOLLOWUP.md §4 에 ✅ / ⏸️ 표시하고, push 는 하지 말고 stage 만 두어 사용자 검토 대기.
```

---

## B. TS 마이그레이션 Phase 1 착수 세션

```
docs/internal/TS_MIGRATION_SRS.md 의 Phase 1 (빌드 파이프라인 도입) 을 실제 구현한다.

이번 세션 목표: TypeScript + esbuild 빌드 파이프라인을 도입하여 web/app.js 가 TS 산출물로 동작하도록 만들되, 코드 변환 자체는 최소화한다 (// @ts-nocheck 헤더로 점진 전환 토대만 마련).

진행 절차:
1. 컨텍스트 로드:
   - docs/internal/TS_MIGRATION_SRS.md 전체 (§4 Phase 1 의 DoD 4 항목)
   - 현재 web/embed.go, web/app.js, web/index.html 구조
   - package.json 의 기존 devDependencies (@playwright/test 만 있음)
2. Phase 1 구현 단계:
   a. package.json 에 typescript, esbuild devDependencies 추가. npm install.
   b. tsconfig.json 작성 — strict: true, target: es2020, module: esnext, lib: [es2020, dom], moduleResolution: bundler. noEmit: true (esbuild 가 emit 담당).
   c. web/src/ 디렉터리 생성. web/app.js 를 web/src/app.ts 로 mv (mv 명령 사용, write 금지). 파일 첫 줄에 // @ts-nocheck 추가 (Phase 1 동안 점진 전환).
   d. scripts/build-web.sh 작성: esbuild web/src/app.ts --bundle --outfile=web/app.js --target=es2020 --sourcemap. 실행 권한 부여.
   e. package.json scripts 에 "build:web": "bash scripts/build-web.sh", "typecheck:web": "tsc --noEmit -p ." 추가.
   f. 빌드 실행 → web/app.js 생성 확인. 산출물 크기 측정.
   g. tsc --noEmit 결과 확인 (// @ts-nocheck 때문에 0 에러 예상).
   h. e2e 전체 통과 확인 (npx playwright test).
3. 회귀 검증:
   - 산출물 web/app.js 의 동작이 이전과 동일한지 e2e 68/68 통과로 검증.
   - 빌드되지 않은 환경 (개발 시) 의 워크플로우 — 사용자가 web/src/app.ts 를 수정하면 build:web 을 실행해야 한다는 점을 README 또는 CLAUDE.md 에 명시.
4. .gitignore 에 web/app.js.map 추가 (sourcemap, embed 대상 외) — 결정에 따라 또는 commit 가능.
5. DoD 체크리스트 (TS_MIGRATION_SRS Phase 1):
   - [ ] tsconfig.json 작성
   - [ ] esbuild 빌드 산출물이 web/app.js 로 출력
   - [ ] e2e 68/68 그린
   - [ ] tsc --noEmit 통과 (@ts-nocheck 활성)
   - [ ] DESIGN_REVIEW_FOLLOWUP §5 에 TS_MIGRATION_SRS 참조 항목 추가

제약 (반드시 준수):
- 커밋은 사용자 확인 후에만. Claude Co-Author 시그니처 삽입 금지.
- 본 세션은 Phase 1 만 — 코드 자체 TS 변환은 Phase 2 이후.
- 산출물은 기존 web/app.js 위치로 출력 (web/embed.go 변경 없음).
- 캐시 버스터 web/index.html ?v= bump 필요 시.
- node_modules 새 의존성 (typescript, esbuild) 외 추가 금지.
- LSP/Serena 우선 탐색.

위험 / 주의:
- web/app.js 가 이제 빌드 산출물이 되므로, 누군가 직접 web/app.js 를 수정하면 다음 build:web 에서 덮어써짐. CLAUDE.md 또는 web/README.md 에 경고 추가 권장.
- esbuild 가 일부 ES 신문법(예: top-level await) 을 transpile 못 할 수 있음 → target=es2020 로 충분한지 빌드 시 확인.
- e2e 의 webServer 가 go run 으로 시작하므로 사전에 build:web 이 실행되도록 playwright.config.ts 의 globalSetup 또는 webServer.command 수정 검토.

세션 종료 시 stage 만 두고 push 안 함. 사용자 검토 대기.
```

---

## 사용 방법
1. 새 Claude Code 세션을 연다.
2. 위 두 블록 중 하나를 그대로 붙여넣는다.
3. 세션이 SRS / 작업 큐를 읽고 첫 응답에서 사용자에게 항목 선택 / 진행 옵션을 묻는다.
