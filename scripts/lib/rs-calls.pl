# Rust 소스에서 함수 호출을 찾아 한 줄씩 낸다 (GO_REMOVAL_SRS G-19·G-21·G-23 의 게이트가 쓴다).
#
#   perl scripts/lib/rs-calls.pl <함수 이름 정규식> <파일...>
#
# 출력: "<파일>:<줄>: <이름>(<인자들>)" — rustfmt 가 여러 줄로 나눈 인자를 공백 하나로 접는다.
# 괄호는 짝을 맞춰 읽는다. 주석 줄(//, *, /*)에서 시작한 호출은 건너뛴다.
use strict;
use warnings;

my $fn = shift @ARGV;
local $/;
for my $f (@ARGV) {
  open my $h, '<', $f or next;
  my $s = <$h>;
  while ($s =~ /\b((?:$fn))\s*\(((?:[^()]++|\((?2)\))*)\)/g) {
    my ($name, $a, $at) = ($1, $2, $-[0]);
    my $ls = rindex($s, "\n", $at) + 1;
    next if substr($s, $ls, $at - $ls) =~ m{^\s*(//|\*|/\*)};
    my $ln = (substr($s, 0, $at) =~ tr/\n//) + 1;
    $a =~ s/\s+/ /g;
    $a =~ s/^ | $//g;
    print "$f:$ln: $name($a)\n";
  }
}
