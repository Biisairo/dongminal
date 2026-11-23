# Rust 함수 본문을 낸다 (GO_REMOVAL_SRS G-21·G-23 의 게이트가 쓴다).
#
#   perl scripts/lib/rs-fn-body.pl <함수 이름> <파일...>
#
# `fn <이름>` 의 선언부터 중괄호 짝이 닫히는 곳까지를 그대로 낸다. 같은 이름이 여럿이면
# 모두 낸다. 없으면 아무것도 내지 않는다. 문자열·주석 안의 중괄호는 가려 읽는다.
use strict;
use warnings;

my $name = shift @ARGV;
local $/;
for my $f (@ARGV) {
  open my $h, '<', $f or next;
  my $s = <$h>;
  while ($s =~ /\bfn\s+\Q$name\E\b[^{;]*\{/g) {
    my $start = $-[0];
    my $i = $+[0];
    my $depth = 1;
    my $n = length $s;
    while ($i < $n && $depth > 0) {
      my $c = substr($s, $i, 1);
      if ($c eq '/' && substr($s, $i, 2) eq '//') { my $e = index($s, "\n", $i); $i = $e < 0 ? $n : $e; next; }
      if ($c eq '"') { $i++; while ($i < $n && substr($s, $i, 1) ne '"') { $i++ if substr($s, $i, 1) eq '\\'; $i++; } $i++; next; }
      if ($c eq "'" && substr($s, $i, 3) =~ /^'(\\.|[^\\'])'/) { $i += length($&); next; }
      $depth++ if $c eq '{';
      $depth-- if $c eq '}';
      $i++;
    }
    print substr($s, $start, $i - $start), "\n";
  }
}
