//! 커널 응답의 **순수** 해석부다. 어느 호스트에서도 시험된다 (CROSS_PLATFORM_SRS §4.2).

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::{CpuTicks, Error, MemInfo};

/// `/proc/stat` 의 첫 `cpu` 줄에서 누적 tick 을 읽는다. 열은 user nice system idle iowait … 다.
/// iowait 는 idle 에 더한다 — darwin 의 HOST_CPU_LOAD_INFO 와 뜻을 맞춘다.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub(crate) fn parse_proc_stat_cpu(content: &str) -> Result<CpuTicks, Error> {
    for line in content.split('\n') {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 5 || f[0] != "cpu" {
            continue;
        }
        let mut vals = Vec::with_capacity(5);
        for s in &f[1..f.len().min(6)] {
            let n = s.parse::<u64>().map_err(|_| {
                Error::Os(format!(
                    "/proc/stat cpu 열 해석: strconv.ParseUint: parsing {s:?}: invalid syntax"
                ))
            })?;
            vals.push(n);
        }
        let mut t = CpuTicks {
            user: vals[0],
            nice: vals[1],
            system: vals[2],
            idle: vals[3],
        };
        if let Some(iowait) = vals.get(4) {
            t.idle += iowait;
        }
        return Ok(t);
    }
    Err(Error::Os("/proc/stat 에 cpu 줄이 없다".to_owned()))
}

/// `/proc/stat` 의 btime(부팅 시각, epoch 초)을 읽는다.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub(crate) fn parse_proc_stat_boot_time(content: &str) -> Result<SystemTime, Error> {
    for line in content.split('\n') {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 2 || f[0] != "btime" {
            continue;
        }
        let sec = f[1].parse::<i64>().map_err(|_| {
            Error::Os(format!(
                "/proc/stat btime 해석: strconv.ParseInt: parsing {:?}: invalid syntax",
                f[1]
            ))
        })?;
        return Ok(unix_secs(sec));
    }
    Err(Error::Os("/proc/stat 에 btime 이 없다".to_owned()))
}

pub(crate) fn unix_secs(sec: i64) -> SystemTime {
    if sec >= 0 {
        UNIX_EPOCH + Duration::from_secs(sec as u64)
    } else {
        UNIX_EPOCH - Duration::from_secs(sec.unsigned_abs())
    }
}

/// 총량과 사용량을 낸다. 사용량은 MemTotal - MemAvailable 이다. MemAvailable 이 없는 낡은
/// 커널에서는 MemFree+Buffers+Cached 로 근사한다. 값은 kB 단위다.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub(crate) fn parse_proc_meminfo(content: &str) -> Result<MemInfo, Error> {
    let mut fields: HashMap<&str, u64> = HashMap::new();
    for line in content.split('\n') {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let Some(first) = rest.split_whitespace().next() else {
            continue;
        };
        if let Ok(n) = first.parse::<u64>() {
            fields.insert(key, n.wrapping_mul(1024));
        }
    }
    let total = match fields.get("MemTotal") {
        Some(&t) if t != 0 => t,
        _ => return Err(Error::Os("/proc/meminfo 에 MemTotal 이 없다".to_owned())),
    };
    let field = |k: &str| fields.get(k).copied().unwrap_or(0);
    let avail = match fields.get("MemAvailable") {
        Some(&a) => a,
        None => field("MemFree")
            .wrapping_add(field("Buffers"))
            .wrapping_add(field("Cached")),
    }
    .min(total);
    Ok(MemInfo {
        total,
        used: total - avail,
    })
}

/// sysctl 이 돌려준 바이트를 little-endian uint64 로 읽는다. 8바이트보다 짧으면 상위
/// 바이트를 0 으로 채운다.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn parse_sysctl_u64(b: &[u8]) -> Result<u64, Error> {
    if b.is_empty() {
        return Err(Error::Os("sysctl: 빈 응답".to_owned()));
    }
    let mut buf = [0u8; 8];
    let n = b.len().min(8);
    buf[..n].copy_from_slice(&b[..n]);
    Ok(u64::from_le_bytes(buf))
}
