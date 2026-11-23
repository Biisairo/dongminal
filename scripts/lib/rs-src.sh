# shellcheck shell=bash
# Rust 소스를 훑는 게이트의 공용 도우미 (GO_REMOVAL_SRS 3.1.4). 저장소 뿌리에서 source 한다.
#
#   rs_drop_tests     stdin 의 "경로[:줄:…]" 줄 중 시험 전용 파일의 줄을 뺀다 (Go 의 --exclude='*_test.go')
#   rs_src_files [d…] 시험 전용이 아닌 .rs 파일 목록 (기본 rust/crates)
#
# 시험 전용 파일의 정의는 scripts/lib/rs-test-files.pl 이다.

RS_TEST_FILES=$(perl scripts/lib/rs-test-files.pl rust/crates)

rs_drop_tests() {
  awk -F: 'NR == FNR { t[$0] = 1; next } !($1 in t)' <(printf '%s\n' "$RS_TEST_FILES") -
}

rs_src_files() {
  find "${@:-rust/crates}" -name '*.rs' -not -path '*/target/*' 2>/dev/null | sort | rs_drop_tests
}
