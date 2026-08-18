//! Admission policy for the two user-configurable provider base URLs
//! (`openai_compatible_base_url` and `paddle_url`).
//!
//! Both are plain strings in [`crate::config::NonSecretSettings`], and both
//! become the destination of a request that carries the operator's API key.
//! On the desktop that is unremarkable — the only caller is the local UI, and
//! pointing Carpo at `http://127.0.0.1:11434/v1` (ollama, vLLM, a LiteLLM
//! proxy) is a first-class workflow. In `carpo-server` the same fields arrive
//! over the network, where an unchecked value turns any endpoint that spends
//! the server's stored key into a key-exfiltration and SSRF primitive: post a
//! base URL, receive the `Authorization: Bearer …` header on your own host.
//!
//! Hence two policies rather than one rule. The process picks its policy once
//! at startup ([`set_policy`]) — desktop leaves the default, `carpo-server`
//! switches to [`BaseUrlPolicy::NetworkFacing`] when it builds its state — and
//! every call site reads it through [`policy`]. This mirrors the process-wide
//! [`crate::i18n`] language for the same reason: one desktop app, or one
//! server, has exactly one answer, and the alternative threads a parameter
//! through every signature in the OCR pipeline.
//!
//! **What this does not fix.** Under `NetworkFacing` an attacker who can also
//! *write* settings (`PUT /api/settings` has no auth today) can still point
//! the server at an `https` host they control and receive the key there.
//! Closing that requires deployment-level authentication plus binding to
//! localhost by default; see the deployment note in the audit's item 3. What
//! the policy below does close is the read-only path — an attacker who can
//! only *call* the endpoint no longer chooses the destination — plus plaintext
//! exfiltration and probing of the deployment's own private network.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU8, Ordering};

use url::{Host, Url};

use crate::error::{AppError, AppResult};

/// Who is allowed to choose a provider endpoint in this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BaseUrlPolicy {
    /// The caller is the machine's own UI (Tauri desktop). Local and
    /// plaintext endpoints are legitimate; only structurally broken URLs and
    /// embedded credentials are refused.
    #[default]
    LocalTrusted,
    /// The caller reached us over the network (`carpo-server`). The URL may be
    /// attacker-chosen and the key we would send is the deployment's own, so
    /// require `https` and refuse anything that resolves inward.
    NetworkFacing,
}

/// Comma-separated `host` / `host:port` entries that are exempt from the
/// `NetworkFacing` restrictions. This is the escape hatch for a self-hosted
/// deployment whose model server genuinely lives on a private address —
/// `CARPO_BASE_URL_ALLOWLIST=ollama:11434,vllm.internal`. Entries are matched
/// case-insensitively against the URL's host and its `host:port`.
pub const ALLOWLIST_ENV: &str = "CARPO_BASE_URL_ALLOWLIST";

const LOCAL_TRUSTED: u8 = 0;
const NETWORK_FACING: u8 = 1;

static POLICY: AtomicU8 = AtomicU8::new(LOCAL_TRUSTED);

pub fn set_policy(policy: BaseUrlPolicy) {
    POLICY.store(
        match policy {
            BaseUrlPolicy::LocalTrusted => LOCAL_TRUSTED,
            BaseUrlPolicy::NetworkFacing => NETWORK_FACING,
        },
        Ordering::Relaxed,
    );
}

pub fn policy() -> BaseUrlPolicy {
    match POLICY.load(Ordering::Relaxed) {
        NETWORK_FACING => BaseUrlPolicy::NetworkFacing,
        _ => BaseUrlPolicy::LocalTrusted,
    }
}

/// Validates `raw` under `policy`, reading the allowlist from the environment.
/// Call this before handing a settings-supplied base URL to an HTTP client.
pub fn check(raw: &str, policy: BaseUrlPolicy) -> AppResult<()> {
    check_with_allowlist(raw, policy, &allowlist_from_env())
}

/// [`check`] with an explicit allowlist. Split out so the rules can be tested
/// as a pure function without mutating process state.
pub fn check_with_allowlist(
    raw: &str,
    policy: BaseUrlPolicy,
    allowlist: &[String],
) -> AppResult<()> {
    let trimmed = raw.trim();
    let url = Url::parse(trimmed).map_err(|_| {
        AppError::Config(crate::trf!(
            "Base URL 无效：{}",
            "Invalid base URL: {}",
            trimmed
        ))
    })?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::Config(crate::trf!(
            "Base URL 只支持 http/https，当前为 {}。",
            "Base URL must use http/https, got {}.",
            url.scheme()
        )));
    }

    // `https://key@host/` would leak the credential into logs and proxies, and
    // is never a legitimate way to configure these providers.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::Config(
            crate::tr!(
                "Base URL 不得内嵌用户名或密码。",
                "Base URL must not embed a username or password."
            )
            .into(),
        ));
    }

    let Some(host) = url.host() else {
        return Err(AppError::Config(crate::trf!(
            "Base URL 缺少主机名：{}",
            "Base URL has no host: {}",
            trimmed
        )));
    };

    if policy == BaseUrlPolicy::LocalTrusted || is_allowlisted(&url, allowlist) {
        return Ok(());
    }

    if url.scheme() != "https" {
        return Err(AppError::Config(crate::tr!(
            "服务以网络模式运行：Base URL 必须使用 https（或将该主机加入 CARPO_BASE_URL_ALLOWLIST）。",
            "Server runs in network mode: base URL must use https (or add the host to CARPO_BASE_URL_ALLOWLIST)."
        )
        .into()));
    }

    if is_internal_host(&host) {
        return Err(AppError::Config(crate::tr!(
            "服务以网络模式运行：Base URL 不得指向环回或内网地址（或将该主机加入 CARPO_BASE_URL_ALLOWLIST）。",
            "Server runs in network mode: base URL must not point at a loopback or private address (or add the host to CARPO_BASE_URL_ALLOWLIST)."
        )
        .into()));
    }

    Ok(())
}

fn allowlist_from_env() -> Vec<String> {
    std::env::var(ALLOWLIST_ENV)
        .map(|raw| parse_allowlist(&raw))
        .unwrap_or_default()
}

pub fn parse_allowlist(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|entry| entry.trim().to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn is_allowlisted(url: &Url, allowlist: &[String]) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    let with_port = url
        .port_or_known_default()
        .map(|port| format!("{host}:{port}"));
    allowlist
        .iter()
        .any(|entry| *entry == host || with_port.as_deref() == Some(entry.as_str()))
}

/// Whether the host names something reachable only from inside the
/// deployment. Literal addresses are decided exactly; names are decided by
/// shape, since resolving them here would both block and be defeatable by DNS
/// rebinding (a host that resolves public now and private on the next lookup).
/// The shape rules cover the cases that matter in practice: `localhost`, the
/// `.local` / `.internal` / `.home.arpa` suffixes, and single-label names,
/// which only resolve through a local search domain — `http://ollama:11434`
/// inside a Docker network is exactly such a name, which is why the allowlist
/// exists.
fn is_internal_host(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => is_internal_domain(name),
        Host::Ipv4(addr) => is_internal_v4(*addr),
        Host::Ipv6(addr) => is_internal_v6(*addr),
    }
}

fn is_internal_domain(name: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() {
        return true;
    }
    if !name.contains('.') {
        return true;
    }
    name == "localhost"
        || name.ends_with(".localhost")
        || name.ends_with(".local")
        || name.ends_with(".internal")
        || name.ends_with(".home.arpa")
}

fn is_internal_v4(addr: Ipv4Addr) -> bool {
    let [a, b, ..] = addr.octets();
    a == 0                                  // 0.0.0.0/8
        || addr.is_loopback()               // 127.0.0.0/8
        || addr.is_private()                // 10/8, 172.16/12, 192.168/16
        || addr.is_link_local()             // 169.254/16 (incl. cloud metadata)
        || addr.is_broadcast()
        || addr.is_multicast()
        || addr.is_documentation()
        || (a == 100 && (64..128).contains(&b)) // 100.64/10 CGNAT
        || a >= 240 // 240/4 reserved
}

fn is_internal_v6(addr: Ipv6Addr) -> bool {
    if let Some(v4) = addr.to_ipv4_mapped() {
        return is_internal_v4(v4);
    }
    let segments = addr.segments();
    addr.is_loopback()
        || addr.is_unspecified()
        || addr.is_multicast()
        || segments[0] & 0xfe00 == 0xfc00 // fc00::/7 unique local
        || segments[0] & 0xffc0 == 0xfe80 // fe80::/10 link local
        || (segments[0] == 0x2001 && segments[1] == 0x0db8) // documentation
}

#[cfg(test)]
mod tests {
    use super::*;

    fn network(raw: &str) -> AppResult<()> {
        check_with_allowlist(raw, BaseUrlPolicy::NetworkFacing, &[])
    }

    fn local(raw: &str) -> AppResult<()> {
        check_with_allowlist(raw, BaseUrlPolicy::LocalTrusted, &[])
    }

    #[test]
    fn network_facing_accepts_public_https() {
        network("https://api.example.com/v1").unwrap();
        network("https://api.example.com:8443/v1").unwrap();
    }

    #[test]
    fn network_facing_rejects_plaintext_http() {
        assert!(matches!(
            network("http://attacker.example/v1").unwrap_err(),
            AppError::Config(_)
        ));
    }

    #[test]
    fn network_facing_rejects_loopback_and_private_literals() {
        for raw in [
            "https://127.0.0.1/v1",
            "https://127.1.2.3/v1",
            "https://10.0.0.1/v1",
            "https://172.16.4.4/v1",
            "https://192.168.1.1/v1",
            "https://169.254.169.254/latest",
            "https://100.64.0.1/v1",
            "https://[::1]/v1",
            "https://[fd00::1]/v1",
            "https://[fe80::1]/v1",
            "https://[::ffff:127.0.0.1]/v1",
        ] {
            assert!(network(raw).is_err(), "expected rejection for {raw}");
        }
    }

    #[test]
    fn network_facing_rejects_internal_names() {
        for raw in [
            "https://localhost/v1",
            "https://ollama/v1",
            "https://box.local/v1",
            "https://models.internal/v1",
        ] {
            assert!(network(raw).is_err(), "expected rejection for {raw}");
        }
    }

    #[test]
    fn credentials_in_url_are_rejected_under_both_policies() {
        assert!(network("https://user:pass@api.example.com/v1").is_err());
        assert!(local("https://user:pass@api.example.com/v1").is_err());
        assert!(local("https://user@api.example.com/v1").is_err());
    }

    #[test]
    fn non_http_schemes_and_garbage_are_rejected_under_both_policies() {
        for raw in ["file:///etc/passwd", "ftp://example.com", "not a url", ""] {
            assert!(network(raw).is_err(), "expected rejection for {raw}");
            assert!(local(raw).is_err(), "expected rejection for {raw}");
        }
    }

    #[test]
    fn local_trusted_allows_the_desktop_workflows() {
        local("http://127.0.0.1:11434/v1").unwrap();
        local("http://localhost:8000/v1").unwrap();
        local("https://api.example.com/v1").unwrap();
    }

    #[test]
    fn allowlist_reopens_specific_internal_hosts() {
        let allow = parse_allowlist(" Ollama:11434 , vllm.internal ");
        assert_eq!(allow, vec!["ollama:11434", "vllm.internal"]);
        check_with_allowlist(
            "http://ollama:11434/v1",
            BaseUrlPolicy::NetworkFacing,
            &allow,
        )
        .unwrap();
        check_with_allowlist(
            "https://vllm.internal/v1",
            BaseUrlPolicy::NetworkFacing,
            &allow,
        )
        .unwrap();
        // A neighbouring host on the same private network stays refused.
        assert!(check_with_allowlist(
            "http://ollama-2:11434/v1",
            BaseUrlPolicy::NetworkFacing,
            &allow
        )
        .is_err());
    }

    #[test]
    fn allowlist_does_not_waive_credential_and_scheme_rules() {
        let allow = parse_allowlist("ollama:11434");
        assert!(check_with_allowlist(
            "http://user:pass@ollama:11434/v1",
            BaseUrlPolicy::NetworkFacing,
            &allow
        )
        .is_err());
        assert!(check_with_allowlist(
            "ftp://ollama:11434/v1",
            BaseUrlPolicy::NetworkFacing,
            &allow
        )
        .is_err());
    }

    #[test]
    fn default_policy_is_local_trusted() {
        // Read-only: the desktop default must not depend on test ordering,
        // and no test here may flip the process-wide value.
        assert_eq!(BaseUrlPolicy::default(), BaseUrlPolicy::LocalTrusted);
    }
}
