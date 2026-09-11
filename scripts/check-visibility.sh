#!/usr/bin/env bash
#
# 숨김의 어휘 (UI_LAYOUT_DEFAULTS_SRS FR-LAY-30).
#
# 극성이 둘이고 어휘도 둘이다.
#
#   있으면 보임 → `.vis`
#   있으면 숨김 → `[hidden]`  ← `display:none` 은 style.css 의 **한 자리**에서 온다
#
# 착수 시 어휘가 **일곱**이었다 — `.vis`·`[hidden]`·`.hidden`·`.off`·`.gone`·
# `.git-hidden`·`.visible`. 그중 `.git-hidden` 은 git 과 아무 관계 없는 버튼
# (`slot-add`·`slot-remove`)에 붙어 있었다. 어휘가 여럿이면 이름이 뜻을 말하지
# 못한다.
#
# `[hidden]` 의 UA 기본 `display:none` 은 **작성자 규칙에 진다.** 그래서 네 자리가
# 각자 `X[hidden]{display:none}` 을 되돌려 적고 있었고, `style.css` 의 주석이 그
# 함정을 이미 적고 있었다. 지금은 한 자리의 `!important` 가 그것을 대신한다.
#
# 사용: scripts/check-visibility.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
숨김 어휘 검사

  1) `[hidden]` 에 display 를 선언하는 규칙이 style.css 의 한 자리뿐이다.
  2) 숨김 어휘(.hidden·.off·.gone·.git-hidden)가 **display 를 다루는** 규칙에
     없다. `#boot.gone{opacity:0}` 처럼 전이(transition)인 것은 대상이 아니다 —
     `display:none` 으로 바꾸면 전이가 죽는다 (FR-LAY-6).
  3) JS 가 그 어휘를 classList 로 다루지 않는다. 숨김은 `el.hidden` 이다.

  "있으면 보임" 의 `.vis` 는 그대로 쓴다 (FR-LAY-5) — 이관의 근거가 없다.
USAGE
  exit 0
fi

fail=0
CANON='web/style.css'
WORDS='hidden|off|gone|git-hidden'

# (1) `[hidden]` 의 display 를 되돌려 적는 자리
hits=$(grep -nE '\[hidden\][^{]*\{[^}]*display' web/*.css | grep -v "^$CANON:" || true)
if [[ -n "$hits" ]]; then
  echo "✗ [hidden] 의 display 를 되돌려 적었다 — $CANON 의 한 자리가 !important 로 한다 (FR-LAY-1·2)" >&2
  echo "$hits" >&2
  fail=1
fi
n=$(grep -cE '^\[hidden\]\{display:none!important\}$' "$CANON" || true)
if [[ "$n" != "1" ]]; then
  echo "✗ $CANON 에 정본 규칙 [hidden]{display:none!important} 이 정확히 하나여야 한다 (지금 $n) (FR-LAY-1)" >&2
  fail=1
fi

# (2) 숨김 어휘가 display 를 다루는 규칙
hits=$(grep -nE "\.($WORDS)([^-a-zA-Z0-9_]|$)[^{]*\{[^}]*display" web/*.css || true)
if [[ -n "$hits" ]]; then
  echo "✗ 숨김 어휘가 display 를 다룬다 — 숨김은 [hidden] 하나다 (FR-LAY-3)" >&2
  echo "$hits" >&2
  fail=1
fi

# (3) **이름 없이 잡는 구조 규칙.** 규칙의 *주체*(마지막 compound selector)가
# 클래스로 `display:none` 을 켜면 그것이 곧 새 숨김 어휘다 — 이름을 모르는 채로
# 잡는다. 앞으로 누가 `.newhide{...}` 를 만들어도 여기 걸린다.
#
# 통과해야 하는 것들:
#   `.x{display:none}`            `.vis` 규약의 기본 — 주체의 클래스가 하나다
#   `body.mobile .sh{...}`        조건부 문맥 — 클래스가 주체에 없다 (FR-LAY-6)
#   `.git-blame.vis{display:flex}` display 가 none 이 아니다
#   `#boot.gone{opacity:0}`       display 를 다루지 않는다 (전이)
#
# **JS 를 보지 않는다.** 보려 했다가 `boot-screen.js` 의 `.gone`(페이드)을
# 오탐했다 — 진실은 CSS 에 있고, CSS 가 display 로 숨기지 않으면 그 클래스를
# JS 가 어떻게 다루든 이 규약의 대상이 아니다.
hits=$(for f in web/*.css; do
  perl -0777 -ne '
    s{(/\*.*?\*/)}{ my $c=$1; $c =~ s/[^\n]/ /g; $c }gse;
    while (/([^{}]*)\{([^}]*)\}/gs) {
      my ($sel,$body,$whole) = ($1,$2,$&);
      next unless $body =~ /(^|;)\s*display\s*:\s*none/;
      my $line = 1 + (substr($_,0,pos($_)-length($whole)) =~ tr/\n//);
      for my $one (split /,/, $sel) {
        $one =~ s/\s+/ /g; $one =~ s/^ | $//g;
        next unless length $one;
        # 주체 = 마지막 결합자 뒤의 compound
        my $subj = $one; $subj =~ s/.*[ >+~]//;
        my $n = () = ($subj =~ /\./g);
        print "$ARGV:$line: $one\n" if $n >= 2;
      }
    }
  ' "$f"
done)
if [[ -n "$hits" ]]; then
  echo "✗ 클래스로 display:none 을 켠다 — 그것이 새 숨김 어휘다. [hidden] 을 쓴다 (FR-LAY-3)" >&2
  echo "$hits" >&2
  fail=1
fi

# (4) **검사도 같은 어휘를 쓴다** (2026-09-11 추가).
#
# 이 게이트는 `web/` 만 보았고 `e2e/` 는 범위 밖이었다. 그래서 FR-LAY-3 의 이관
# (`.gone`·`.git-hidden` → `[hidden]`)에 검사가 따라오지 않은 채 남았고, **기준선
# 실패 여섯**이 거기서 나왔다 — terminal 의 검색 둘 · focus · editor-tab E17 ·
# git-remote R19 · git-ui-revision 둘 · git-discard-all. 그 실패들은 "흔들림" 으로
# 적혀 쫓지 말라고 문서에 남아 있었다.
#
# 숨김을 재는 방법은 하나다: `toBeHidden()` · `toBeVisible()` · `[hidden]`.
hits=$(grep -nE "toHaveClass\(/($WORDS)/\)|:not\(\.($WORDS)\)|classList\.contains\('($WORDS)'\)" e2e/*.ts || true)
if [[ -n "$hits" ]]; then
  echo "✗ 검사가 숨김을 클래스로 잰다 — 제품은 [hidden] 이다. toBeHidden()·toBeVisible()·[hidden] 을 쓴다 (FR-LAY-3·30)" >&2
  echo "$hits" >&2
  fail=1
fi

if [[ $fail -ne 0 ]]; then exit 1; fi
echo "✓ 숨김의 어휘가 둘이다 — .vis(보임) · [hidden](숨김, 정본 1자리) · 검사도 같다 (FR-LAY-30)"
