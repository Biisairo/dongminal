use super::*;

fn sig(b: &[u8], bell: bool) -> (bool, Option<Vec<u8>>) {
    detect_attention_signal(b, bell, ATTN_MAX_CARRY)
}

#[test]
fn osc_notifications_signal() {
    for c in [
        &b"\x1b]9;build done\x07"[..],
        b"\x1b]9;hi\x1b\\",
        b"\x1b]777;notify;Title;Body\x07",
        b"\x1b]99;;message\x1b\\",
    ] {
        assert_eq!(sig(c, false), (true, None), "{c:?}");
    }
}

#[test]
fn plain_and_ansi_do_not_signal() {
    for c in [
        &b"hello world\n"[..],
        b"\x1b[31mred\x1b[0m text",
        b"\x1b]0;window title\x07",
        b"\x1b]777;cwd;/home/x\x07",
        b"\x1b]9;4;1;50\x07",
    ] {
        assert_eq!(sig(c, false), (false, None), "{c:?}");
    }
}

#[test]
fn split_across_chunks() {
    let (s1, carry) = sig(b"output\x1b]9;par", false);
    assert!(!s1);
    let mut next = carry.expect("carry");
    next.extend_from_slice(b"tial done\x07");
    assert_eq!(sig(&next, false), (true, None));
}

#[test]
fn bare_bell() {
    assert!(!sig(b"ding\x07", false).0);
    assert!(sig(b"ding\x07", true).0);
    assert!(!sig(b"\x1b]0;title\x07", true).0);
}

#[test]
fn carry_overflow_dropped() {
    let mut big = b"\x1b]9;".to_vec();
    big.extend(std::iter::repeat_n(b'x', 1000));
    assert_eq!(detect_attention_signal(&big, false, 512), (false, None));
}

#[test]
fn osc9_conemu_extensions_are_not_notifications() {
    for c in [
        "\x1b]9;9;C:\\Users\\foo\x07",
        "\x1b]9;9;C:\\Users\\foo\x1b\\",
        "\x1b]9;4;1;50\x07",
        "\x1b]9;4\x07",
        "\x1b]9;1\x07",
        "\x1b]9;12\x07",
        "\x1b]9;5\x07",
        "\x1b]9;7;cmd\x07",
    ] {
        assert!(!sig(c.as_bytes(), false).0, "{c:?}");
    }
    for c in [
        "\x1b]9;build done\x07",
        "\x1b]9;빌드 끝\x07",
        "\x1b]9;42 files changed\x07",
        "\x1b]9\x07",
    ] {
        assert!(sig(c.as_bytes(), false).0, "{c:?}");
    }
    assert!(!sig(b"\x1b]777;Cwd;/home/x\x07", false).0);
}

#[test]
fn cwd_report() {
    const P: &str = "\x1b]777;Cwd;";
    let cases = [
        (format!("{P}/a/b\x07"), "/a/b"),
        (format!("{P}/a/b\x1b\\"), "/a/b"),
        (format!("{P}C:\\Users\\x\\repo\x07"), "C:\\Users\\x\\repo"),
        (format!("prompt$ {P}/a\x07 tail"), "/a"),
        (format!("\x1b]0;title\x07{P}/a\x07"), "/a"),
        ("\x1b]0;title\x07plain".to_string(), ""),
        (format!("{P}/a"), ""),
        (format!("{P}/first\x07out{P}/second\x07"), "/second"),
        (format!("{P}/x\x07{P}\x07"), "/x"),
    ];
    for (input, want) in cases {
        assert_eq!(detect_cwd_report(input.as_bytes()), want, "{input:?}");
    }
}

#[test]
fn classify() {
    assert_eq!(classify_esc(b"\x1b[31m", false), EscClass::default());
    assert_eq!(
        classify_esc(b"\x1b[?2004h", false),
        EscClass {
            osc: false,
            modes: true
        }
    );
    assert_eq!(
        classify_esc(b"x\x1b", false),
        EscClass {
            osc: true,
            modes: true
        }
    );
    assert!(classify_esc(b"\x07", true).osc);
    assert!(!classify_esc(b"\x07", false).osc);
    assert!(classify_esc(b"\x1b]0;t\x07", false).osc);
}

#[test]
fn still_working() {
    let a = ActivityState {
        state: "working".into(),
        updated_at: 0,
        ..Default::default()
    };
    assert!(activity_still_working(Some(&a), ATTN_WORKING_STALE - 1));
    assert!(!activity_still_working(Some(&a), ATTN_WORKING_STALE));
    assert!(!activity_still_working(None, 0));
}
