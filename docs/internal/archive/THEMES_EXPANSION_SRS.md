# SRS: 테마 라이브러리 확장 (IEEE 29148 준수)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
다양한 IDE/터미널 에뮬레이터에서 검증된 테마를 추가하고, 다크/라이트 모드를 분리·노출한다. README TODO "theme 늘리기" 단일 원천 스펙.

### 1.2 범위 (Scope)
- 프론트엔드 `web/app.js` 의 `THEMES` 정의에 항목 추가, 각 항목에 `mode: 'dark' | 'light'` 메타 부여.
- 테마 피커 UI(`_renderThemePanel`) 의 Dark/Light 섹션 그룹 헤더.
- 비포함: 테마 외 색 토큰(상태바, 명령 팔레트 등) 신설, 사용자 커스텀 라이트 모드 기본값 변경.

### 1.3 정의 (Definitions)
- **Dark theme**: `mode==='dark'`. 배경 휘도(luma)가 낮아 흰 글씨가 자연스러움.
- **Light theme**: `mode==='light'`. 배경 휘도가 높아 짙은 글씨가 자연스러움.
- **Near-duplicate**: 두 테마의 주요 토큰(`bg/accent/red/green/blue`) 의 색차(ΔE) 가 사람 눈에 구분이 안 갈 정도(주관)로 가까운 경우.

## 2. 현황 (Current State)
- 21개 다크 테마만 존재(코드 진입점 `web/app.js:84` `THEMES`).
- 라이트 테마 0개 → 밝은 환경에서 사용성이 떨어짐.
- 일부 유사군:
  - **Material Ocean / Palenight** — Palenight 가 더 보랏빛, Ocean 더 푸른 어두움. 둘 다 유지(특색 충분).
  - **One Dark / Doom One** — Doom One 은 Emacs Doom 변형, 토큰 약간 다름. 둘 다 유지.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-1 | 모든 `THEMES` 항목은 `ui`, `terminal`, `mode` 필드를 가진다. `mode` 는 `'dark'` 또는 `'light'`. | 필수 |
| FR-2 | 신규 다크 테마 ≥ 12개 추가. 출처는 VSCode/IntelliJ/Atom/Astro/Hyper/Vim 계열 등. 최소: Vesper, Vitesse Dark, Houston, Andromeda, Iceberg, Tomorrow Night, Monokai Pro, Apprentice, Snazzy, VSCode Dark+, VSCode Dark Modern, Catppuccin Frappé. | 필수 |
| FR-3 | 신규 라이트 테마 ≥ 10개 추가. 최소: GitHub Light, Solarized Light, One Light, Tokyo Night Light, Catppuccin Latte, Gruvbox Light, Rosé Pine Dawn, Ayu Light, Everforest Light, Quiet Light, Vitesse Light. | 필수 |
| FR-4 | 신규 항목 중 기존 테마와 사람 눈에 구분이 안 가는 near-duplicate 는 한쪽만 유지한다. | 권장 |
| FR-5 | `_renderThemePanel` 은 Dark/Light 섹션을 분리해 헤더와 함께 렌더링하되, 기존 클릭 동작·미리보기·`saveSettings` 동작은 변경하지 않는다. | 필수 |
| FR-6 | `currentThemeName` 의 영속화/복원 동작은 회귀 없음(기존 다크 테마 이름 보존). | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-1 변경은 `web/app.js`/`web/style.css` 외 파일을 건드리지 않는다.
- NFR-2 라이트 테마 추가가 다크 테마 사용 시 어떠한 색 누락도 일으키지 않아야 한다(모든 토큰 채워짐).
- NFR-3 기존 e2e 회귀 76건 전부 통과.
- NFR-4 `node --check web/app.js` 무결.

### 3.3 제약 (Constraints)
- 데이터 구조 변경 금지(`ui` 키 셋: bg/sidebarBg/border/accent/text/textMuted/textBright/textDim/danger/accentBorder; `terminal` 키 셋: xterm.js 표준).
- 외부 패키지/라이센스 추가 금지(색상 값은 공개 사양/공식 README 기반 직접 기입).

## 4. 설계 (Design)

### 4.1 데이터 모델
```
THEMES['Name'] = { mode: 'dark'|'light', ui: {...}, terminal: {...} }
```
`getCurrentTheme()` / `applyThemeObj()` 는 `mode` 를 무시(렌더에 영향 없음). UI 그룹화에서만 사용.

### 4.2 신규 테마 출처(주관 큐레이션)
**Dark 추가 후보**
- VSCode Dark+ / Dark Modern (VSCode 기본)
- Vesper (Adam Wathan)
- Vitesse Dark (Anthony Fu)
- Houston (Astro 공식)
- Andromeda (Eliver Lara)
- Iceberg (Vim)
- Tomorrow Night (Chris Kempson)
- Monokai Pro (filter:default)
- Apprentice (Vim/Tmux)
- Snazzy (Hyper)
- Catppuccin Frappé (포카리 톤)

**Light 추가 후보**
- GitHub Light (GitHub primer)
- Solarized Light (Ethan Schoonover)
- One Light (Atom)
- Tokyo Night Light (folke)
- Catppuccin Latte
- Gruvbox Light
- Rosé Pine Dawn
- Ayu Light
- Everforest Light
- Quiet Light (VSCode)
- Vitesse Light

### 4.3 picker UI
`_renderThemePanel` 변경:
- 입력: `Object.entries(THEMES)` → 두 그룹으로 분리(Dark / Light, 각 알파벳순).
- 출력: 각 그룹마다 `<div class="tl-section">DARK</div>` 헤더 + 기존 `.tl-item` 들. `.tl-section` 은 sticky 가 아닌 일반 헤더로 충분.

CSS(`style.css`) 추가:
```
.tl-section{font-size:9px;letter-spacing:.1em;color:var(--text-muted);
  padding:6px 10px 4px;border-bottom:1px solid var(--border);
  text-transform:uppercase}
```

## 5. 검증 (Validation)
- 수동: 모달 → 테마 탭 → Dark/Light 그룹 헤더 확인, 각 그룹 5개 이상 표시.
- e2e: 신규 라이트 테마 1개 클릭 후 `--bg` 가 라이트 톤으로 변경되는지 확인(`e2e/themes-light.spec.ts`).
- 회귀: `npx playwright test` 전부 통과.

## 6. 완료 조건 (Definition of Done)
- [ ] `THEMES` 갱신 (`mode` 필드 + 신규 항목들).
- [ ] picker UI 그룹 헤더 + CSS 추가.
- [ ] e2e 1건 추가 + 기존 회귀 통과.
- [ ] 본 SRS 문서 commit.
