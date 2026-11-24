# 사용: rust/scripts/hermetic.sh python3 tools/gen_fixture.py <go-ref 바이너리> testdata/helper_scenarios.jsonl
# hermetic.sh 아래에서 돈다. Go 참조 바이너리로 헬퍼 시나리오 입력의 출력을 기록한다.
import json, os, subprocess, sys, tempfile
go = sys.argv[1]; out = sys.argv[2]
home = os.environ['OTTERMINAL_HOME']
assert '/otter-hermetic' in home, home
os.makedirs(os.path.join(home, 'run'), exist_ok=True)
# 네트워크 단계까지 가더라도 운영 포트가 아니라 닫힌 높은 포트로 간다.
open(os.path.join(home, 'run', 'server.addr'), 'w').write('127.0.0.1:65431\n')
cases = {
 'otterctl': [[],['--help'],['-h'],['help'],['bogus'],['bogus','--force'],['new-tab','--help'],['new-tab','--no-such-flag'],
   ['new-tab','--at'],['new-tab','--name='],['new-tab','--group','W1.P1.T1'],['new-tab','--force'],
   ['close-tab','--force','--background'],['split-h','1'],['read-screen','--bytes'],['read-screen','--no-such-flag'],
   ['send-input','--no-such-flag'],['msg','--no-such-flag'],['status','--no-such-flag'],['wait','--no-such-flag'],
   ['list-workspace','--no-such-flag'],['who-am-i','--no-such-flag'],['chat-mcp','--help'],
   ['run'],['run','--help'],['run','-h'],['run','bogus'],['run','start','--no-such-flag'],['run','start','--objective'],
   ['edge'],['edge','help'],['edge','--help'],['edge','bogus'],['edge','invite','--addr'],
   ['account'],['account','--help'],['account','bogus']],
 'edit': [[],['--help'],['-h']],
 'download': [['some/file.txt']],
 'detach': [['--help'],['-h'],['--no-such-flag'],['--restore'],['--cwd','x'],['--at','x'],['--list','--run','y'],['positional']],
 'open-url': [[],['--help'],['-h'],['a','b']],
}
bindir = tempfile.mkdtemp(); cwd = tempfile.mkdtemp()
cwd_real = os.path.realpath(cwd)
rows = []
for argv0, lst in cases.items():
    link = os.path.join(bindir, argv0)
    if not os.path.exists(link): os.symlink(go, link)
    for args in lst:
        p = subprocess.run([link] + args, cwd=cwd_real, capture_output=True, timeout=20)
        rows.append({'argv0': argv0, 'args': args, 'code': p.returncode,
                     'stdout': p.stdout.decode().replace(cwd_real, 'CWD'),
                     'stderr': p.stderr.decode().replace(cwd_real, 'CWD')})
with open(out, 'w') as f:
    for r in rows: f.write(json.dumps(r, ensure_ascii=False) + '\n')
print(len(rows), 'rows')
