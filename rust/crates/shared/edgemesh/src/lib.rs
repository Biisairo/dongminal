//! Go 기준선 `dongminal/internal/shared/edgemesh` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 간선 계층의 간선 연결과 망 정보다 (EDGE_MESH_SRS). 간선마다 계속 열어 두는 연결 하나를 갖고,
//! 그 연결로 망 정보(`net`)·직접 정보(`hello`)·간선 초대(`invite`)·생존 확인(`ping`)을 주고받는다.
//! 그 밖의 프레임은 위층(채팅)에 넘긴다. 데몬 모드에서만 선다 (FR-EGM-1).

mod error;
mod frame;
mod invite;
mod mesh;
mod net;

pub use error::{ErrorKind, MeshError};
pub use frame::{
    FRAME_HELLO, FRAME_INVITE, FRAME_NET, FRAME_PING, Frame, encode, parse_key, public_key, sign,
    sign_frame, verify,
};
pub use invite::Invite;
pub use mesh::{
    BoxFuture, Conn, DialFn, FpFn, HELLO_WAIT, Hello, Mesh, NowFn, OnHelloFn, Options, PATH, PROTO,
    Upper,
};
pub use net::{MARK_REACHED_TTL, NodeInfo, View, mark_expendable};

#[cfg(test)]
mod tests;
