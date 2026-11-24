//! Go `syscall.Errno.Error()` (syscall_windows.go) 의 FormatMessage 호출.

use windows_sys::Win32::System::Diagnostics::Debug::{
    FORMAT_MESSAGE_ARGUMENT_ARRAY, FORMAT_MESSAGE_FROM_SYSTEM, FORMAT_MESSAGE_IGNORE_INSERTS,
    FormatMessageW,
};

/// Go 의 버퍼 크기(`make([]uint16, 300)`).
const BUF_LEN: usize = 300;
/// Go `langid(LANG_ENGLISH, SUBLANG_ENGLISH_US)`.
const LANG_ENGLISH_US: u32 = (0x01 << 10) | 0x09;

fn format_message(code: u32, lang: u32, buf: &mut [u16; BUF_LEN]) -> Option<usize> {
    let flags =
        FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_ARGUMENT_ARRAY | FORMAT_MESSAGE_IGNORE_INSERTS;
    // SAFETY: lpbuffer 는 BUF_LEN 개의 u16 을 담는 살아 있는 버퍼이고 nsize 로 그 길이를 넘긴다.
    // FROM_SYSTEM·IGNORE_INSERTS 이므로 lpsource 와 arguments 는 읽히지 않아 null 이어도 된다.
    let n = unsafe {
        FormatMessageW(
            flags,
            std::ptr::null(),
            code,
            lang,
            buf.as_mut_ptr(),
            BUF_LEN as u32,
            std::ptr::null(),
        )
    };
    if n == 0 { None } else { Some(n as usize) }
}

/// 영어(US)로 먼저, 실패하면 기본 언어로 묻는다. 둘 다 실패하면 `winapi error #N`.
pub(super) fn errno_string(code: i32) -> String {
    let code = code as u32;
    let mut buf = [0u16; BUF_LEN];
    let Some(mut n) = format_message(code, LANG_ENGLISH_US, &mut buf)
        .or_else(|| format_message(code, 0, &mut buf))
    else {
        return format!("winapi error #{code}");
    };
    // Go: 끝의 \r 과 \n 만 지운다.
    while n > 0 && (buf[n - 1] == u16::from(b'\n') || buf[n - 1] == u16::from(b'\r')) {
        n -= 1;
    }
    // Go UTF16ToString: 첫 NUL 에서 끊고, 잘못된 서로게이트는 U+FFFD.
    let end = buf[..n].iter().position(|&c| c == 0).unwrap_or(n);
    String::from_utf16_lossy(&buf[..end])
}
