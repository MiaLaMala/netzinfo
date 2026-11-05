//! Linux: Default-Route aus `/proc/net/route`, Adresse über `getifaddrs`, DHCP aus
//! systemd-networkd, NetworkManager oder dhclient, DNS auch hinter systemd-resolved.
//! Kein Root, keine Shell. Die Parser sind reiner Text und laufen auf jedem System.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::hier::NetInfo;
use crate::subnetz;
use std::net::{IpAddr, Ipv4Addr};
use std::process::Command;

#[derive(Debug, Default, PartialEq)]
struct Lease {
    server: Option<Ipv4Addr>,
    dns: Vec<Ipv4Addr>,
    domain: Option<String>,
}

fn ips(werte: &str) -> Vec<Ipv4Addr> {
    werte
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect()
}

/// Schnittstelle und Gateway der Default-Route mit der kleinsten Metrik.
fn parse_route(text: &str) -> Option<(String, Ipv4Addr)> {
    let mut beste: Option<(u32, String, Ipv4Addr)> = None;
    for z in text.lines().skip(1) {
        let s: Vec<&str> = z.split_whitespace().collect();
        let &[name, ziel, gw, flags, _, _, metrik, maske, ..] = s.as_slice() else {
            continue;
        };
        let hex = |t| u32::from_str_radix(t, 16).ok();
        let (Some(ziel), Some(gw), Some(flags), Some(maske)) =
            (hex(ziel), hex(gw), hex(flags), hex(maske))
        else {
            continue;
        };
        let Ok(metrik) = metrik.parse::<u32>() else {
            continue;
        };
        // 0x1 = UP, 0x2 = GATEWAY; die Adressen stehen in Host-Reihenfolge (Little Endian)
        if ziel != 0
            || maske != 0
            || flags & 3 != 3
            || beste.as_ref().is_some_and(|b| b.0 <= metrik)
        {
            continue;
        }
        beste = Some((metrik, name.to_string(), Ipv4Addr::from(gw.to_ne_bytes())));
    }
    beste.map(|(_, n, g)| (n, g))
}

/// systemd-networkd: `/run/systemd/netif/leases/<ifindex>`, Zeilen `SCHLÜSSEL=Wert`.
fn parse_networkd(text: &str) -> Lease {
    let mut l = Lease::default();
    for (k, v) in text.lines().filter_map(|z| z.split_once('=')) {
        match k {
            "SERVER_ADDRESS" => l.server = v.trim().parse().ok(),
            "DNS" => l.dns = ips(v),
            "DOMAINNAME" => l.domain = Some(v.trim().to_string()).filter(|d| !d.is_empty()),
            _ => {}
        }
    }
    l
}

/// NetworkManager: `nmcli -t -f DHCP4 device show <if>`, Zeilen `DHCP4.OPTION[n]:name = wert`.
fn parse_nmcli(text: &str) -> Lease {
    let mut l = Lease::default();
    for z in text.lines() {
        let Some((_, opt)) = z.split_once(':') else {
            continue;
        };
        match opt.split_once(" = ") {
            Some(("dhcp_server_identifier", v)) => l.server = v.trim().parse().ok(),
            Some(("domain_name_servers", v)) => l.dns = ips(v),
            Some(("domain_name", v)) => {
                l.domain = Some(v.trim().to_string()).filter(|d| !d.is_empty())
            }
            _ => {}
        }
    }
    l
}

/// dhclient: `lease { ... }`-Blöcke, `dhclient.leases(5)`. Der letzte Block der Schnittstelle
/// gewinnt. Passt `fixed-address` nicht zur aktuellen Adresse, ist der Block von einem anderen
/// Netz übrig geblieben und zählt nicht.
fn parse_dhclient(text: &str, schnittstelle: &str, ip: Option<Ipv4Addr>) -> Lease {
    let mut beste = Lease::default();
    let mut aktuell = Lease::default();
    let (mut name, mut adresse) = (String::new(), None::<Ipv4Addr>);
    for z in text.lines().map(str::trim) {
        let z = z.strip_suffix(';').unwrap_or(z);
        if z.starts_with("lease") && z.ends_with('{') {
            aktuell = Lease::default();
            (name, adresse) = (String::new(), None);
        } else if z == "}" {
            let passt =
                name == schnittstelle && (ip.is_none() || adresse.is_none() || ip == adresse);
            if passt {
                beste = std::mem::take(&mut aktuell);
            }
        } else if let Some(v) = z.strip_prefix("interface ") {
            name = v.trim_matches('"').to_string();
        } else if let Some(v) = z.strip_prefix("fixed-address ") {
            adresse = v.trim().parse().ok();
        } else if let Some(v) = z.strip_prefix("option dhcp-server-identifier ") {
            aktuell.server = v.trim().parse().ok();
        } else if let Some(v) = z.strip_prefix("option domain-name-servers ") {
            aktuell.dns = ips(&v.replace(',', " "));
        } else if let Some(v) = z.strip_prefix("option domain-name ") {
            aktuell.domain = Some(v.trim().trim_matches('"').to_string()).filter(|d| !d.is_empty());
        }
    }
    beste
}

/// `/etc/resolv.conf`: `domain`, sonst das erste Wort von `search`.
fn parse_resolv_domain(text: &str) -> Option<String> {
    let wert = |schluessel: &str| {
        text.lines().find_map(|l| {
            let mut w = l.split_whitespace();
            (w.next()? == schluessel).then(|| w.next().map(str::to_string))?
        })
    };
    wert("domain").or_else(|| wert("search"))
}

/// `ip -o -4 addr show dev <if>`: `Some(true)`, wenn die Adresse `dynamic` ist (der Kernel
/// führt für sie eine Laufzeit, so setzen DHCP-Clients sie), `Some(false)`, wenn sie dauerhaft
/// eingestellt ist (`IFA_F_PERMANENT`), `None`, wenn die Adresse nicht in der Ausgabe steht.
fn parse_ip_addr(text: &str, ip: Ipv4Addr) -> Option<bool> {
    text.lines().find_map(|z| {
        let w: Vec<&str> = z.split_whitespace().collect();
        let i = w.iter().position(|t| *t == "inet")?;
        let adr: Ipv4Addr = w.get(i + 1)?.split('/').next()?.parse().ok()?;
        (adr == ip).then(|| w.contains(&"dynamic"))
    })
}

/// systemd-resolved: `resolvectl status`, Zeilen `DNS Servers: a b`, weitere Adressen in
/// eingerückten Folgezeilen. Format nach systemd `src/resolve/resolvectl.c`
/// (Ausgabe von `status`) und der Manpage resolvectl(1). `Fallback DNS Servers` zählt nicht.
fn parse_resolvectl(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut offen = false;
    for z in text.lines() {
        let (schluessel, wert) = z.split_once(':').unwrap_or(("", z));
        let adressen = |t: &str| -> Vec<String> {
            t.split_whitespace()
                .filter(|w| w.parse::<IpAddr>().is_ok())
                .map(str::to_string)
                .collect()
        };
        let neu = if schluessel.trim() == "DNS Servers" {
            offen = true;
            adressen(wert)
        } else if offen && !z.trim().is_empty() && adressen(z).len() == z.split_whitespace().count()
        {
            // continuation line: nothing but addresses
            adressen(z)
        } else {
            offen = false;
            Vec::new()
        };
        for a in neu {
            if !out.contains(&a) {
                out.push(a);
            }
        }
    }
    out
}

/// Kein Programm oder keine Antwort ist kein Fehler.
fn ausgabe(programm: &str, args: &[&str]) -> Option<String> {
    Command::new(programm)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// IPv4-Adresse und Präfix der Schnittstelle, `None` ohne Adresse.
fn adresse(schnittstelle: &str) -> Option<(Ipv4Addr, u8)> {
    let mut erste: *mut libc::ifaddrs = std::ptr::null_mut();
    let mut ergebnis = None;
    // SAFETY: Die Liste von getifaddrs wird nur gelesen und einmal freigegeben; Namen sind
    // NUL-terminierte C-Strings, Adresse und Maske der AF_INET-Einträge sind sockaddr_in.
    unsafe {
        if libc::getifaddrs(&mut erste) != 0 {
            return None;
        }
        let mut p = erste;
        while !p.is_null() {
            let a = &*p;
            p = a.ifa_next;
            if a.ifa_addr.is_null()
                || a.ifa_netmask.is_null()
                || i32::from((*a.ifa_addr).sa_family) != libc::AF_INET
                || std::ffi::CStr::from_ptr(a.ifa_name).to_bytes() != schnittstelle.as_bytes()
            {
                continue;
            }
            let v4 = |s: *const libc::sockaddr| {
                Ipv4Addr::from(u32::from_be(
                    (*s.cast::<libc::sockaddr_in>()).sin_addr.s_addr,
                ))
            };
            let maske = v4(a.ifa_netmask);
            ergebnis = subnetz::prefix_from_mask(maske)
                .ok()
                .map(|p| (v4(a.ifa_addr), p));
            break;
        }
        libc::freeifaddrs(erste);
    }
    ergebnis
}

/// Lease aus der ersten Quelle, die einen DHCP-Server nennt. Unlesbar heißt stumm.
fn dhcp(schnittstelle: &str, ip: Option<Ipv4Addr>) -> Lease {
    let networkd = std::fs::read_to_string(format!("/sys/class/net/{schnittstelle}/ifindex"))
        .ok()
        .and_then(|i| {
            std::fs::read_to_string(format!("/run/systemd/netif/leases/{}", i.trim())).ok()
        })
        .map(|t| parse_networkd(&t));
    let nmcli = || {
        ausgabe(
            "nmcli",
            &["-t", "-f", "DHCP4", "device", "show", schnittstelle],
        )
        .map(|t| parse_nmcli(&t))
    };
    let dhclient = || {
        let mut dateien: Vec<_> = ["/var/lib/dhcp", "/var/lib/dhclient"]
            .iter()
            .filter_map(|d| std::fs::read_dir(d).ok())
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension().is_some_and(|e| e == "leases")
                    && p.file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with("dhclient"))
            })
            .collect();
        dateien.sort();
        dateien
            .iter()
            .filter_map(|p| std::fs::read_to_string(p).ok())
            .map(|t| parse_dhclient(&t, schnittstelle, ip))
            .find(|l| l.server.is_some())
    };
    networkd
        .filter(|l| l.server.is_some())
        .or_else(|| nmcli().filter(|l| l.server.is_some()))
        .or_else(dhclient)
        .unwrap_or_default()
}

pub fn lies_netzdaten() -> Result<NetInfo, String> {
    let (interface, gateway) = std::fs::read_to_string("/proc/net/route")
        .ok()
        .and_then(|t| parse_route(&t))
        .ok_or("Kein Netz gefunden: Es gibt keine Default-Route. Verbinde den Rechner mit dem Netz und versuche es noch mal.")?;
    let adresse = adresse(&interface);
    let mut lease = dhcp(&interface, adresse.map(|a| a.0));
    let (mut fest, mut geprueft) = (false, Vec::new());
    if lease.server.is_none() {
        // Ohne Lease: Hat der Kernel die Adresse als dauerhaft markiert, ist sie von Hand
        // gesetzt. Das gilt für networkd, NetworkManager und ifupdown gleich.
        fest = adresse
            .and_then(|(ip, _)| {
                let t = ausgabe("ip", &["-o", "-4", "addr", "show", "dev", &interface])?;
                parse_ip_addr(&t, ip)
            })
            .is_some_and(|dynamisch| !dynamisch);
        if !fest {
            geprueft = ["systemd-networkd", "NetworkManager", "dhclient"]
                .map(String::from)
                .to_vec();
        }
        // Nur ohne Lease: Mit Lease bliebe der Fingerabdruck sonst nicht derselbe wie bisher.
        lease.domain = lease.domain.or_else(|| {
            parse_resolv_domain(&std::fs::read_to_string("/etc/resolv.conf").unwrap_or_default())
        });
    }
    Ok(NetInfo {
        ip: adresse.map(|a| a.0),
        subnet: adresse.and_then(|(ip, p)| subnetz::calc(ip, p).ok()),
        router: Some(gateway),
        dhcp_server: lease.server,
        dhcp_dns: lease.dns,
        system_dns: system_dns(),
        domain: lease.domain,
        interface,
        fest,
        dhcp_geprueft: geprueft,
    })
}

/// DNS-Server, die das System fragt. Steht in `/etc/resolv.conf` nur der Stub von
/// systemd-resolved, gelten die echten Server aus `/run/systemd/resolve/resolv.conf`.
pub fn system_dns() -> Vec<String> {
    system_dns_aus(
        &std::fs::read_to_string("/etc/resolv.conf").unwrap_or_default(),
        || {
            std::fs::read_to_string("/run/systemd/resolve/resolv.conf")
                .ok()
                .or_else(|| {
                    // no resolv.conf from systemd-resolved: ask `resolvectl` if it exists
                    let l = parse_resolvectl(&ausgabe("resolvectl", &["status"])?);
                    Some(l.iter().map(|s| format!("nameserver {s}\n")).collect())
                })
        },
    )
}

fn system_dns_aus(resolv: &str, echt: impl FnOnce() -> Option<String>) -> Vec<String> {
    let liste = nameserver(resolv);
    let stub = !liste.is_empty() && liste.iter().all(|s| s == "127.0.0.53" || s == "127.0.0.54");
    if !stub {
        return liste;
    }
    match echt().map(|t| nameserver(&t)) {
        Some(echt) if !echt.is_empty() => echt,
        _ => liste,
    }
}

pub fn wpad_dhcp(_schnittstelle: &str) -> Option<String> {
    None
}

fn nameserver(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| Some(l.trim().strip_prefix("nameserver ")?.trim().to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUTE: &str = include_str!("../../testdata/linux/proc_net_route");
    const NETWORKD: &str = include_str!("../../testdata/linux/networkd_lease");
    const NMCLI: &str = include_str!("../../testdata/linux/nmcli_dhcp4");
    const STUB: &str = include_str!("../../testdata/linux/resolv_stub.conf");
    const DHCLIENT: &str = include_str!("../../testdata/linux/dhclient.leases");
    const IP_ADDR: &str = include_str!("../../testdata/linux/ip_addr");
    const RESOLVECTL: &str = include_str!("../../testdata/linux/resolvectl_status");
    const ECHT: &str = include_str!("../../testdata/linux/resolved_resolv.conf");

    #[test]
    fn nameserver_aus_resolv_conf() {
        assert_eq!(
            nameserver("# x\nnameserver 192.0.2.53\nsearch example.net\nnameserver 2001:db8::53\n"),
            ["192.0.2.53", "2001:db8::53"]
        );
        assert!(nameserver("nothing").is_empty());
    }

    #[test]
    fn default_route_mit_kleinster_metrik() {
        // wlan0 (600) und eth0 (100) sind Default-Routen, tun0 hat kein Gateway-Flag
        assert_eq!(
            parse_route(ROUTE),
            Some(("eth0".into(), "192.0.2.1".parse().unwrap()))
        );
    }

    #[test]
    fn keine_default_route() {
        let nur_netz = ROUTE
            .lines()
            .filter(|l| !l.contains("\t0003\t"))
            .collect::<Vec<_>>();
        assert_eq!(parse_route(&nur_netz.join("\n")), None);
        assert_eq!(parse_route(""), None);
    }

    #[test]
    fn lease_networkd_und_nmcli_gleich() {
        let erwartet = Lease {
            server: "192.0.2.2".parse().ok(),
            dns: vec![
                "192.0.2.53".parse().unwrap(),
                "198.51.100.53".parse().unwrap(),
            ],
            domain: Some("example.net".into()),
        };
        assert_eq!(parse_networkd(NETWORKD), erwartet);
        assert_eq!(parse_nmcli(NMCLI), erwartet);
        assert_eq!(parse_networkd(""), Lease::default());
        assert_eq!(parse_nmcli("Fehler"), Lease::default());
    }

    #[test]
    fn stub_von_systemd_resolved_wird_ersetzt() {
        let echt = || Some(ECHT.to_string());
        assert_eq!(system_dns_aus(STUB, echt), ["192.0.2.53", "2001:db8::53"]);
        // echte Server in resolv.conf bleiben, die Ersatzdatei wird nicht gebraucht
        assert_eq!(
            system_dns_aus("nameserver 192.0.2.1\n", || panic!("nicht lesen")),
            ["192.0.2.1"]
        );
        // fehlt die Ersatzdatei, bleibt der Stub
        assert_eq!(system_dns_aus(STUB, || None), ["127.0.0.53"]);
    }

    #[test]
    fn dhclient_neuester_block_der_schnittstelle_gewinnt() {
        let ip = "192.168.178.20".parse().ok();
        let l = parse_dhclient(DHCLIENT, "eth0", ip);
        assert_eq!(l.server, "192.168.178.1".parse().ok());
        assert_eq!(l.domain.as_deref(), Some("fritz.box"));
        assert_eq!(l.dns.len(), 2);
        // other interface, and no block at all
        assert_eq!(
            parse_dhclient(DHCLIENT, "wlan0", None).server,
            "192.0.2.2".parse().ok()
        );
        assert_eq!(parse_dhclient(DHCLIENT, "eth9", None), Lease::default());
        assert_eq!(parse_dhclient("", "eth0", None), Lease::default());
    }

    #[test]
    fn dhclient_block_mit_fremder_adresse_zaehlt_nicht() {
        let alt = "192.0.2.99".parse().ok();
        assert_eq!(parse_dhclient(DHCLIENT, "eth0", alt), Lease::default());
    }

    #[test]
    fn domain_aus_resolv_conf() {
        assert_eq!(
            parse_resolv_domain("search a.example b.example\ndomain fritz.box\n").as_deref(),
            Some("fritz.box")
        );
        assert_eq!(
            parse_resolv_domain("nameserver 192.0.2.1\nsearch a.example b.example\n").as_deref(),
            Some("a.example")
        );
        assert_eq!(parse_resolv_domain("nameserver 192.0.2.1\nsearch\n"), None);
        assert_eq!(parse_resolv_domain(""), None);
    }

    #[test]
    fn feste_und_dynamische_adresse() {
        let ip = |s: &str| s.parse().unwrap();
        assert_eq!(parse_ip_addr(IP_ADDR, ip("192.168.178.20")), Some(true));
        assert_eq!(parse_ip_addr(IP_ADDR, ip("192.0.2.10")), Some(false));
        assert_eq!(parse_ip_addr(IP_ADDR, ip("198.51.100.7")), Some(false));
        assert_eq!(parse_ip_addr(IP_ADDR, ip("203.0.113.1")), None);
        assert_eq!(parse_ip_addr("", ip("192.0.2.10")), None);
    }

    #[test]
    fn resolvectl_status_liest_nur_dns_servers() {
        assert_eq!(
            parse_resolvectl(RESOLVECTL),
            ["192.168.178.1", "2001:db8::1", "198.51.100.53"]
        );
        assert!(parse_resolvectl("").is_empty());
    }
}
