# UI/UX 전면 개편 이어서 — 착수 프롬프트 (위계·문체·조회·동작의 자리)

**스펙이 서고 M1·M2 가 구현·검증되어 커밋됐다.** 남은 넷은 전부 SRS 에 근거와
실측이 적혀 있다 — 다시 재지 말고 옮기면 된다.

- `dbddb7fe` docs(spec): UI/UX 전면 개편의 스펙을 세운다 — 자리·구분·디자인
- `249cf858` fix: 글꼴은 토큰에서 오고 상태색은 ANSI 에서 온다 (FR-TYP-1~6 · FR-SEM-1~3)

---

```
프로젝트: /Users/dykim/personal/dongminal

## 0. 먼저 읽을 것

`docs/internal/UIUX_OVERHAUL_SRS.md` — 이번 개편의 스펙. 전부 읽되 특히:
  §1.2  **범위.** 무엇이 비포함인지가 이 문서의 절반이다
  §2    현재 상태 — 실행 중인 서버의 실제 화면 8장으로 잰 것
  §3.2  확정된 결정 D-1~D-5 (사용자 결정 2026-09-21)
  §3.3  원칙 여섯 — 특히 3번(accent 는 "지금 어디" 에만)
  §4.2~4.4, §4.7  **이번에 할 일** (FR-CHR · FR-ACT · FR-HIE · FR-CPY)
  §6    마일스톤 — M3~M6 이 남았다
  §8    리스크 — R-1 이 M6 의 선행 조건이다
  §10   후속 과제. **여기 있는 것은 이번에 하지 않는다**

`docs/internal/DESIGN_TOKENS_SRS.md` — 토큰의 정본. 이 개편은 새 시스템을
세우지 않고 그 토큰의 **소비처**를 정한다.

기준선 화면 8장: `tmp/uiux-baseline/uiux-0{1..8}-*.png` (git 밖이다)
  01 데스크톱 Windows · 02 Repo · 03 설정 · 04 Agents
  05·06 모바일 · 07 Background 모달 · 08 Runs 모달
M1·M2 적용 후: `tmp/uiux-baseline/uiux-after-0{1,2}-*.png`

## 1. 할 일 — 넷, 전부 근거가 확정돼 있다

  M3  §4.4 FR-HIE-1~5  위계와 밀도     LOW
  M4  §4.7 FR-CPY-1~3  문체            LOW
  M5  §4.3 FR-ACT-1~6  조회의 자리     MEDIUM
  M6  §4.2 FR-CHR-1~7  동작의 자리     HIGH — R-1 조사가 선행한다

**순서 제안**: M3 → M4 → M5 → M6.
M3 이 맨 앞인 이유는 M6 이 그것에 의존하고(경계 3단이 서야 탭줄이 크롬이 된다)
위험이 가장 낮기 때문이다. M6 이 맨 뒤인 이유는 §8 R-1 이다 — e2e 191개
파일의 셀렉터 의존을 **전수 조사하기 전에는 착수하지 않는다.**

## 2. 값을 치르고 안 것 — 다시 재지 마라

**① 게이트가 ANSI 6색을 검사한 적이 없었다.**
`deriveContrastTokens` 는 6색을 `CONTRAST_FLOORS.strong` 으로 끌어올려 왔으나
`check-contrast.mjs` 의 `CHECK` 에도 `CSS_TOKENS` 에도 6색이 없었다.
`--git-st-add:var(--term-green)` 을 통해 green 하나가 간접적으로 걸렸을 뿐이다.
M2 에서 확장했고 **54종 × 6색 × 3배경 전부 통과**다. 이제 새 소비처를 만들어도
게이트가 받는다.

**② `CSS_TOKENS` 와 `SYNTAX_TOKENS` 는 다른 목록이다.**
`CSS_TOKENS` 는 **`:root` 의 CSS 선언**이 무엇을 가리키는지 보는 목록이고
(`--git-st-add:var(--term-green)`), `SYNTAX_TOKENS` 는 **파생 결과** 자체를 보는
목록이다. `--term-*` 를 `CSS_TOKENS` 에 넣으면 `:root` 의 첫 페인트 폴백
(`#7dcfff`)을 재게 되어 라이트 테마 11종이 거짓 미달을 낸다 — 실제로 한 번
밟았다.

**③ `--accent` 오용을 찾는 법.**
상태를 나타내는 클래스가 accent 를 쓰면 포커스 표시와 경쟁한다. 이 정규식이
세 건을 찾아냈다:

    grep -rnE "\.(err|error|fail|failed|warn)[a-z-]*\s*\{[^}]*--accent" web/*.css

M5·M6 에서 패널·배지를 손댈 때 같은 방식으로 재확인한다. **주석이 이미 의도를
적어 둔 경우가 있다** — `.acl-state` 는 "실패했을 때만 눈에 든다" 라고 적고도
accent 를 쓰고 있었다.

**④ 화면 검증은 `--isolated` 로 한다. 운영 인스턴스를 건드리지 마라.**

    go build -o /tmp/dm-x ./cmd/dongminal
    /tmp/dm-x start --isolated          # 임시 홈 + 빈 포트, 기동 출력이 포트를 찍는다
    …검증…
    /tmp/dm-x stop --all --port <포트> --home <격리홈>

**웹 자산은 바이너리에 임베드된다** (`web/embed.go`) — CSS·JS 를 고쳐도
돌고 있는 서버에는 반영되지 않는다. 재빌드가 필요하다. `curl -s
http://127.0.0.1:<포트>/style.css | grep …` 로 반영 여부를 확인할 수 있다.

**⑤ 표시 이름의 계산은 이미 한 자리다.**
`helpers.js` 의 `toolDisplayName(toolId,fgNames,tab,fallback)`
(`UX_REVISION_SRS` FR-NAM-1). 호출처는 넷이다 — `renderer-pane.js:34` ·
`app-attn.js:413` · `app-statusbar.js:261` · `app-agents.js:280`.

**⑥ `FR-NAM` 접두는 이미 쓰이고 있다** (`UX_REVISION_SRS` FR-NAM-1~7).
새 묶음이 필요하면 다른 접두를 써라 — `FR-DSC` 는 전 저장소에서 미사용이다.

**⑦ 건드리면 안 되는 설계 둘.**
`REPO_TAB_UNIFY_SRS` 가 Windows·Repo 두 목록의 분리를 **의도된 설계**로 잠갔고
("저장소 하나에 창 하나"), `CONVENIENCE_SRS` FR-TAN-5 가 탭 이름의 **출처**를
전경 프로세스로 정했다. 둘 다 이 개편의 비포함이다.

**⑧ 상태바의 uptime 은 아직 조각나지 않았다.**
`↑ 시스템 1d 21h │ 서버 18h 54m` 은 i18n 템플릿(`statusbar.uptime_sys`)과
기계값이 한 문자열로 섞여 있어 FR-TYP-3 을 적용하지 못했다. **M3 의
FR-HIE-4(상태바 우선순위 접힘)를 할 때 함께 다루는 것이 맞다** — 그때 어차피
그 줄을 다시 짠다.

## 3. 규약 — 이 개편에서 변하지 않는 것

- **기능을 더하지 않는다** (D-4). 자리·위치·구분·디자인만 바꾼다. 명령
  팔레트·검색·필터·새 단축키·새 동작·새 화면은 §10 의 후속 과제다
- **탭 이름·라벨의 구분은 별도 진행이다** (D-5, 사용자 지시). §10 ③ 참조
- **테마 팔레트의 값을 고치지 않는다.** 54종은 정본이다 (D-TOK-1)
- **기존 단축키를 하나도 없애지 않는다** (NFR-4). M6 이 상단바를 해체해도
  키는 전부 산다
- 커밋 전 `make gates` · `npm run unit`. 게이트 8종이 돈다
  (font-family 게이트가 M1 에서 새로 들어갔다)
- **커밋 메시지에 AI 서명(Co-Authored-By 등)을 넣지 않는다**
- 동작이 바뀌면 **이전 동작 / 새 동작 / 이유** 세 줄을 남긴다. 저장소의 관행이다

## 4. 사용자 결정 — 아직 유효하다 (2026-09-21)

  D-1 타이포   역할로 가른다 — 기계값=mono, 사람말=sans(한글 포함)
  D-2 크롬     #topbar 해체 — 동작은 pane 탭줄, 위치·상태는 상태바
  D-3 의미색   ANSI 6색 전면 사상
  D-4 범위     기능 추가 없음
  D-5 범위     탭 이름은 이 묶음이 다루지 않는다

D-1·D-3 은 M1·M2 에서 절반이 구현됐다. **남은 자리에도 같은 사상표를 쓴다**
(§4.6 FR-SEM-1 의 표가 정본이다 — 자리마다 색을 고르지 마라).

먼저 M3 의 FR-HIE-1(경계 3단)부터 시작하라. `--border` 1px 이 226회 쓰여
창·칸·행·패널이 같은 선을 쓰고 있고, `--border-strong` 은 이미 있으므로
`--border-weak` 파생 하나만 더하면 된다.
```
