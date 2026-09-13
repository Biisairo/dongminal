// fakeagent 바이너리 — e2e 가 `DONGMINAL_AGENT_BIN_DIR` 에 어댑터의 DetectCmd 이름으로
// 놓는다 (M8_UNIFIED_SRS V-12 · D-C-7·9). 제품 바이너리에 들지 않는다.
package main

import (
	"os"

	"dongminal/internal/shared/agentadapter/fakeagent"
)

func main() {
	os.Exit(fakeagent.Main(os.Args[1:], os.Stdin, os.Stdout))
}
