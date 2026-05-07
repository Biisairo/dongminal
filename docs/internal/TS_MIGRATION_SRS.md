# SRS: TypeScript 마이그레이션 (frontend) — IEEE 29148

## 1. 개요

### 1.1 목적
`web/app.js` (∼2500줄, ES6 클래스 4개: TermPane, MdViewer, Renderer, InputBinding, App) 를 TypeScript 로 점진 변환하여 (a) 타입 안전성, (b) IDE 자동완성·리팩토링 정확도, (c) 향후 도메인 분리 (LayoutModel, FocusInvariant 등) 의 토대를 만든다.

### 1.2 범위
- `web/app.js` → `web/src/*.ts` (멀티 파일).
- `web/index.html` 의 inline `<script src="app.js?v=...">` → 빌드 산출물 `web/dist/app.js?v=...` (또는 동일 경로 유지).
- `web/embed.go` 의 정적 자산 경로 보존 (산출물을 동일 위치로 출력).
- `e2e/*.spec.ts` 는 이미 TS — 변경 없음.

### 1.3 정의
- **빌드 파이프라인**: TS → ES2020 JS 단일 번들. 본 SRS 는 esbuild 기반을 권장 (가장 빠른 스타트업, 타입체크는 별도 `tsc --noEmit`).
- **외부 라이브러리**: xterm@5, xterm-addon-fit, xterm-addon-search, xterm-addon-web-links, xterm-addon-unicode11, marked. 모두 `@types/*` 또는 자체 `.d.ts` 제공.

## 2. 현황
- `web/app.js` 단일 파일, IIFE 없이 전역 객체 (`window.app`, `window.__dongminalDebug`) 노출.
- 빌드 단계 없음 — 파일을 그대로 `web/embed.go` 의 `embed.FS` 가 서빙.
- 캐시 버스터 `?v=NNN` 으로 강제 재로드.
- TypeScript 도입은 e2e 가 이미 TS 임을 활용하지만 `tsc` / `esbuild` 의존성·CI 설정·CLAUDE.md 규칙(no any, no try/catch 제어흐름) 을 강제.

## 3. 요구사항

### 3.1 기능
| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| FR-TS-1 | `web/src/` 트리에 다음 모듈 분리: `term-pane.ts`, `md-viewer.ts`, `renderer.ts`, `input-binding.ts`, `app.ts`, `types.ts` (공유 인터페이스), `entry.ts` (브라우저 엔트리). | 필수 |
| FR-TS-2 | 빌드 산출물은 `web/dist/app.js` (또는 `web/app.js` 덮어쓰기) 단일 파일. ES2020 타겟. sourcemap 포함. | 필수 |
| FR-TS-3 | `tsc --noEmit --strict` 통과. `noImplicitAny`, `strictNullChecks` 활성. | 필수 |
| FR-TS-4 | `web/embed.go` 가 빌드 산출물을 서빙. 빌드 미실행 환경 (개발 시) 은 `make web` 또는 `npm run build:web` 으로 명시 트리거. | 필수 |
| FR-TS-5 | `e2e/*.spec.ts` 의 `(window as any).app` 캐스팅 → `WindowWithApp` 글로벌 타입으로 정형화. | 권장 |
| FR-TS-6 | 마이그레이션은 phase 단위 분할: ① 빌드 파이프라인 + 단일 파일 `app.ts` 변환 ② 모듈 분리 ③ strict 강화. | 필수 |

### 3.2 비기능
| ID | 요구사항 |
|----|----------|
| NFR-TS-1 | CLAUDE.md TypeScript 규칙 준수: `public` 키워드 금지, `any` 금지, `unknown` 최소화, try/catch 제어흐름 금지, non-relative import (`tsc-alias` 또는 esbuild paths). | 필수 |
| NFR-TS-2 | 마이그레이션 중 e2e 회귀 0건. 각 phase 독립 그린 빌드 유지. | 필수 |
| NFR-TS-3 | 산출물 크기 ≤ 현재 `app.js` 의 1.5배 (esbuild minify 옵션 사용 가능). | 권장 |

## 4. Phase 분할

### Phase 1: 빌드 파이프라인 도입 (위험 최소)
- `package.json` 에 `typescript`, `esbuild` 추가.
- `tsconfig.json` 작성 (`strict: true`, `module: "esnext"`, `target: "es2020"`, `lib: ["es2020", "dom"]`).
- `web/src/app.ts` 생성: `web/app.js` 의 내용을 그대로 복사 후 `// @ts-nocheck` 헤더로 시작 (점진 변환용).
- `scripts/build-web.sh` (또는 `npm run build:web`): `esbuild web/src/app.ts --bundle --outfile=web/app.js --target=es2020`.
- `web/embed.go` 변경 없음 (산출물이 `web/app.js` 로 덮어씀).
- e2e 그린 확인.

### Phase 2: 외부 라이브러리 타입 도입
- xterm.js, marked 등 `@types/*` 설치 또는 자체 `.d.ts` 작성.
- `Terminal`, `FitAddon`, `SearchAddon` 등 글로벌 변수에 타입 부여.
- `// @ts-nocheck` 헤더 삭제, `// @ts-ignore` 만 잔존.
- `tsc --noEmit` 에러 0 으로 만들기.

### Phase 3: 모듈 분리
- 클래스별 파일 분리 (TermPane, MdViewer, Renderer, InputBinding, App).
- 공유 타입 (Layout, Region, Tab, Session 등) `types.ts` 로 추출.
- non-relative import (`@/term-pane`) 또는 esbuild `paths` 설정.

### Phase 4: strict 강화
- `any` / `@ts-ignore` 잔존 0 으로.
- 글로벌 (`window.app`, `window.__dongminalDebug`) 의 `Window` 인터페이스 augmentation.

## 5. 검증
- 각 phase 종료 시 `tsc --noEmit && npm run build:web && npx playwright test` green.
- 산출물 sourcemap 으로 디버깅 가능.

## 6. DoD
- [ ] Phase 1~4 모두 완료.
- [ ] `tsc --noEmit --strict` 에러 0.
- [ ] e2e 68 + (가능시 추가) 회귀 0.
- [ ] DESIGN_REVIEW_FOLLOWUP §5 에 본 SRS 참조 추가.

## 7. 비목표
- 프레임워크 (React/Vue/Solid) 도입 — 별도 결정.
- xterm 의 fork / 대체.
- 빌드 도구 변경 후속 (Vite, Rspack 등).

## 8. 위험 / 트레이드오프
| 위험 | 완화 |
|------|------|
| 빌드 추가로 개발 사이클 지연 | esbuild 사용 (서브초 빌드), watch 모드 제공. |
| 회귀 가능성 | phase 단위 e2e 그린 강제. `// @ts-nocheck` 로 점진. |
| 산출물 크기 증가 | minify + tree-shake. 현재 unbundled 와 비교 측정. |
| go embed 와의 정합성 | 빌드 산출물을 기존 `web/app.js` 위치로 출력. embed.go 변경 없음. |
