// Package errdoc 는 오류 카탈로그를 **생성한다** (ERROR_CONTRACT_SRS 묶음 K).
//
// 손으로 적은 문서는 조용히 낡는다 — 착수 시 코드 47개 중 문서에 있던 것이
// **7개**였다. 생성물이면 코드를 더한 사람이 문서를 고칠 수밖에 없다:
// 안내를 적지 않으면 생성이 실패하고(D-ERR-4), 적으면 문서가 따라온다.
package errdoc

import (
	"fmt"
	"sort"
	"strings"

	"dongminal/internal/webserver/apierr"
)

// Header 는 생성물의 머리말이다. **여기를 고치면 생성물도 함께 바뀐다** —
// 문서 쪽을 직접 고치면 CI 가 잡는다.
const Header = `<!-- 이 파일은 생성물입니다. 직접 고치지 마세요.
     원천: internal/webserver/apierr/codes_doc.go
     생성: dongminal 저장소에서 ` + "`go run ./scripts/gen-errors`" + `
     검사: scripts/check-error-docs.sh (CI) -->

# 오류 코드

이 서버가 낼 수 있는 오류 코드 전부입니다.

## 어디서 받나요

모든 오류 응답에 코드가 ` + "`X-Error-Code`" + ` **헤더**로 실립니다. 본문의 모양은
표면마다 다르지만(아래 *방언*), 헤더는 어디서나 같습니다 — 그래서 분기는 헤더로
하세요.

함께 실리는 ` + "`X-Request-Id`" + ` 는 그 요청 하나의 식별자입니다. 신고할 때 이
값을 적어 주시면 서버 로그에서 그 요청이 남긴 줄 전부를 찾을 수 있습니다.

## 본문의 모양 — 방언 다섯

본문 형식은 표면마다 다르고 **각각이 공개 계약**이라 통일하지 않습니다.
코드로 분기하려면 본문이 아니라 헤더를 보세요.

| 방언 | 본문 | 쓰는 곳 |
|---|---|---|
| git | ` + "`{\"error\": <코드>, \"message\": <tail>}`" + ` | ` + "`/api/git/*`" + ` |
| fs | ` + "`{\"code\": <코드>, \"message\": <msg>}`" + ` | ` + "`/api/fs/*`" + ` · ` + "`/api/editors/*`" + ` |
| runs | ` + "`{\"error\": <코드>, \"detail\": <err>}`" + ` | ` + "`/api/runs/*`" + ` |
| 단문 | ` + "`{\"error\": <문구>}`" + ` | ` + "`/api/tools/{output,input,message}`" + ` · ` + "`/api/whoami`" + ` |
| 평문 | ` + "`text/plain`" + ` 한 줄 | 그 밖의 ` + "`/api/*`" + ` |

## 코드
`

// Render 는 카탈로그 전문을 만든다. 안내가 없는 코드가 있으면 오류다 (FR-ERR-10).
func Render() (string, error) {
	codes := apierr.AllCodes()
	sort.Strings(codes)

	var missing []string
	for _, c := range codes {
		d := apierr.CodeDoc[c]
		if d.Meaning == "" || d.Recover == "" {
			missing = append(missing, c)
		}
	}
	if len(missing) > 0 {
		// **생성을 멈춘다.** 코드만 늘고 안내가 없는 문서는 없는 것보다 나쁘다 —
		// 있다고 믿게 만든다 (D-ERR-4).
		return "", fmt.Errorf("안내가 없는 코드 %d개: %s\n  codes_doc.go 의 CodeDoc 에 의미와 복구 안내를 적으세요",
			len(missing), strings.Join(missing, ", "))
	}

	var b strings.Builder
	b.WriteString(Header)
	b.WriteString("\n| 코드 | 의미 | 다음에 할 일 |\n|---|---|---|\n")
	for _, c := range codes {
		d := apierr.CodeDoc[c]
		fmt.Fprintf(&b, "| `%s` | %s | %s |\n", c, cell(d.Meaning), cell(d.Recover))
	}
	fmt.Fprintf(&b, "\n총 **%d개**.\n", len(codes))
	return b.String(), nil
}

// cell 은 표 칸에 들어갈 수 없는 글자를 피한다. 파이프가 칸을 쪼갠다.
func cell(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "|", "\\|"), "\n", " ")
}
