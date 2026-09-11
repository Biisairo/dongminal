#!/usr/bin/env bash
#
# 오류 카탈로그 대조 (ERROR_CONTRACT_SRS FR-ERR-11 · M5 `G6-2`).
#
# `docs/external/errors.md` 는 **생성물**이다. 원천은
# `internal/webserver/apierr/codes_doc.go` 이고, 어긋나면 여기서 멎는다.
#
# 왜: 착수 시 코드 47개 중 문서에 있던 것이 **7개**였다. 손으로 적은 문서는
# 조용히 낡는다 — 코드를 더한 사람은 문서를 고칠 이유가 없고, 고치지 않아도
# 아무 일도 일어나지 않았다. 생성물이면 그 선택지가 사라진다.
#
# 사용: scripts/check-error-docs.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec go run ./scripts/gen-errors -check
