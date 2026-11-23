# Rust 의 문자열 상수 이름을 값으로 푼다 (GO_REMOVAL_SRS G-24·G-25 의 게이트가 쓴다).
#
#   printf '<파일>\t<토큰>\n' … | perl scripts/lib/rs-const.pl [crates 뿌리]
#
# 토큰은 `"리터럴"`, `NAME`, `경로::NAME`(`dmenv::X`·`dm_shared_runfile::FILE_NAME`·
# `crate::X`·`self::X`·`super::X`) 이다. 앞의 `&` 는 무시한다.
# 출력: 입력 한 줄마다 "<파일>\t=<값>" 또는 풀지 못하면 "<파일>\t?<토큰>".
#
# 푸는 순서: `use dm_x as y;`·`use dm_x::{self as y}` 별칭 → crate 이름(dm_*) → 그 crate 의 src 에서
# `const NAME: &str = …;`(pub 무엇이든) 를 찾고, 값이 다시 이름이면 그 정의 파일 기준으로
# 이어서 푼다(4단계까지). 맨 이름은 같은 파일 → 같은 crate → `use dm_x::{…NAME…}` 순서로 찾는다.
# 값에 `/` 가 있거나 `~` 로 시작하면 홈 아래 첫 조각이 아니므로 푼 것으로 치지 않는다.
use strict;
use warnings;
use File::Find;
use File::Basename qw(dirname);

my $root = shift @ARGV // 'rust/crates';
my (%crate_dir, %src_cache);
find({ no_chdir => 1, wanted => sub {
  if (-d $_ && $_ =~ m{/target$}) { $File::Find::prune = 1; return; }
  return unless m{/Cargo\.toml$};
  open my $h, '<', $_ or return;
  while (<$h>) { if (/^name\s*=\s*"([^"]+)"/) { (my $n = $1) =~ tr/-/_/; $crate_dir{$n} = dirname($File::Find::name); last; } }
}}, $root);

sub slurp { my $f = shift; return $src_cache{$f} //= do { local $/; open my $h, '<', $f or return ''; <$h> // '' }; }

sub crate_of {
  my $f = shift;
  my $d = dirname($f);
  while ($d =~ m{/}) { return $d if -f "$d/Cargo.toml"; $d = dirname($d); }
  return $d;
}

sub rs_files {
  my $dir = shift;
  my @out;
  find({ no_chdir => 1, wanted => sub { push @out, $_ if /\.rs$/ } }, "$dir/src") if -d "$dir/src";
  return sort @out;
}

sub find_const {
  my ($name, @files) = @_;
  for my $f (@files) {
    my $s = slurp($f);
    return ($1, $f) if $s =~ /\bconst\s+\Q$name\E\s*:\s*&(?:'static\s+)?str\s*=\s*([^;]+?)\s*;/s;
  }
  return;
}

sub resolve {
  my ($file, $tok) = @_;
  for (1 .. 4) {
    $tok =~ s/^&//;
    $tok =~ s/\s+//g;
    if ($tok =~ /^"([^"]*)"$/) {
      my $v = $1;
      return if $v =~ m{/} || $v =~ /^~/;
      return "=$v";
    }
    return unless $tok =~ /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/;
    my @seg = split /::/, $tok;
    my $name = pop @seg;
    my ($v, $at);
    if (!@seg) {
      ($v, $at) = find_const($name, $file);
      ($v, $at) = find_const($name, rs_files(crate_of($file))) unless defined $v;
      # `use dm_x::NAME;`·`use dm_x::{…, NAME, …};` 로 들여온 이름
      if (!defined $v) {
        my $s = slurp($file);
        if ($s =~ /\buse\s+([a-z_][a-z0-9_]*)(?:::[A-Za-z_][A-Za-z0-9_]*)*::(?:\Q$name\E\s*;|\{[^}]*\b\Q$name\E\b[^}]*\})/s) {
          my $dir = $crate_dir{$1};
          ($v, $at) = find_const($name, rs_files($dir)) if $dir;
        }
      }
    } else {
      my $head = $seg[0];
      my $dir;
      if ($head =~ /^(crate|self|super)$/) {
        $dir = crate_of($file);
      } else {
        my $s = slurp($file);
        my $crate = $s =~ /\buse\s+([a-z_][a-z0-9_]*)\s+as\s+\Q$head\E\s*;/ ? $1
                  : $s =~ /\buse\s+([a-z_][a-z0-9_]*)::\{[^}]*\bself\s+as\s+\Q$head\E\b/s ? $1
                  : $head;
        $dir = $crate_dir{$crate};
      }
      return unless $dir;
      ($v, $at) = find_const($name, rs_files($dir));
    }
    return unless defined $v;
    ($file, $tok) = ($at, $v);
  }
  return;
}

while (my $line = <STDIN>) {
  chomp $line;
  my ($f, $tok) = split /\t/, $line, 2;
  next unless defined $tok;
  my $r = resolve($f, $tok);
  print "$f\t", (defined $r ? $r : "?$tok"), "\n";
}
