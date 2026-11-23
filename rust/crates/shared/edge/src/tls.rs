//! 노드 포트의 TLS 설정 (FR-PNW-5·22·31, D-3). 노드 인증서는 자기 서명이라 체인 대신 지문을
//! 대조한다. 서명(CertificateVerify)은 검증한다.

use std::fmt;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::NoServerSessionStorage;
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName, Error, OtherError,
    ServerConfig, SignatureScheme,
};

use crate::identity::{Identity, fingerprint_of};

const TLS13_ONLY: &str = "TLS 1.3 only";

/// 핸드셰이크에서 지문을 받을지 가르는 함수다.
pub type TlsAdmit = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// 짝이 아닌 지문이라 TLS 단계에서 끊었다.
#[derive(Debug)]
pub(crate) struct NotEdge;

impl fmt::Display for NotEdge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("간선이 아닌 노드입니다")
    }
}

impl std::error::Error for NotEdge {}

/// 서버 지문이 고정한 값과 다르다.
#[derive(Debug)]
pub(crate) struct FingerprintMismatch;

impl fmt::Display for FingerprintMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("상대 노드의 지문이 기대와 다릅니다")
    }
}

impl std::error::Error for FingerprintMismatch {}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn reject(e: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::InvalidCertificate(CertificateError::Other(OtherError(Arc::new(e))))
}

#[derive(Debug)]
struct Algorithms(WebPkiSupportedAlgorithms);

impl Algorithms {
    fn verify13(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.0)
    }
}

/// 클라이언트 인증서의 지문으로 들이는 검증기다. 체인은 보지 않는다.
struct AdmitClient {
    admit: TlsAdmit,
    algs: Algorithms,
}

impl fmt::Debug for AdmitClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AdmitClient")
    }
}

impl ClientCertVerifier for AdmitClient {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        let Some(fp) = fingerprint_of(end_entity) else {
            return Err(Error::InvalidCertificate(CertificateError::BadEncoding));
        };
        if (self.admit)(&fp) {
            Ok(ClientCertVerified::assertion())
        } else {
            Err(reject(NotEdge))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::General(TLS13_ONLY.into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.algs.verify13(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.0.supported_schemes()
    }
}

/// 서버 지문을 고정하는 검증기다.
#[derive(Debug)]
struct PinServer {
    fingerprint: String,
    algs: Algorithms,
}

impl ServerCertVerifier for PinServer {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        if fingerprint_of(end_entity).as_deref() == Some(self.fingerprint.as_str()) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(reject(FingerprintMismatch))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::General(TLS13_ONLY.into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.algs.verify13(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.0.supported_schemes()
    }
}

/// 노드 포트의 서버 설정이다. TLS 1.3 만 받고 클라이언트 인증서를 요구한다. 세션 재개는 끈다 —
/// rustls 는 재개 때 검증기를 부르지 않으므로, 해제한 짝이 재개로 들어오지 못하게 한다
/// (Go 는 재개 때도 VerifyConnection 으로 다시 거른다, FR-PNW-31).
pub fn server_config(id: &Identity, admit: TlsAdmit) -> Result<Arc<ServerConfig>, Error> {
    let p = provider();
    let verifier = AdmitClient {
        admit,
        algs: Algorithms(p.signature_verification_algorithms),
    };
    let mut cfg = ServerConfig::builder_with_provider(p)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(Arc::new(verifier))
        .with_single_cert(vec![id.certificate.clone()], id.private_key())?;
    cfg.session_storage = Arc::new(NoServerSessionStorage {});
    cfg.send_tls13_tickets = 0;
    Ok(Arc::new(cfg))
}

/// 지문 fingerprint 의 서버에 거는 클라이언트 설정이다. 자기 인증서를 내민다.
pub fn client_config(id: &Identity, fingerprint: &str) -> Result<Arc<ClientConfig>, Error> {
    let p = provider();
    let verifier = PinServer {
        fingerprint: fingerprint.to_string(),
        algs: Algorithms(p.signature_verification_algorithms),
    };
    let mut cfg = ClientConfig::builder_with_provider(p)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_client_auth_cert(vec![id.certificate.clone()], id.private_key())?;
    cfg.resumption = rustls::client::Resumption::disabled();
    Ok(Arc::new(cfg))
}

/// 오류 사슬 안의 rustls 오류다.
pub(crate) fn find_tls_error<'a>(e: &'a (dyn std::error::Error + 'static)) -> Option<&'a Error> {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = cur {
        if let Some(t) = err.downcast_ref::<Error>() {
            return Some(t);
        }
        if let Some(io) = err.downcast_ref::<std::io::Error>()
            && let Some(inner) = io.get_ref()
            && let Some(t) = inner.downcast_ref::<Error>()
        {
            return Some(t);
        }
        cur = err.source();
    }
    None
}

/// rustls 오류가 지문 불일치인가다.
pub(crate) fn is_fingerprint_mismatch(e: &Error) -> bool {
    matches!(e, Error::InvalidCertificate(CertificateError::Other(o)) if o.0.downcast_ref::<FingerprintMismatch>().is_some())
}

#[cfg(test)]
pub(crate) fn pin_server(fingerprint: &str) -> Arc<dyn ServerCertVerifier> {
    Arc::new(PinServer {
        fingerprint: fingerprint.to_string(),
        algs: Algorithms(provider().signature_verification_algorithms),
    })
}
