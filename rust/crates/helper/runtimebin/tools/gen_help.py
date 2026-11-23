# helptext.rs 생성기: python3 tools/gen_help.py <repo>/internal/helper/runtimebin > src/helptext.rs
import re, sys, glob, os
D = sys.argv[1]
consts = {
 'dmenv.EnvHome':'DONGMINAL_HOME','serverconf.AddrDir':'run','serverconf.AddrFileName':'server.addr',
 'serverconf.FileName':'server.json','dmenv.DefaultHost':'127.0.0.1','dmenv.DefaultPort':'58146',
 'dmenv.EnvHost':'DONGMINAL_HOST','dmenv.ContainerHost':'host.docker.internal',
 'dmenv.ContainerAddrDir':'/run/dongminal','dmenv.EnvPort':'DONGMINAL_PORT','dmenv.EnvToolID':'DONGMINAL_TOOL_ID',
}
out = []
def snake(n):
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', n)
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1_\2', s)
    return s.upper()
for f in sorted(glob.glob(os.path.join(D,'*.go'))):
    if f.endswith('_test.go'): continue
    src = open(f).read()
    for m in re.finditer(r'^(?:const|\t)\s*(\w+)\s*=\s*(`)', src, re.M):
        name = m.group(1)
        if not re.search(r'[Hh]elp', name): continue
        i = m.end()-1
        parts = []
        while True:
            if src[i] == '`':
                j = src.index('`', i+1); parts.append(src[i+1:j]); i = j+1
            elif src[i] == '"':
                j = i+1
                while src[j] != '"':
                    j += 2 if src[j]=='\\' else 1
                parts.append(bytes(src[i+1:j],'utf8').decode('unicode_escape').encode('latin1').decode('utf8')); i = j+1
            else:
                mm = re.match(r'[\w.]+', src[i:]); key = mm.group(0)
                if key not in consts: raise SystemExit(f'{f}: {name}: unknown {key}')
                parts.append(consts[key]); i += len(key)
            mm = re.match(r'\s*\+\s*', src[i:])
            if not mm: break
            i += mm.end()
        text = ''.join(parts)
        assert '"#' not in text
        out.append((os.path.basename(f), name, text))
print('//! Go 소스의 도움말 상수를 그대로 옮긴 것이다 (바이트 단위로 같아야 한다).\n//! internal/helper/runtimebin 의 상수 연결은 값으로 풀었다.\n\n#![allow(dead_code)]\n')
for f, n, t in out:
    print(f'/// `{n}` ({f})\npub(crate) const {snake(n)}: &str = r#"{t}"#;\n')
