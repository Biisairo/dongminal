# Rust 의 시험 전용 소스 파일을 한 줄에 하나씩 낸다 (Go 의 `*_test.go` 자리, GO_REMOVAL_SRS 3.1.4).
#
#   perl scripts/lib/rs-test-files.pl <디렉터리>
#
# 시험 전용으로 치는 것:
#   - crate 의 tests/·benches/ 아래 파일
#   - 이름이 tests.rs 인 파일
#   - `#[cfg(test)]`·`#[cfg(all(test, …))]` 로 붙인 `mod x;` 가
#     가리키는 파일(x.rs·x/mod.rs)과 그 모듈 디렉터리 x/ 아래 전부
# 파일 안의 인라인 `#[cfg(test)] mod x { … }` 는 "<파일>:<첫 줄>-<끝 줄>" 로 낸다.
use strict;
use warnings;
use File::Find;
use File::Basename qw(dirname basename);

my $root = shift @ARGV // 'rust/crates';
my @files;
find({ no_chdir => 1, wanted => sub {
  if (-d $_ && basename($_) eq 'target') { $File::Find::prune = 1; return; }
  push @files, $_ if /\.rs$/;
}}, $root);

my %test;
my @dirs;
my @ranges;
for my $f (@files) {
  $test{$f} = 1 if $f =~ m{/(tests|benches)/} || basename($f) eq 'tests.rs';
  open my $h, '<', $f or next;
  local $/;
  my $s = <$h>;
  while ($s =~ /#\[cfg\(((?:[^()]++|\((?1)\))*)\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*([;{])/g) {
    my ($cfg, $m, $kind, $at0, $end0) = ($1, $2, $3, $-[0], $+[0]);
    next unless $cfg =~ /^\s*test\s*$/ || ($cfg =~ /^\s*all\(/ && $cfg =~ /\btest\b/ && $cfg !~ /not\(\s*test/);
    if ($kind eq '{') {
      my ($at, $i, $depth, $n) = ($at0, $end0, 1, length $s);
      while ($i < $n && $depth > 0) {
        my $c = substr($s, $i, 1);
        if ($c eq '/' && substr($s, $i, 2) eq '//') { my $e = index($s, "\n", $i); $i = $e < 0 ? $n : $e; next; }
        if ($c eq '"') { $i++; while ($i < $n && substr($s, $i, 1) ne '"') { $i++ if substr($s, $i, 1) eq '\\'; $i++; } $i++; next; }
        if ($c eq "'" && substr($s, $i, 3) =~ /^'(\\.|[^\\'])'/) { $i += length($&); next; }
        $depth++ if $c eq '{';
        $depth-- if $c eq '}';
        $i++;
      }
      my $l0 = (substr($s, 0, $at) =~ tr/\n//) + 1;
      my $l1 = (substr($s, 0, $i) =~ tr/\n//) + 1;
      push @ranges, "$f:$l0-$l1";
      next;
    }
    next unless $cfg =~ /^\s*test\s*$/ || ($cfg =~ /^\s*all\(/ && $cfg =~ /\btest\b/ && $cfg !~ /not\(\s*test/);
    my $b = basename($f);
    my $base = ($b =~ /^(mod|lib|main)\.rs$/) ? dirname($f) : dirname($f) . '/' . ($b =~ s/\.rs$//r);
    $test{"$base/$m.rs"} = 1;
    $test{"$base/$m/mod.rs"} = 1;
    push @dirs, "$base/$m/";
  }
}
for my $f (@files) {
  for my $d (@dirs) { $test{$f} = 1 if index($f, $d) == 0; }
}
print "$_\n" for sort grep { -f $_ } keys %test;
print "$_\n" for @ranges;
