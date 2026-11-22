//! Go 기준선 `dongminal/internal/shared/uuid` 의 Rust 포팅.
//!
//! UUID v7 (RFC 9562) 생성과 해석이다. 서버가 발급하는 식별자(toolId·reqId)가
//! [`new_string`] 을 거친다 (FR-UNI-6).

use std::fmt;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::TryRng;
use rand::rngs::SysRng;

/// RFC 9562 배치의 128비트 식별자다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Uuid(pub [u8; 16]);

const COUNTER_MAX: u16 = 0x0FFF;

/// 생성 실패다. 운영체제 난수원이 실패한 경우뿐이다.
#[derive(Debug)]
pub struct GenerateError(String);

impl fmt::Display for GenerateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "uuid: rand_b: {}", self.0)
    }
}

impl std::error::Error for GenerateError {}

/// 해석 실패다. 문구는 Go 기준선과 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// `uuid: invalid length`
    InvalidLength,
    /// `uuid: invalid format`
    InvalidFormat,
    /// `uuid: encoding/hex: invalid byte: U+007A 'z'`
    InvalidByte(u8),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ParseError::InvalidLength => f.write_str("uuid: invalid length"),
            ParseError::InvalidFormat => f.write_str("uuid: invalid format"),
            ParseError::InvalidByte(b) => {
                // Go `%#U`: 출력 가능한 글자면 따옴표로 함께 찍는다.
                write!(f, "uuid: encoding/hex: invalid byte: U+{:04X}", *b as u32)?;
                if go_is_print_latin1(*b) {
                    write!(f, " '{}'", char::from(*b))?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for ParseError {}

/// Go `strconv.IsPrint` 의 U+00FF 이하 판정이다.
fn go_is_print_latin1(b: u8) -> bool {
    matches!(b, 0x20..=0x7E | 0xA1..=0xFF) && b != 0xAD
}

struct GenState {
    last_ms: u64,
    last_rand_a: u16,
}

type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

/// UUID v7 생성기다. 같은 밀리초 안에서는 rand_a 의 12비트 카운터로 엄격히 증가한다
/// (RFC 9562 §6.2 방법 1). 카운터가 다 차면 합성 시각을 1ms 올린다. 시계가 뒤로 가도
/// 같은 길로 흡수한다.
pub struct Generator {
    now_ms: Clock,
    state: Mutex<GenState>,
}

impl Default for Generator {
    fn default() -> Self {
        Self::new()
    }
}

fn wall_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as u64,
        // Go `UnixMilli` 는 음수를 내고 uint64 로 바꾸면 매우 큰 수가 된다. 1970 이전의
        // 시계는 현실에서 없으므로 0 으로 둔다.
        Err(_) => 0,
    }
}

impl Generator {
    /// 벽시계를 쓰는 생성기다.
    pub fn new() -> Self {
        Self::with_clock(wall_ms)
    }

    /// 시계를 주입한다. 값은 Unix 밀리초다.
    pub fn with_clock(now_ms: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self {
            now_ms: Box::new(now_ms),
            state: Mutex::new(GenState {
                last_ms: 0,
                last_rand_a: 0,
            }),
        }
    }

    /// 다음 UUID v7 이다. 여러 스레드에서 불러도 된다.
    pub fn generate(&self) -> Result<Uuid, GenerateError> {
        let mut st = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut ms = (self.now_ms)();
        let rand_a: u16;
        if ms > st.last_ms {
            rand_a = 0;
            st.last_ms = ms;
        } else {
            ms = st.last_ms;
            if st.last_rand_a >= COUNTER_MAX {
                ms += 1;
                st.last_ms = ms;
                rand_a = 0;
            } else {
                rand_a = st.last_rand_a + 1;
            }
        }
        st.last_rand_a = rand_a;

        let mut u = [0u8; 16];
        u[0..6].copy_from_slice(&ms.to_be_bytes()[2..8]);
        u[6] = 0x70 | ((rand_a >> 8) & 0x0F) as u8;
        u[7] = rand_a as u8;

        let mut rand_b = [0u8; 8];
        SysRng
            .try_fill_bytes(&mut rand_b)
            .map_err(|e| GenerateError(e.to_string()))?;
        u[8] = 0x80 | (rand_b[0] & 0x3F);
        u[9..16].copy_from_slice(&rand_b[1..8]);
        Ok(Uuid(u))
    }
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn push_hex(out: &mut String, b: &[u8]) {
    for &x in b {
        out.push(char::from(HEX[(x >> 4) as usize]));
        out.push(char::from(HEX[(x & 0x0F) as usize]));
    }
}

fn unhex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

impl Uuid {
    /// 앞 8 hex 글자(앞 4바이트)다. 로그 가독성용이며 유일 매칭에 쓰지 않는다 (NFR-UID-4).
    pub fn short_code(&self) -> String {
        let mut s = String::with_capacity(8);
        push_hex(&mut s, &self.0[..4]);
        s
    }

    /// 버전 니블이다 (v7 이면 7).
    pub fn version(&self) -> u8 {
        self.0[6] >> 4
    }

    /// 정규형 8-4-4-4-12 hex 를 해석한다. hex 는 대소문자를 모두 받는다.
    pub fn parse(s: &str) -> Result<Uuid, ParseError> {
        let b = s.as_bytes();
        if b.len() != 36 {
            return Err(ParseError::InvalidLength);
        }
        if b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
            return Err(ParseError::InvalidFormat);
        }
        const SEGMENTS: [(usize, usize, usize); 5] =
            [(0, 8, 0), (9, 13, 4), (14, 18, 6), (19, 23, 8), (24, 36, 10)];
        let mut u = [0u8; 16];
        for (lo, hi, dst) in SEGMENTS {
            for (k, pair) in b[lo..hi].chunks_exact(2).enumerate() {
                let a = unhex(pair[0]).ok_or(ParseError::InvalidByte(pair[0]))?;
                let c = unhex(pair[1]).ok_or(ParseError::InvalidByte(pair[1]))?;
                u[dst + k] = (a << 4) | c;
            }
        }
        Ok(Uuid(u))
    }
}

impl fmt::Display for Uuid {
    /// 정규형 8-4-4-4-12 소문자 hex 다.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut s = String::with_capacity(36);
        for (i, (lo, hi)) in [(0, 4), (4, 6), (6, 8), (8, 10), (10, 16)].into_iter().enumerate() {
            if i > 0 {
                s.push('-');
            }
            push_hex(&mut s, &self.0[lo..hi]);
        }
        f.write_str(&s)
    }
}

/// 프로세스 전역 생성기다 (FR-UNI-6).
fn default_gen() -> &'static Generator {
    static GEN: OnceLock<Generator> = OnceLock::new();
    GEN.get_or_init(Generator::new)
}

/// 정규형의 새 UUID v7 문자열이다. v7 은 시간 정렬되므로 사전순이 생성 순서다.
///
/// 실패하는 길은 운영체제 난수원 고갈뿐이고, 그때는 식별자를 만들 방법이 없다 —
/// Go 와 같이 패닉한다 (SRS §2.2: 카운터나 시각으로 대체하면 충돌이 다시 열린다).
pub fn new_string() -> String {
    match default_gen().generate() {
        Ok(u) => u.to_string(),
        Err(e) => panic!("uuid: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    const T0: u64 = 1_700_000_000_000;

    #[test]
    fn version_and_variant() {
        let u = Generator::new().generate().unwrap();
        assert_eq!(u.version(), 7);
        assert_eq!(u.0[8] & 0xC0, 0x80);
    }

    #[test]
    fn string_format() {
        let s = Generator::new().generate().unwrap().to_string();
        assert_eq!(s.len(), 36);
        for i in [8, 13, 18, 23] {
            assert_eq!(s.as_bytes()[i], b'-');
        }
        assert!(s.replace('-', "").bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn parse_roundtrip() {
        let u = Generator::new().generate().unwrap();
        assert_eq!(Uuid::parse(&u.to_string()).unwrap(), u);
    }

    #[test]
    fn short_code() {
        let u = Generator::new().generate().unwrap();
        let sc = u.short_code();
        assert_eq!(sc.len(), 8);
        assert_eq!(sc, u.to_string()[..8]);
    }

    // TC-UID-6
    #[test]
    fn monotonic_same_ms() {
        let g = Generator::with_clock(|| T0);
        let v: Vec<Uuid> = (0..100).map(|_| g.generate().unwrap()).collect();
        assert!(v.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn monotonic_across_ms() {
        let step = Arc::new(AtomicBool::new(false));
        let s2 = step.clone();
        let g = Generator::with_clock(move || if s2.load(Ordering::SeqCst) { T0 + 10 } else { T0 });
        let u1 = g.generate().unwrap();
        step.store(true, Ordering::SeqCst);
        let u2 = g.generate().unwrap();
        assert!(u1.0 < u2.0);
        assert_eq!(&u2.0[..6], &(T0 + 10).to_be_bytes()[2..]);
    }

    #[test]
    fn monotonic_clock_backwards() {
        let back = Arc::new(AtomicBool::new(false));
        let b2 = back.clone();
        let g = Generator::with_clock(move || if b2.load(Ordering::SeqCst) { T0 - 100 } else { T0 });
        let u1 = g.generate().unwrap();
        back.store(true, Ordering::SeqCst);
        let u2 = g.generate().unwrap();
        assert!(u1.0 < u2.0);
    }

    #[test]
    fn counter_exhaustion() {
        let g = Generator::with_clock(|| T0);
        let v: Vec<Uuid> = (0..4097).map(|_| g.generate().unwrap()).collect();
        assert!(v.windows(2).all(|w| w[0].0 < w[1].0));
        // 4097 번째는 합성 시각 +1ms, 카운터 0 이다.
        assert_eq!(&v[4096].0[..6], &(T0 + 1).to_be_bytes()[2..]);
        assert_eq!((v[4096].0[6] & 0x0F, v[4096].0[7]), (0, 0));
        assert_eq!((v[4095].0[6] & 0x0F, v[4095].0[7]), (0x0F, 0xFF));
    }

    // TC-UID-7
    #[test]
    fn concurrent_no_duplicate() {
        let g = Arc::new(Generator::new());
        let handles: Vec<_> = (0..10)
            .map(|_| {
                let g = g.clone();
                std::thread::spawn(move || (0..1000).map(|_| g.generate().unwrap()).collect::<Vec<_>>())
            })
            .collect();
        let mut seen = HashSet::new();
        for h in handles {
            for u in h.join().unwrap() {
                assert!(seen.insert(u), "duplicate {u}");
            }
        }
        assert_eq!(seen.len(), 10_000);
    }

    #[test]
    fn parse_invalid() {
        let zeros = "0".repeat(36);
        let cases = [
            "",
            "not-a-uuid",
            zeros.as_str(),
            "00000000-0000-0000-0000-00000000000z",
            "00000000_0000_0000_0000_000000000000",
            "0000-00000000-0000-0000-000000000000",
        ];
        for c in cases {
            assert!(Uuid::parse(c).is_err(), "{c:?}");
        }
    }

    #[test]
    fn parse_error_messages_match_go() {
        let msg = |s: &str| Uuid::parse(s).unwrap_err().to_string();
        assert_eq!(msg(""), "uuid: invalid length");
        assert_eq!(msg(&"0".repeat(36)), "uuid: invalid format");
        assert_eq!(
            msg("00000000-0000-0000-0000-00000000000z"),
            "uuid: encoding/hex: invalid byte: U+007A 'z'"
        );
        assert_eq!(
            msg("0000000\u{1}-0000-0000-0000-000000000000"),
            "uuid: encoding/hex: invalid byte: U+0001"
        );
        // 다중 바이트 글자는 바이트 하나로 본다 (Go 는 s[lo:hi] 를 바이트로 디코드한다).
        assert_eq!(
            msg("000000é-0000-0000-0000-000000000000"),
            "uuid: encoding/hex: invalid byte: U+00C3 'Ã'"
        );
    }

    #[test]
    fn parse_accepts_uppercase() {
        let u = Uuid::parse("ABCDEF00-0000-0000-0000-000000000000").unwrap();
        assert_eq!(u.to_string(), "abcdef00-0000-0000-0000-000000000000");
    }

    #[test]
    fn parse_nil_uuid() {
        let s = "00000000-0000-0000-0000-000000000000";
        let u = Uuid::parse(s).unwrap();
        assert_eq!(u, Uuid::default());
        assert_eq!(u.to_string(), s);
    }

    #[test]
    fn new_string_is_v7() {
        let a = new_string();
        let b = new_string();
        assert!(a < b);
        assert_eq!(Uuid::parse(&a).unwrap().version(), 7);
    }
}
