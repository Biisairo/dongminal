# dongminal 셸 훅 (Windows). POSIX 의 posix/bash-hook.sh · posix/zdotdir/.zshrc 와
# 같은 세 가지를 한다 — cwd 통지, claude 래퍼, codex 래퍼.
#
# 모든 정의에 global: 을 붙인다. 이 파일은 `powershell -NoExit -File` 로 실행되고,
# 스크립트 스코프에 정의한 것은 스크립트가 끝나는 순간 사라지기 때문이다.

# ── 인코딩 ────────────────────────────────────────────
# ConPTY 에는 부모가 자식 콘솔의 코드페이지를 정해 줄 방법이 없다. 셸이 스스로
# UTF-8 로 맞추지 않으면 한국어 출력이 깨진다.
try {
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = $utf8
    [Console]::InputEncoding = $utf8
    $global:OutputEncoding = $utf8
    chcp 65001 > $null 2>&1
} catch {
    # 인코딩을 못 바꿔도 셸은 떠야 한다.
}

# ── cwd 통지 ──────────────────────────────────────────
# 매 프롬프트마다 OSC 777 로 현재 디렉터리를 알린다. POSIX 훅의
# _rt_cwd_hook 과 **같은 시퀀스**여야 한다 — 받는 쪽이 하나다.
#
# 기존 prompt 를 보존해 위임한다. oh-my-posh 같은 프롬프트 도구를 쓰는
# 사용자의 화면을 빼앗지 않는다.
if (-not $global:__dongminalPrompt) {
    $global:__dongminalPrompt = $function:prompt
}
function global:prompt {
    try {
        $cwd = (Get-Location).ProviderPath
        if ($cwd) {
            [Console]::Write("$([char]27)]777;Cwd;$cwd$([char]7)")
        }
    } catch {
        # 통지 실패는 프롬프트를 막지 않는다.
    }
    if ($global:__dongminalPrompt) { & $global:__dongminalPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
}

# ── 에이전트 래퍼 ─────────────────────────────────────
# 에이전트 완료/대기 알림 훅(--settings)과 오케스트레이션 스킬(--plugin-dir)을
# per-invocation 으로 주입한다. 에이전트의 설정 파일을 영구 수정하지 않으며
# dongminal 이 띄운 도구 안에서만 적용된다.
#
# 실행 파일은 Get-Command -CommandType Application 으로 찾는다. 같은 이름의
# 함수(이 래퍼 자신)를 다시 부르지 않기 위해서다 — bash 의 `command claude`
# 에 해당한다. npm 이 설치한 claude.cmd 처럼 .exe 가 아닌 경우도 이렇게 잡힌다.
function global:__dongminalApp($name) {
    return Get-Command $name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function global:claude {
    $app = __dongminalApp 'claude'
    if (-not $app) { Write-Error 'claude 를 찾을 수 없습니다'; return }
    $extra = @()
    if ($env:DONGMINAL_HOME) {
        $settings = Join-Path $env:DONGMINAL_HOME 'bin\agent-hooks\claude.json'
        $plugin = Join-Path $env:DONGMINAL_HOME 'bin\agent-plugin'
        if (Test-Path $settings) { $extra += @('--settings', $settings) }
        if (Test-Path $plugin) { $extra += @('--plugin-dir', $plugin) }
    }
    & $app.Source @extra @args
}

function global:codex {
    $app = __dongminalApp 'codex'
    if (-not $app) { Write-Error 'codex 를 찾을 수 없습니다'; return }
    if (-not $env:DONGMINAL_HOME) { & $app.Source @args; return }
    $dmctl = Join-Path $env:DONGMINAL_HOME 'bin\dmctl.exe'
    # notify 는 JSON 배열이다. 경로의 역슬래시는 JSON 에서 이스케이프해야 한다.
    $json = ConvertTo-Json -Compress @($dmctl, 'notify', 'codex')
    & $app.Source -c "notify=$json" @args
}
