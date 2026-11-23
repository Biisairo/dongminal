//! Go `os.ProcessState.String()` 의 문구 (`exit status N`·`signal: segmentation fault`·…).
//!
//! 대기 상태(wait status)의 해석과 신호 이름은 OS 마다 다르다. Go 1.27.2 의
//! `syscall.WaitStatus`(syscall_bsd.go·syscall_linux.go)와 `zerrors_<os>_*.go` 의 `signals`
//! 표를 그대로 옮긴다. 표는 어느 호스트에서도 시험할 수 있게 OS 와 무관하게 둔다.

/// 대기 상태를 해석하는 규칙의 갈래다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitOs {
    Darwin,
    Linux,
}

const SIGSTOP_DARWIN: u32 = 17;
const SIGTRAP: u32 = 5;
const MASK: u32 = 0x7F;
const CORE: u32 = 0x80;
const STOPPED: u32 = 0x7F;
const SHIFT: u32 = 8;
/// Windows 는 이 값 이상의 종료 코드를 16진수로 적는다 (Go `uint(code) >= 1<<16`).
const WINDOWS_HEX_FROM: u32 = 1 << 16;

const DARWIN_SIGNALS: [&str; 32] = [
    "",
    "hangup",
    "interrupt",
    "quit",
    "illegal instruction",
    "trace/BPT trap",
    "abort trap",
    "EMT trap",
    "floating point exception",
    "killed",
    "bus error",
    "segmentation fault",
    "bad system call",
    "broken pipe",
    "alarm clock",
    "terminated",
    "urgent I/O condition",
    "suspended (signal)",
    "suspended",
    "continued",
    "child exited",
    "stopped (tty input)",
    "stopped (tty output)",
    "I/O possible",
    "cputime limit exceeded",
    "filesize limit exceeded",
    "virtual timer expired",
    "profiling timer expired",
    "window size changes",
    "information request",
    "user defined signal 1",
    "user defined signal 2",
];

const LINUX_SIGNALS: [&str; 32] = [
    "",
    "hangup",
    "interrupt",
    "quit",
    "illegal instruction",
    "trace/breakpoint trap",
    "aborted",
    "bus error",
    "floating point exception",
    "killed",
    "user defined signal 1",
    "segmentation fault",
    "user defined signal 2",
    "broken pipe",
    "alarm clock",
    "terminated",
    "stack fault",
    "child exited",
    "continued",
    "stopped (signal)",
    "stopped",
    "stopped (tty input)",
    "stopped (tty output)",
    "urgent I/O condition",
    "CPU time limit exceeded",
    "file size limit exceeded",
    "virtual timer expired",
    "profiling timer expired",
    "window changed",
    "I/O possible",
    "power failure",
    "bad system call",
];

/// Go `syscall.Signal.String()`: 표에 있으면 그 이름, 없으면 `signal N`.
pub fn signal_name(os: WaitOs, sig: i64) -> String {
    let table: &[&str] = match os {
        WaitOs::Darwin => &DARWIN_SIGNALS,
        WaitOs::Linux => &LINUX_SIGNALS,
    };
    match usize::try_from(sig).ok().and_then(|i| table.get(i)) {
        Some(s) if !s.is_empty() => (*s).to_owned(),
        _ => format!("signal {sig}"),
    }
}

/// Go `ProcessState.String()` (POSIX): `raw` 는 wait(2) 가 준 상태 그대로다.
pub fn wait_status_text(os: WaitOs, raw: u32) -> String {
    let low = raw & MASK;
    let hi = raw >> SHIFT;
    let exited = low == 0;
    let signaled = low != STOPPED && low != 0;
    let (stopped, continued) = match os {
        WaitOs::Darwin => (
            low == STOPPED && hi != SIGSTOP_DARWIN,
            low == STOPPED && hi == SIGSTOP_DARWIN,
        ),
        WaitOs::Linux => (raw & 0xFF == STOPPED, raw == 0xFFFF),
    };
    let mut res = if exited {
        let code = match os {
            WaitOs::Darwin => hi,
            WaitOs::Linux => hi & 0xFF,
        };
        format!("exit status {code}")
    } else if signaled {
        format!("signal: {}", signal_name(os, i64::from(low)))
    } else if stopped {
        let sig = hi & 0xFF;
        let mut s = format!("stop signal: {}", signal_name(os, i64::from(sig)));
        // darwin 의 TrapCause 는 늘 -1 이다.
        if os == WaitOs::Linux && sig == SIGTRAP && hi >> 8 != 0 {
            s.push_str(&format!(" (trap {})", hi >> 8));
        }
        s
    } else if continued {
        "continued".to_owned()
    } else {
        String::new()
    };
    if signaled && raw & CORE != 0 {
        res.push_str(" (core dumped)");
    }
    res
}

/// Go `ProcessState.String()` (Windows): 큰 코드는 16진수다.
pub fn windows_exit_text(code: u32) -> String {
    if code >= WINDOWS_HEX_FROM {
        format!("exit status 0x{code:x}")
    } else {
        format!("exit status {code}")
    }
}

#[cfg(test)]
mod tests;
