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
for f in web/vendor/*; do
  printf "%-24s %s %8s\n" "$(basename $f)" "$(shasum -a 256 $f | cut -c1-16)" "$(wc -c <$f)"
done
```

3. 판이 바뀌면 `CHANGELOG.md` 에 적는다 — 화면이 바뀌는 변경이다.

## 벤더링되지 **않은** 것

`monaco-editor` 는 런타임에 외부 CDN 에서 받는다
(`web/js/ui/file-editor.js:5`, `cdn.jsdelivr.net`, SRI 없음). 나머지가 전부
오프라인인데 편집기만 인터넷이 필요하고, 그 CDN 이 곧 스크립트 공급망이다 —
`02-fe-arch` 의 P1 이며 벤더링 대상이다. 이 마일스톤의 범위가 아니다.
