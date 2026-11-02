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

코드에서는 `[dongminal]` 표식으로 찾는다.

1. 설정에 `thumb(view)`·`fromThumb(view, top)` 를 더했다. 있으면 뷰포트 표시(overlay)의 top·height 를
   `thumb` 가 주고, overlay 를 끌면 `fromThumb` 로 스크롤한다. 앱은 스크롤바 thumb 와 같은 함수를 넘긴다 —
   두 표시가 같은 자리에 선다 (FR-CMR-61).
2. overlay 의 자리를 문서가 바뀔 때도 다시 잰다 (원본은 geometry 변화 때만).
3. 설정에 `marks(state)`·`gutter(state)` 를 더했다. 각각 `[{line, color}]` 를 돌려주며, `marks` 는 줄 위에 반투명
   띠를, `gutter` 는 왼쪽 gutter 막대를 그린다 (FR-CMR-62·42). 색이 `--` 로 시작하면 편집기의 CSS 변수로 읽는다.
4. `minimapDrawn(view)` 를 내보낸다 — 미니맵이 받은 표식 `{marks, gutter}` (e2e 어댑터가 읽는다).
5. 미니맵의 높이를 편집기 상자(`view.dom`) 대신 스크롤 영역(`scrollDOM.clientHeight`)에서 잰다. 상자의 소수 높이가
   스크롤 영역보다 크면 문서 끝에서 sticky 가 덜 붙어 뷰포트 표시가 thumb 보다 반 픽셀 위에 섰다.
