//! `netzinfo hier` und `netzinfo subnetz`: siehe Issue #1.

use crate::explain;
use crate::subnetz::{self, Subnet};
use std::net::Ipv4Addr;

/// What we know about the current network. Fields are None when the system has no answer.
#[derive(Debug, Default, PartialEq, serde::Serialize)]
pub struct NetInfo {
    pub interface: String,
    pub ip: Option<Ipv4Addr>,
    /// None on VPN tunnels (utun) and other interfaces without DHCP.
    pub subnet: Option<Subnet>,
    pub router: Option<Ipv4Addr>,
    pub dhcp_server: Option<Ipv4Addr>,
    /// DNS servers handed out by DHCP.
    pub dhcp_dns: Vec<Ipv4Addr>,
    /// DNS servers the system really asks first (scutil --dns on macOS, resolv.conf on Linux), IPv4 and IPv6.
    pub system_dns: Vec<String>,
    pub domain: Option<String>,
    /// The address is configured by hand (Linux: the kernel marks it permanent, no lease found).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fest: bool,
    /// DHCP sources that were looked at without finding a lease (Linux), for `--erklaer`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dhcp_geprueft: Vec<String>,
}

/// Anzeige für Werte, die nur eine DHCP-Antwort liefert.
const KEIN_DHCP: &str = "nicht ermittelt";
/// Anzeige dafür, dass die Adresse von Hand eingestellt ist.
const FEST: &str = "keiner, feste Adresse";

fn show<T: std::fmt::Display>(v: Option<T>) -> String {
    v.map_or("unbekannt".into(), |v| v.to_string())
}

fn list<T: std::fmt::Display>(v: &[T]) -> String {
    if v.is_empty() {
        "unbekannt".into()
    } else {
        v.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Reads the current network from the system, see `plattform`.
pub fn collect() -> Result<NetInfo, String> {
    crate::plattform::lies_netzdaten()
}

pub fn run(args: &[String], explain_on: bool) -> Result<(), String> {
    crate::optionen::nur(args, &[], "hier")?;
    let a = crate::netze::aktuell()?;
    crate::netze::hier_hinweis(&a, explain_on);
    let n = a.info;
    let vpn = ["utun", "tun", "wg", "tailscale"]
        .iter()
        .any(|p| n.interface.starts_with(p));
    println!("Schnittstelle: {}", n.interface);
    explain(
        explain_on,
        &format!(
            "Die Default-Route sagt, über welche Schnittstelle Pakete ins Internet gehen. {}",
            if vpn {
                "Diese Schnittstelle ist ein Tunnel, also ein VPN wie Tailscale oder WireGuard: Dein Verkehr geht gerade durch den Tunnel, nicht direkt ins Netz."
            } else {
                "Beim Mac ist „en0“ meistens das WLAN, andere „en“-Nummern sind Kabel oder Adapter. Unter Linux steht „eth“ oder „enp“ für Kabel, „wlan“ oder „wlp“ für WLAN."
            }
        ),
    );
    println!("IP-Adresse:    {}", show(n.ip));
    explain(
        explain_on,
        if n.fest {
            "Diese IPv4-Adresse ist fest eingestellt: Sie steht in der Konfiguration des Rechners, kein DHCP-Server hat sie geliehen und sie läuft nicht ab."
        } else if n.dhcp_server.is_some() {
            "Die IPv4-Adresse hat dir der DHCP-Server geliehen. Im Heimnetz ist sie privat (10.x, 172.16 bis 172.31, 192.168.x) und wird per NAT ins Internet übersetzt."
        } else {
            "Zu dieser Adresse wurde keine DHCP-Antwort gefunden: Sie kommt von der Gegenstelle eines Tunnels (z. B. Tailscale oder WireGuard) oder ist fest eingestellt."
        },
    );
    match &n.subnet {
        Some(s) => {
            println!("Maske:         {} (/{})", s.mask, s.prefix);
            println!("Netzadresse:   {}", s.network);
            println!("Broadcast:     {}", s.broadcast);
            println!(
                "Hostbereich:   {} bis {} ({} {})",
                s.first,
                s.last,
                s.hosts,
                if s.hosts == 1 { "Host" } else { "Hosts" }
            );
            explain(
                explain_on,
                "Die Maske trennt Netzanteil und Hostanteil. IP UND Maske ergibt die Netzadresse, alle Hostbits auf 1 ergeben den Broadcast. Den Rechenweg zeigt `netzinfo subnetz <IP> <Maske> --erklaer`.",
            );
        }
        None => {
            println!("Maske:         unbekannt");
            explain(
                explain_on,
                "Für diese Schnittstelle liegt keine Maske vor, etwa bei einem VPN-Tunnel ohne DHCP. Deshalb lässt sich das Subnetz nicht ausrechnen.",
            );
        }
    }
    println!("Router:        {}", show(n.router));
    explain(
        explain_on,
        "Der Router (Gateway) ist die Tür aus dem eigenen Subnetz. Alles, was nicht im Subnetz liegt, schickt der Rechner an ihn.",
    );
    let dhcp = n.dhcp_server.is_some();
    let keiner = if n.fest { FEST } else { KEIN_DHCP };
    println!(
        "DHCP-Server:   {}",
        if dhcp {
            show(n.dhcp_server)
        } else {
            keiner.into()
        }
    );
    explain(
        explain_on,
        if n.fest {
            "Bei einer festen Adresse gibt es keinen DHCP-Server, den man fragen könnte. Wer die Adresse vergibt, steht in der Einstellung des Rechners selbst."
        } else if dhcp {
            "Der DHCP-Server vergibt IP, Maske, Router und DNS (Ablauf DORA: Discover, Offer, Request, Ack). Im Heimnetz ist er fast immer der Router."
        } else {
            "Eine DHCP-Antwort ließ sich nicht lesen. Das ist bei Tunneln und festen Adressen normal. Unter Linux liest Netzinfo sie nur mit systemd-networkd, NetworkManager oder dhclient, bei anderen DHCP-Clients bleibt sie leer."
        },
    );
    if !dhcp && !n.fest && !n.dhcp_geprueft.is_empty() {
        explain(
            explain_on,
            &format!(
                "Geprüft: {}; keine liefert einen Lease.",
                n.dhcp_geprueft.join(", ")
            ),
        );
    }
    println!(
        "DNS (DHCP):    {}",
        if dhcp {
            list(&n.dhcp_dns)
        } else {
            keiner.into()
        }
    );
    println!("DNS (System):  {}", list(&n.system_dns));
    let magic = n.system_dns.iter().any(|d| d == "100.100.100.100");
    explain(
        explain_on,
        if magic {
            "DNS übersetzt Namen in IP-Adressen. 100.100.100.100 ist der DNS-Dienst von Tailscale (MagicDNS), er sitzt vor dem DNS aus dem DHCP und reicht normale Fragen weiter."
        } else {
            "DNS übersetzt Namen in IP-Adressen. „System“ ist, was der Rechner wirklich fragt, „DHCP“ ist, was das Netz angeboten hat. Beides sollte meist übereinstimmen."
        },
    );
    println!(
        "Domain:        {}",
        match (&n.domain, dhcp || n.fest) {
            (Some(d), _) => d.clone(),
            (None, true) => "keine".to_string(),
            (None, false) => KEIN_DHCP.into(),
        }
    );
    explain(
        explain_on,
        "Die Domain wird an unvollständige Namen angehängt (Suchdomain). Sie kommt vom DHCP-Server oder, ohne Lease, aus der Datei resolv.conf.",
    );
    crate::ipv6router::zeigen(&n, explain_on);
    Ok(())
}

pub fn run_subnet(args: &[String], explain_on: bool) -> Result<(), String> {
    crate::optionen::nur(args, &[], "subnetz")?;
    let (ip, prefix) = subnetz::parse_args(args)?;
    let s = subnetz::calc(ip, prefix)?;
    println!("Adresse:       {ip}/{prefix}");
    println!("Maske:         {} ({})", s.mask, subnetz::binary(s.mask));
    println!("Netzadresse:   {}", s.network);
    println!("Broadcast:     {}", s.broadcast);
    println!("Erster Host:   {}", s.first);
    println!("Letzter Host:  {}", s.last);
    println!("Anzahl Hosts:  {}", s.hosts);
    if explain_on {
        println!();
        explain(true, "Rechenweg wie in der Prüfung:");
        println!("  IP      {}  {ip}", subnetz::binary(ip));
        println!("  Maske   {}  {}", subnetz::binary(s.mask), s.mask);
        println!("  UND     {}  {}", subnetz::binary(s.network), s.network);
        explain(
            true,
            "UND-Verknüpfung: Ein Bit bleibt nur 1, wenn es in IP und Maske 1 ist. Das Ergebnis ist die Netzadresse.",
        );
        if prefix < 32 {
            let host = Ipv4Addr::from(u32::from(ip) & !u32::from(s.mask));
            let bits = 32 - u32::from(prefix);
            println!("  Host    {}  {host}", subnetz::binary(host));
            explain(
                true,
                &format!(
                    "Hostanteil: die letzten {bits} Bit der IP (IP UND invertierte Maske). Es bleibt der Teil, der das Gerät im Netz benennt."
                ),
            );
            explain(
                true,
                &format!(
                    "Broadcast: alle {bits} Hostbits auf 1 setzen, hier {}.",
                    subnetz::binary(s.broadcast)
                ),
            );
        }
        explain(true, &match prefix {
            32 => "Bei /32 gibt es nur diesen einen Host, kein Netz mit Broadcast.".to_string(),
            31 => "Bei /31 gibt es keine Netz- und Broadcastadresse, beide Adressen sind Hosts (RFC 3021, Punkt-zu-Punkt-Verbindung).".to_string(),
            _ => format!("Hosts: 2^{} minus 2 (Netzadresse und Broadcast sind nicht vergebbar) = {}.", 32 - u32::from(prefix), s.hosts),
        });
    }
    Ok(())
}
