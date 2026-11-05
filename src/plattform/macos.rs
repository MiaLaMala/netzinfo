//! macOS: `route`, `ipconfig`, `scutil`. The parsers are plain text functions and are
//! compiled (and tested) on every system, only the callers are macOS-only.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use crate::hier::NetInfo;
use crate::subnetz;
use std::net::Ipv4Addr;
use std::process::Command;

#[derive(Debug, Default, PartialEq)]
struct Route {
    gateway: Option<String>,
    interface: Option<String>,
}

#[derive(Debug, Default, PartialEq)]
struct Lease {
    yiaddr: Option<Ipv4Addr>,
    mask: Option<Ipv4Addr>,
    router: Option<Ipv4Addr>,
    server: Option<Ipv4Addr>,
    dns: Vec<Ipv4Addr>,
    domain: Option<String>,
    /// DHCP option 252 (WPAD URL), if the server sends one.
    wpad: Option<String>,
}

fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.trim()
        .strip_prefix(key)?
        .trim_start()
        .strip_prefix(':')
        .map(str::trim)
}

fn parse_route(out: &str) -> Route {
    let mut r = Route::default();
    for line in out.lines() {
        if let Some(v) = field(line, "gateway") {
            r.gateway = Some(v.to_string());
        } else if let Some(v) = field(line, "interface") {
            r.interface = Some(v.to_string());
        }
    }
    r
}

/// First address in `{a, b}` or plain `a` after the type marker.
fn ips(value: &str) -> Vec<Ipv4Addr> {
    value
        .trim_matches(|c| c == '{' || c == '}')
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect()
}

fn parse_lease(out: &str) -> Lease {
    let mut l = Lease::default();
    for line in out.lines() {
        let Some((k, v)) = line.split_once('=').or_else(|| line.split_once(':')) else {
            continue;
        };
        // option lines look like `router (ip_mult): {192.0.2.1}`
        let key = k.split('(').next().unwrap_or("").trim();
        let v = v.trim();
        match key {
            "yiaddr" => l.yiaddr = ips(v).first().copied(),
            "subnet_mask" => l.mask = ips(v).first().copied(),
            "router" => l.router = ips(v).first().copied(),
            "server_identifier" => l.server = ips(v).first().copied(),
            "domain_name_server" => l.dns = ips(v),
            "domain_name" => l.domain = Some(v.to_string()).filter(|d| !d.is_empty()),
            // ponytail: name as printed by `ipconfig getpacket` on macOS; check it on a net that sends 252
            "proxy_auto_discovery" | "wpad" => {
                l.wpad = Some(v.to_string()).filter(|d| !d.is_empty())
            }
            _ => {}
        }
    }
    l
}

/// Nameservers of resolvers without a `domain` line: those answer for every name.
/// Domain-specific resolvers (`.local`, `ts.net`) are skipped.
fn parse_scutil_dns(out: &str) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for block in out.split("resolver #").skip(1) {
        if block.lines().any(|l| field(l, "domain").is_some()) {
            continue;
        }
        for l in block.lines() {
            if let Some(ns) = l.trim().strip_prefix("nameserver[")
                && let Some((_, v)) = ns.split_once(':')
            {
                let v = v.trim().to_string();
                if !result.contains(&v) {
                    result.push(v);
                }
            }
        }
    }
    result
}

fn sh(program: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(program).args(args).output().map_err(|e| {
        format!(
            "`{program}` ließ sich nicht starten ({}). Läuft das auf einem Mac?",
            crate::io_satz(&e)
        )
    })?;
    if !out.status.success() {
        return Err(format!("`{program}` meldete einen Fehler."));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// WPAD URL from DHCP option 252 on `interface`, `None` without one.
pub fn wpad_dhcp(interface: &str) -> Option<String> {
    parse_lease(&sh("ipconfig", &["getpacket", interface]).ok()?).wpad
}

pub fn lies_netzdaten() -> Result<NetInfo, String> {
    let no_net = "Kein Netz gefunden: Es gibt keine Default-Route. Verbinde den Mac mit WLAN oder Kabel und versuche es noch mal.";
    let route =
        parse_route(&sh("route", &["-n", "get", "default"]).map_err(|_| no_net.to_string())?);
    let interface = route.interface.ok_or(no_net)?;
    // A VPN tunnel has no DHCP lease, so the lease and the mask stay empty there.
    let lease = sh("ipconfig", &["getpacket", &interface])
        .map(|o| parse_lease(&o))
        .unwrap_or_default();
    let ip = lease.yiaddr.or_else(|| {
        sh("ipconfig", &["getifaddr", &interface])
            .ok()?
            .trim()
            .parse()
            .ok()
    });
    let subnet = match (ip, lease.mask) {
        (Some(ip), Some(m)) => subnetz::calc(ip, subnetz::prefix_from_mask(m)?).ok(),
        _ => None,
    };
    let router = lease.router.or_else(|| route.gateway?.parse().ok());
    let system_dns = system_dns();
    Ok(NetInfo {
        interface,
        ip,
        subnet,
        router,
        dhcp_server: lease.server,
        dhcp_dns: lease.dns,
        system_dns,
        domain: lease.domain,
        ..NetInfo::default()
    })
}

/// DNS servers the system asks first, from `scutil --dns`. Empty when the call fails.
pub fn system_dns() -> Vec<String> {
    sh("scutil", &["--dns"])
        .map(|o| parse_scutil_dns(&o))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUTE: &str = "   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.178.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>\n";
    const ROUTE_UTUN: &str =
        "   route to: default\ndestination: default\n    gateway: 100.64.0.1\n  interface: utun4\n";
    const PACKET: &str = "op = BOOTREPLY\nyiaddr = 192.168.178.20\nsiaddr = 0.0.0.0\nchaddr = 02:00:00:aa:bb:cc\nsname = fritz.box\noptions:\nOptions count is 11\ndhcp_message_type (uint8): ACK 0x5\nserver_identifier (ip): 192.168.178.1\nlease_time (uint32): 0x1baf80\nsubnet_mask (ip): 255.255.255.0\nrouter (ip_mult): {192.168.178.1}\ndomain_name_server (ip_mult): {192.168.178.1, 192.0.2.53}\ndomain_name (string): fritz.box\nend (none): \n";
    const SCUTIL: &str = "DNS configuration\n\nresolver #1\n  search domain[0] : example.ts.net\n  nameserver[0] : 100.100.100.100\n  nameserver[1] : fd7a:115c:a1e0::53\n  if_index : 22 (utun9)\n  flags    : Supplemental\n\nresolver #2\n  nameserver[0] : fe80::1%en0\n  nameserver[1] : 192.168.178.1\n  if_index : 8 (en0)\n\nresolver #3\n  domain   : fritz.box.\n  nameserver[0] : 100.100.100.100\n\nresolver #4\n  domain   : local\n  options  : mdns\n";

    #[test]
    fn route_wifi_and_utun() {
        let r = parse_route(ROUTE);
        assert_eq!(r.interface.as_deref(), Some("en0"));
        assert_eq!(r.gateway.as_deref(), Some("192.168.178.1"));
        assert_eq!(parse_route(ROUTE_UTUN).interface.as_deref(), Some("utun4"));
    }

    #[test]
    fn route_without_default_is_empty() {
        assert_eq!(
            parse_route("route: writing to routing socket: not in table\n"),
            Route::default()
        );
    }

    #[test]
    fn lease_fields() {
        let l = parse_lease(PACKET);
        assert_eq!(l.yiaddr, "192.168.178.20".parse().ok());
        assert_eq!(l.mask, "255.255.255.0".parse().ok());
        assert_eq!(l.router, "192.168.178.1".parse().ok());
        assert_eq!(l.server, "192.168.178.1".parse().ok());
        assert_eq!(l.dns.len(), 2);
        assert_eq!(l.domain.as_deref(), Some("fritz.box"));
    }

    #[test]
    fn lease_wpad_option_252() {
        let l = parse_lease(
            "yiaddr = 192.0.2.20\nproxy_auto_discovery (string): http://wpad.example.net/wpad.dat\n",
        );
        assert_eq!(l.wpad.as_deref(), Some("http://wpad.example.net/wpad.dat"));
        assert_eq!(parse_lease("router (ip_mult): {192.0.2.1}\n").wpad, None);
    }

    #[test]
    fn lease_empty_input() {
        assert_eq!(parse_lease(""), Lease::default());
    }

    #[test]
    fn scutil_keeps_only_global_resolvers() {
        assert_eq!(
            parse_scutil_dns(SCUTIL),
            vec![
                "100.100.100.100",
                "fd7a:115c:a1e0::53",
                "fe80::1%en0",
                "192.168.178.1"
            ]
        );
        assert!(parse_scutil_dns("").is_empty());
    }
}
