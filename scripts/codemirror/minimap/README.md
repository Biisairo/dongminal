# 미니맵 포크 — `@replit/codemirror-minimap` 0.5.2

CODEMIRROR_MIGRATION_SRS FR-CMR-60~63 · §11.3. `scripts/build-codemirror.mjs` 가 `entry.js` 를 거쳐 묶는다.

## 원본

| 항목 | 값 |
|---|---|
| 패키지 | `@replit/codemirror-minimap` 0.5.2 (npm) |
| 원본 커밋 | `eb03174ce67e177bb86297c84c0389491350ff21` (npm 메타데이터의 `gitHead`) |
| 원본 파일 | 패키지의 `dist/index.js` (TypeScript 원본은 패키지에 없다) |
| 무결성 | `sha512-eNAtpr0hOG09/5zqAQ5PkgZEb3V/MHi30zentCxiR73r+utR2m9yVMCpBmfsWbb8mWxUWhMGPiHxM5hFtnscQA==` |
| 라이선스 | MIT |

원본 저장소와 패키지에는 LICENSE 파일이 없다. `package.json` 의 `"license": "MIT"` 와 작성자(Brady Madden, Replit)를
근거로 표준 MIT 문안을 `LICENSE` 에 적었다. 저작권 연도는 0.1 판이 나온 해다.

## 고친 자리

코드에서는 `[otterminal]` 표식으로 찾는다.

1. 설정에 `thumb(view)`·`fromThumb(view, top)` 를 더했다. 있으면 뷰포트 표시(overlay)의 top·height 를
   `thumb` 가 주고, overlay 를 끌면 `fromThumb` 로 스크롤한다. 앱은 스크롤바 thumb 와 같은 함수를 넘긴다 —
   두 표시가 같은 자리에 선다 (FR-CMR-61).
2. overlay 의 자리를 문서가 바뀔 때도 다시 잰다 (원본은 geometry 변화 때만).
3. 설정에 `marks(state)`·`gutter(state)` 를 더했다. 각각 `[{line, color}]` 를 돌려주며, `marks` 는 줄 위에 반투명
   띠를, `gutter` 는 왼쪽 gutter 막대를 그린다 (FR-CMR-62·42). 색이 `--` 로 시작하면 편집기의 CSS 변수로 읽는다.
4. `minimapDrawn(view)` 를 내보낸다 — 미니맵이 받은 표식 `{marks, gutter}` (e2e 어댑터가 읽는다).
5. 미니맵의 높이를 편집기 상자(`view.dom`) 대신 스크롤 영역(`scrollDOM.clientHeight`)에서 잰다. 상자의 소수 높이가
   스크롤 영역보다 크면 문서 끝에서 sticky 가 덜 붙어 뷰포트 표시가 thumb 보다 반 픽셀 위에 섰다.
6. `minimapScale(view)` 를 내보낸다 — 미니맵 자체 배치의 좌표 `{slider, fromSlider, posTop, posBottom}`. 앱의 스크롤바가
   미니맵이 켜져 있을 때 thumb · ruler · 끌기에 이것을 쓴다. 줄바꿈 문서에서도 슬라이더와 thumb 가 같은 자리에 선다
   (EDITOR_LINK_LSP_SRS FR-ELS-64).
7. perf 3.7 — 큰 문서를 열 때 모든 줄을 한 번에 훑지 않는다.
   - 줄의 span 은 그 줄을 그릴 때 만든다(`TextState.get` → `lineSpans`). 원본 `updateMapImpl` 은 문서 전체를 훑었다.
     강조가 겹치지 않고 차례대로라는 성질로, 줄마다 따로 만들어도 원본의 한 번 훑기와 결과가 같다.
   - 칸 수(`lineColumns`)는 줄바꿈이 켜져 있을 때만 센다. 처음 셀 때는 배치를 처음 물은 자리에서 4 ms, 그 뒤로는 이 플러그인의
     프레임 콜백에서 한 프레임에 8 ms 만큼만 세고, 다 셀 때까지
     배치가 없다(미니맵은 지난 그림을 두고, 스크롤바는 CM 높이를 쓴다). 다 세면 빈 효과(`columnsCounted`)를 보낸다.
     한 번 다 센 뒤 문서·접힘이 바뀌면 원본처럼 곧바로 다시 센다.
   - 줄 그리기(`render` → `drawRows`)는 화면 밖 캔버스에 하고, 다 그리면 보이는 캔버스로 한 번에 옮긴다. 그리는 동안에는
     지난 그림이 그대로 보인다. 그릴 줄이 256 개 이하면 측정 프레임에서 곧바로 그리고(원본과 같다), 그보다 많으면 다음 프레임부터
     한 프레임에 8 ms 만큼씩 그린다. 새로 그리면 남은 일은 버린다. 다 그린 그림은 한 번에 그린 것과 같다. `drawnRows` 는 그리기를
     시작할 때 한 번에 정한다.
   - 문서 문자열(`doc.toString()`)은 파서가 있을 때만 만든다.
   - `minimapDrawn` 이 `built`(span 을 만든 줄 수)를 함께 돌려준다. `lineSpans`·`lineColumns` 를 `minimapLineSpans`·
     `minimapLineColumns` 로 내보낸다(단위 시험용).
