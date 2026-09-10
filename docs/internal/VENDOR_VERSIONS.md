# `web/vendor` — 제3자 자산의 판과 해시

> 04-secops `SEC-32` · CI_GATES_SRS C4.
>
> **`scripts/check-vendor.sh` 가 이 표를 지킨다.** 파일이 바뀌면 표도 바뀌어야
> 하고, 안 바뀌면 게이트가 실패한다 — 기록만 두면 반드시 어긋난다.
>
> `web/vendor/` 가 아니라 여기 있는 이유: `web/embed.go` 의 `vendor/*` 가 그
> 폴더를 통째로 바이너리에 넣는다. 문서를 배포본에 실을 이유가 없다.
>
> 이 파일들은 npm 이 아니라 **저장소에 복사돼** 있고 `go:embed` 로 바이너리에
> 들어간다 (`web/embed.go`). 그래서 어느 판인지 아는 곳이 아무 데도 없었다 —
> 취약점 공지가 나와도 우리가 그 판인지 말할 수 없었다는 뜻이다.

**해시가 권위다.** 판 문자열은 파일이 스스로 밝힌 것을 옮겨 적었고, 밝히지
않는 파일은 근거를 함께 적었다. 갱신할 때 이 표를 함께 고친다.

| 파일 | 라이선스 | 판 | SHA-256 | 바이트 |
|---|---|---|---|---|
| `xterm.js` | MIT | 5.5.x (추정 ①) | `1f991ac3b4b283eb…` | 289441 |
| `xterm.css` | MIT | xterm.js 와 같은 판 | `ba8e698566948898…` | 5559 |
| `addon-fit.js` | MIT | xterm.js 와 같은 판 (②) | `bdaefa370b1bfc42…` | 1497 |
| `addon-search.js` | MIT | xterm.js 와 같은 판 (②) | `3cf52d71d9deb4ba…` | 12067 |
| `addon-unicode11.js` | MIT | xterm.js 와 같은 판 (②) | `b0c3be540a998471…` | 12253 |
| `addon-web-links.js` | MIT | xterm.js 와 같은 판 (②) | `f230a6c8211ce461…` | 3090 |
| `highlight.js` | BSD-3-Clause | 11.12.0 | `8ab71eb09c51f501…` | 129254 |
| `markdown-it.js` | MIT | 15.0.1 | `7a01babb52fc4d7f…` | 114905 |
| `purify.js` | Apache-2.0 / MPL-2.0 | 3.4.15 (DOMPurify) | `f263b05369e050fa…` | 29369 |

## 디렉터리로 들어온 자산

트리 하나가 자산 하나다. **크기 칸은 파일 수**이며 바이트 합계가 아니다 — 파일
하나가 커지고 다른 하나가 같은 만큼 작아지면 합계는 그대로여서 판정이 되지 않는다.

집계 해시는 파일마다 `SHA-256  상대경로` 줄을 만들어 경로로 정렬한 뒤 그 목록을
다시 SHA-256 한 값의 앞 16자다. 파일이 바뀌어도, 사라져도, **이름만 바뀌어도**
값이 달라진다.

| 자산 | 라이선스 | 판 | 집계 SHA-256 | 파일 수 |
|---|---|---|---|---|
| `monaco/` | MIT | monaco-editor 0.56.0 — `min/vs` (③) | `ab1af81a9d9b16a9…` | 139 |

③ 담긴 파일은 전부 **사전압축**(`<이름>.gz`)이며 서버가 `Content-Encoding: gzip`
   으로 그대로 흘린다 (`MONACO_VENDORING_SRS` 묶음 Z). raw 23.3MB 가 5.4MB 로
   들어간다 — `go:embed` 는 압축하지 않고 릴리스는 raw 바이너리를 그대로 올리므로,
   그 차이가 사용자가 받는 파일에 그대로 실린다.

   `min/vs` 의 `.d.ts` 13개는 담지 않는다. TypeScript 선언 파일이며 런타임에
   요청되지 않는다 — **실행되는 코드는 하나도 빠지지 않았다** (FR-MVN-2).

① `xterm.js` 는 판 문자열을 번들에 남기지 않는다. `rescaleOverlappingGlyphs`
   옵션이 들어 있는데 그것이 5.5.0 에서 도입됐고, `documentOverride`(5.4.0)도
   있다. 그러므로 **5.5 계열**이며 패키지는 `@xterm/xterm` 이다(구 `xterm` 은
   5.3.0 에서 멈췄다). 정확한 patch 판은 해시로만 특정된다.

② 애드온 넷도 판을 남기지 않는다. xterm.js 본체와 함께 받은 것이므로 같은
   계열로 적는다.

## 갱신 절차

1. 받은 파일로 덮어쓴다.
2. 아래 명령으로 표의 해시·크기를 다시 만든다.

```bash
# 파일 자산
for f in web/vendor/*; do
  [ -d "$f" ] && continue
  printf "%-24s %s %8s\n" "$(basename $f)" "$(shasum -a 256 $f | cut -c1-16)" "$(wc -c <$f)"
done

# 디렉터리 자산 — 집계 해시와 파일 수
for d in web/vendor/*/; do
  h=$( cd "$d" && find . -type f | LC_ALL=C sort | while read -r x; do
         printf '%s  %s\n' "$(shasum -a 256 "$x" | cut -d' ' -f1)" "${x#./}"
       done | shasum -a 256 | cut -c1-16 )
  printf "%-24s %s %8s\n" "$(basename $d)/" "$h" "$(find "$d" -type f | wc -l | tr -d ' ')"
done
```

3. 판이 바뀌면 `CHANGELOG.md` 에 적는다 — 화면이 바뀌는 변경이다.

## 벤더링되지 **않은** 것

**없다.** 종전에는 `monaco-editor` 하나가 런타임에 `cdn.jsdelivr.net` 에서 SRI 없이
왔다. M2 에서 벤더링했고(`MONACO_VENDORING_SRS`), 그것으로 CSP 의 외부 호스트가 0 이
됐다. 새 제3자 자산은 이 표에 줄이 서야 `scripts/check-vendor.sh` 를 지난다.
