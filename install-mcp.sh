#!/bin/sh
# dongminal MCP 를 Claude Code 에 등록
# 사용법:
#   ./install-mcp.sh               # 기본 포트(8080) 로 등록
#   PORT=58146 ./install-mcp.sh    # 다른 포트로 등록
#   ./install-mcp.sh uninstall     # 등록 해제

set -e

PORT="${PORT:-8080}"
NAME="dongminal"
URL="http://localhost:${PORT}/mcp/sse"
SCOPE="user"   # user 스코프: 모든 프로젝트에서 공용

CMD="${1:-install}"

have_claude() {
  command -v claude >/dev/null 2>&1
}

usage() {
  cat <<EOF
dongminal MCP 설치기 (Claude Code)

사용법:
  ./install-mcp.sh [install]   MCP 등록 (기본)
  ./install-mcp.sh uninstall   MCP 해제
  ./install-mcp.sh status      등록 상태 확인
  PORT=58146 ./install-mcp.sh  다른 포트 지정

현재 설정:
  이름  : ${NAME}
  URL   : ${URL}
  스코프: ${SCOPE}
EOF
}

case "$CMD" in
  -h|--help|help)
    usage
    exit 0
    ;;

  install)
    if ! have_claude; then
      echo "✗ claude CLI 가 설치되어 있지 않습니다."
      echo "  Claude Code 설치 후 다시 시도하세요."
      echo ""
      echo "수동 등록: ~/.claude.json 또는 .mcp.json 에 다음 추가"
      cat <<EOF

  "mcpServers": {
    "${NAME}": {
      "type": "sse",
      "url": "${URL}"
    }
  }

EOF
      exit 1
    fi

    # 기존 등록 제거 (있으면 조용히)
    claude mcp remove "$NAME" -s "$SCOPE" >/dev/null 2>&1 || true

    # SSE 전송으로 신규 등록
    echo "→ ${NAME} 등록 중 (URL=${URL}, scope=${SCOPE})"
    if claude mcp add --transport sse -s "$SCOPE" "$NAME" "$URL"; then
      echo "✓ 등록 완료"
    else
      echo "✗ claude mcp add 실패"
      echo "  claude CLI 버전이 SSE 전송을 지원하는지 확인하세요 (claude --version)"
      exit 1
    fi

    echo ""
    echo "확인:"
    claude mcp list 2>/dev/null | grep -E "^${NAME}" || true
    echo ""
    echo "사용 방법:"
    echo "  1) dongminal 서버 실행 중인지 확인 (PORT=${PORT})"
    echo "  2) Claude Code 새 세션에서 /mcp 로 연결 확인"
    echo "  3) 하단바 '📍 S1.P2.T3' 라벨을 Claude 에 알려주고 명령"
    ;;

  uninstall|remove)
    if ! have_claude; then
      echo "✗ claude CLI 없음"
      exit 1
    fi
    if claude mcp remove "$NAME" -s "$SCOPE" 2>/dev/null; then
      echo "✓ ${NAME} 제거 완료"
    else
      echo "ℹ ${NAME} 이 등록되어 있지 않음"
    fi
    ;;

  status|ls|list)
    if ! have_claude; then
      echo "✗ claude CLI 없음"
      exit 1
    fi
    claude mcp list
    ;;

  *)
    echo "알 수 없는 명령: $CMD"
    echo ""
    usage
    exit 1
    ;;
esac
