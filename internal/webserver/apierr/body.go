package apierr

import (
	"errors"

	"dongminal/internal/shared/httpreq"
)

// BodyReadCode 는 본문 읽기 실패의 **사유**를 코드로 옮긴다 (SAFETY_CORRECTNESS_SRS FR-SAF-13 ·
// REFACTOR3_DEFECTS_SRS FR-RD3-30). 상한 초과만 `body_too_large`, 나머지는 `bad_request` 다.
//
//	이전: `httpapi` 의 `bodyReadCode` 한 벌뿐이라 toolio·lsp·fs·git 방언은 코드를 상태에서
//	      파생하거나(`too_large`) 늘 `bad_request` 를 냈다
//	새:   방언과 무관하게 이 함수 하나가 정한다
//	이유: 공개 계약(`features.md` 용량 표)이 JSON 본문의 상한 초과를 `body_too_large` 로 적었다
func BodyReadCode(err error) string {
	if errors.Is(err, httpreq.ErrTooLarge) {
		return CodeBodyTooBig
	}
	return CodeBadRequest
}
