//! 시험용 가짜 Bot API. 실제 Telegram 에 나가지 않는다. 포트는 운영 범위를 피해 60147 이상을 쓴다.

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

/// 첫 시험 포트. RUST_PORT C-RSP-1.
const PORT_MIN: u16 = 60147;
const PORT_SPAN: u16 = 5000;

pub(crate) type Reply = Pin<Box<dyn Future<Output = (u16, String)> + Send>>;
/// (method, 본문 바이트) → (상태, 본문).
pub(crate) type Handler = Arc<dyn Fn(String, Vec<u8>) -> Reply + Send + Sync>;

pub(crate) struct Server {
    pub(crate) url: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn bind() -> TcpListener {
    let start = PORT_MIN + (std::process::id() as u16 % PORT_SPAN);
    for i in 0..PORT_SPAN {
        let port = PORT_MIN + (start - PORT_MIN + i) % PORT_SPAN;
        if let Ok(l) = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
            return l;
        }
    }
    panic!("시험 포트를 잡지 못했다");
}

pub(crate) async fn serve(h: Handler) -> Server {
    let l = bind().await;
    let url = format!("http://{}", l.local_addr().unwrap());
    let task = tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else {
                return;
            };
            let h = Arc::clone(&h);
            tokio::spawn(async move {
                let svc = service_fn(move |req: Request<Incoming>| {
                    let h = Arc::clone(&h);
                    async move {
                        let path = req.uri().path().to_owned();
                        let method = path.rsplit('/').next().unwrap_or_default().to_owned();
                        assert!(path.starts_with("/bot"), "경로에 bot 접두가 없다: {path}");
                        let body = req.into_body().collect().await.unwrap().to_bytes().to_vec();
                        let (code, out) = h(method, body).await;
                        let res = Response::builder()
                            .status(code)
                            .body(Full::new(Bytes::from(out)))
                            .unwrap();
                        Ok::<_, Infallible>(res)
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(s), svc)
                    .await;
            });
        }
    });
    Server { url, task }
}
