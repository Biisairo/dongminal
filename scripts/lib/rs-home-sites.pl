# 홈(또는 data_dir) 아래에 경로를 만드는 자리의 첫 조각을 낸다 (GO_REMOVAL_SRS G-24).
#
#   perl scripts/lib/rs-home-sites.pl <파일...>
#
# 출력: "<파일>:<줄>:<토큰>". Go 판 `filepath.Join(home|x.home|cfg.DataDir|opts.DataDir, X)` 의
# 자리이며, Rust 에서는 두 꼴이다:
#   <…home|data_dir>[(…)].join(X)
#   filepath::join(&[<…home|data_dir>[(…)][.as_str()], X, …])
use strict;
use warnings;

my $HOME = qr/&?(?:self\.)?(?:[a-z_]+\.)*(?:home|data_dir)(?:\([^()]*\))?(?:\.as_str\(\)|\.as_ref\(\)|\.clone\(\))?/;
my $TOK  = qr/"[^"]*"|&?[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/;
local $/;
for my $f (@ARGV) {
  open my $h, '<', $f or next;
  my $s = <$h>;
  while ($s =~ /(?<![\w.)])($HOME)\s*\.join\(\s*($TOK)\s*[,)]|\bfilepath::join\(\s*&\[\s*($HOME)\s*,\s*($TOK)\s*[,\]]/g) {
    my $tok = defined $2 ? $2 : $4;
    my $at = $-[0];
    my $ls = rindex($s, "\n", $at) + 1;
    next if substr($s, $ls, $at - $ls) =~ m{^\s*(//|\*|/\*)};
    my $ln = (substr($s, 0, $at) =~ tr/\n//) + 1;
    print "$f:$ln:$tok\n";
  }
}
