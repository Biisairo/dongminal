#!/usr/bin/env bash
#
# 골격 배치의 규약 (UI_LAYOUT_DEFAULTS_SRS FR-LAY-32).
#
# "칸을 가득 채우는 골격" 은 `position:absolute` 와 `inset:0` **둘 다**로
# 성립한다. 한쪽만 적으면 그 요소는 골격이 아니게 되고, 그 사실이 이름에는
# 드러나지 않는다.
#
# **담는 쪽이 위치 기준인지는 이 검사가 볼 수 없다** — 그것은 DOM 부모 관계이고
# CSS 만으로 판정할 수 없다 (SRS §2.4). 실측에서 어긋난 자리는 **하나도 없었고**,
# style-editor.css 의 두 주석은 그 함정을 *겪고 고친* 기록이다. 그러므로 이
# 검사는 **선언 형태**만 본다 — 갈라 적으면 한쪽만 고쳐진다.
#
# 사용: scripts/check-skeleton.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
골격 배치 검사

  `inset:0` 을 선언한 규칙마다 같은 규칙 안에 `position:absolute`(또는 fixed)가
  있는지 본다. 없으면 그 `inset` 은 아무 일도 하지 않는다 — static 요소의
  `top/right/bottom/left` 는 무시되기 때문이고, 그것은 조용한 결함이다.

  담는 쪽의 위치 기준은 이 검사가 볼 수 없다 (SRS §2.4). 필요해지면 e2e 로 옮긴다.
USAGE
  exit 0
fi

# CSS 를 규칙 단위로 훑는다 — 주석을 지우고, 규칙마다 한 줄로 편다.
# (0) **주석이 닫혔는가.** 이것을 먼저 본다 — 닫히지 않은 `/*` 뒤의 규칙은
# 브라우저가 조용히 삼키고, 아래 검사도 그 구간을 보지 못한다.
#
# 실제로 있었다: `style.css:1419` 가 `*/` 를 잃은 중복 붙여넣기였고(그 설명은
# `:1375` 에 이미 있었다), 파일 끝이라 잃는 것이 없어 아무도 몰랐다. 그 뒤에
# 규칙을 하나만 더 붙이면 그것이 사라졌을 것이다.
bad=""
for f in web/*.css; do
  o=$(grep -o '/\*' "$f" | wc -l | tr -d ' ')
  c=$(grep -o '\*/' "$f" | wc -l | tr -d ' ')
  [[ "$o" != "$c" ]] && bad="$bad$f  /*=$o  */=$c"$'\n'
done
if [[ -n "$bad" ]]; then
  echo "✗ 주석이 닫히지 않았다 — 그 뒤의 규칙은 브라우저가 삼킨다 (FR-LAY-32)" >&2
  printf '%s' "$bad" >&2
  exit 1
fi

report=$(for f in web/*.css; do
  perl -0777 -ne '
    # 주석을 **같은 길이의 공백으로** 바꾼다 — 지우면 offset 이 밀려 줄 번호가
    # 어긋나고, 실패 문구가 자리를 못 가리키면 게이트는 절반만 쓸모 있다.
    s{(/\*.*?\*/)}{ my $c=$1; $c =~ s/[^\n]/ /g; $c }gse;
    while (/([^{}]*)\{([^}]*)\}/gs) {
      my ($sel,$body,$whole) = ($1,$2,$&);
      next unless $body =~ /(^|;)\s*inset\s*:\s*0/;
      next if $body =~ /position\s*:\s*(absolute|fixed|sticky)/;
      # `pos()` 와 `length($&)` 로 시작 offset 을 낸다. `tr` 은 @-·pos 를
      # 건드리지 않으므로 while 루프의 상태가 깨지지 않는다.
      my $start = pos($_) - length($whole);
      my $head  = substr($_, 0, $start);
      my $line  = 1 + ($head =~ tr/\n//);
      # 선택자를 싣지 않는다 — 자리는 줄 번호가 정확히 가리키고, CSS 본문을
      # 그대로 내면 인코딩·주석 잔재가 문구를 오염시킨다 (실측).
      print "$ARGV:$line\n";
    }
  ' "$f"
done)

if [[ -n "$report" ]]; then
  echo "✗ inset:0 인데 같은 규칙에 position 이 없다 — 그 inset 은 무시된다 (FR-LAY-32)" >&2
  echo "$report" >&2
  exit 1
fi

n=$(grep -c 'inset:0' web/*.css | awk -F: '{s+=$2} END{print s}')
echo "✓ 골격의 inset:0 ${n}자리가 전부 같은 규칙에 position 을 갖는다 (FR-LAY-32)"
