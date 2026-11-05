//! `netzinfo merken`, `netzinfo netze`, `netzinfo vergessen` and the recognition in `netzinfo hier` (issue #5).
//!
//! The store functions take the file path as a parameter; only `data_path` reads `NETZ_DATEN`.

use crate::explain;
use crate::hier::{self, NetInfo};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Kind of a core error, for the app (`{ art, text }`). The CLI keeps plain sentences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Fehlerart {
    /// The current or the named network is not stored (`netzinfo merken`).
    NichtGemerkt,
    /// The network is not marked „meins“, so nothing is sent.
    NichtMeins,
    Sonstiges,
}

/// Error of an app command: the sentence plus its kind, so the UI never reads the sentence.
/// Lives here because the app crate has no serde of its own.
#[derive(Debug, Serialize)]
pub struct AppFehler {
    pub art: Fehlerart,
    pub text: String,
}

impl From<String> for AppFehler {
    fn from(text: String) -> Self {
        AppFehler {
            art: fehlerart(&text),
            text,
        }
    }
}

/// Sentences the app views depend on, see `fehlerart`.
pub const NICHT_GEMERKT_PRUEFEN: &str = "Dieses Netz ist nicht gemerkt, ich habe nichts zum Vergleichen. Speichere es mit `netzinfo merken <Name>` und prüfe dann noch mal.";
pub const NICHT_GEMERKT_MESSEN: &str = "Dieses Netz ist nicht gemerkt. Merke es zuerst mit `netzinfo merken <Name>`, dann kann ich Messungen darunter speichern.";

/// The one place that maps a core error sentence to its kind. The sentences keep these words;
/// the tests in `netze`, `geraete` and `bonjour` fail when one of them drops them.
pub fn fehlerart(satz: &str) -> Fehlerart {
    if satz.contains("nicht gemerkt") {
        Fehlerart::NichtGemerkt
    } else if satz.contains("als „meins“ markiert") {
        Fehlerart::NichtMeins
    } else {
        Fehlerart::Sonstiges
    }
}

/// What identifies a network: the DHCP data the router hands out.
// ponytail: two networks with the same factory router (two FRITZ!Boxes on 192.168.178.1 with
// domain fritz.box) look identical. Upgrade path: also compare the DNS/TLS results from #6
// or the router's HTTPS certificate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fingerprint {
    pub router: Ipv4Addr,
    pub dhcp_server: Ipv4Addr,
    pub domain: Option<String>,
    /// Network address and prefix, e.g. "192.168.178.0/24".
    pub subnet: String,
    /// Hash of the BSSID (access point) when the network was remembered, `None` without the
    /// location permission (#35). Never the raw BSSID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bssid_hash: Option<String>,
}

impl Fingerprint {
    /// Same network? Router, DHCP server, domain and subnet decide. The access point does not:
    /// a mesh system or a repeater has several, and roaming must not make the network unknown.
    pub fn gleiches_netz(&self, other: &Self) -> bool {
        self.key() == other.key()
    }

    /// Same access point? `None` if either side has no hash: then it counts neither for nor
    /// against. Rules about a new access point live in `wlan::funk_pruefen`.
    pub fn gleicher_funkpunkt(&self, other: &Self) -> Option<bool> {
        Some(self.bssid_hash.as_ref()? == other.bssid_hash.as_ref()?)
    }

    /// Stable string key for per-network data in other files (survives renaming a network).
    pub fn key(&self) -> String {
        let domain = self.domain.as_deref().unwrap_or("");
        format!(
            "{}|{}|{}|{}",
            self.router, self.dhcp_server, domain, self.subnet
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Netz {
    pub name: String,
    pub fingerprint: Fingerprint,
    pub meins: bool,
    /// Unix seconds.
    pub first_seen: u64,
    /// Unix seconds.
    pub last_seen: u64,
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Fingerprint of the current network, or an error saying why there is none.
pub fn fingerprint(n: &NetInfo) -> Result<Fingerprint, String> {
    match (&n.router, &n.dhcp_server, &n.subnet) {
        (Some(router), Some(dhcp_server), Some(s)) => Ok(Fingerprint {
            router: *router,
            dhcp_server: *dhcp_server,
            domain: n.domain.clone(),
            subnet: format!("{}/{}", s.network, s.prefix),
            bssid_hash: None,
        }),
        _ if n.fest => Err("Netze mit fester Adresse kann Netzinfo noch nicht wiedererkennen, weil der Fingerabdruck die Antwort eines DHCP-Servers braucht.".into()),
        _ => Err("Ohne DHCP-Antwort gibt es keinen Fingerabdruck, das ist zum Beispiel bei einem VPN-Tunnel so. Verbinde dich direkt mit dem WLAN oder Kabel und versuche es noch mal.".into()),
    }
}

/// `NETZ_DATEN` (a file), else the usual per-user data folder of the system.
pub fn data_path() -> Result<PathBuf, String> {
    data_path_from(std::env::consts::OS, |k| std::env::var_os(k))
}

/// Pure version of `data_path`: system name and environment are parameters, so tests cover every system.
/// macOS `~/Library/Application Support/netzinfo/netze.json`, Windows `%LOCALAPPDATA%\netzinfo\netze.json`
/// (local, not Roaming), else `$XDG_DATA_HOME` or `~/.local/share`.
fn data_path_from(
    os: &str,
    env: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    let get = |k| env(k).filter(|v| !v.is_empty());
    if let Some(p) = get("NETZ_DATEN") {
        return Ok(PathBuf::from(p));
    }
    let fehlt = |v: &str| {
        format!(
            "Der Ordner für gemerkte Netze ist unbekannt ({v} fehlt). Setze `NETZ_DATEN` auf eine Datei."
        )
    };
    let base = match os {
        "macos" => PathBuf::from(get("HOME").ok_or_else(|| fehlt("HOME"))?)
            .join("Library/Application Support"),
        "windows" => PathBuf::from(get("LOCALAPPDATA").ok_or_else(|| fehlt("LOCALAPPDATA"))?),
        _ => match get("XDG_DATA_HOME") {
            Some(x) => PathBuf::from(x),
            None => PathBuf::from(get("HOME").ok_or_else(|| fehlt("HOME"))?).join(".local/share"),
        },
    };
    Ok(base.join("netzinfo").join("netze.json"))
}

/// Reads the store. A missing file is an empty list. A file that cannot be read or parsed is
/// moved to `netze.json.kaputt-<secs>` and never overwritten; if that fails, nothing continues.
pub fn load(path: &Path) -> Result<Vec<Netz>, String> {
    load_json(path)
}

/// Same rules as `load` for any JSON file of Netzinfo (e.g. `data_path()?.with_file_name("x.json")`).
/// A missing file gives `T::default()`.
pub fn load_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(e) => return set_aside(path, &format!("nicht lesbar ({})", crate::io_satz(&e))),
    };
    match serde_json::from_str(&text) {
        Ok(data) => Ok(data),
        Err(e) => set_aside(path, &format!("kaputt ({e})")),
    }
}

fn set_aside<T: Default>(path: &Path, why: &str) -> Result<T, String> {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".kaputt-{}", now()));
    let aside = PathBuf::from(name);
    std::fs::rename(path, &aside).map_err(|e| {
        format!(
            "Die Datei {} ist {why}, und ich konnte sie nicht beiseitelegen ({}). Es wurde nichts geschrieben. Prüfe die Rechte oder lege die Datei von Hand weg.",
            path.display(),
            crate::io_satz(&e)
        )
    })?;
    eprintln!(
        "Hinweis: Die Datei {} war {why}. Ich habe sie als {} beiseitegelegt und fange leer an.",
        path.display(),
        aside.display()
    );
    Ok(T::default())
}

/// Writes a temp file next to `path`, then renames it over `path`.
pub fn save<T: Serialize + ?Sized>(path: &Path, list: &T) -> Result<(), String> {
    let err = |e: std::io::Error| {
        format!(
            "Die Datei {} ließ sich nicht speichern ({}). Prüfe den Ordner und versuche es noch mal.",
            path.display(),
            crate::io_satz(&e)
        )
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let json = serde_json::to_string_pretty(list)
        .map_err(|e| format!("Die gemerkten Netze ließen sich nicht umwandeln ({e})."))?;
    // Eigener Name je Aufruf: App, Wache und Kommandozeile schreiben gleichzeitig, eine
    // gemeinsame Zwischendatei würde sich gegenseitig überschreiben oder wegnehmen.
    static ZAEHLER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut name = path.as_os_str().to_owned();
    name.push(format!(
        ".tmp{}-{}",
        std::process::id(),
        ZAEHLER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let tmp = PathBuf::from(name);
    let write = || -> std::io::Result<()> {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
        let f = o.open(&tmp)?;
        std::io::Write::write_all(&mut &f, json.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        err(e)
    })
}

/// Hält die Sperre einer Speicherdatei, bis sie fällt.
pub struct Sperre(#[allow(dead_code)] Option<std::fs::File>);

/// Sperre für „lesen, ändern, schreiben“ einer Speicherdatei: Wer sie vor `load_json` nimmt und
/// bis nach `save` hält, überschreibt keine Änderung eines anderen Prozesses (App, Wache,
/// Kommandozeile). Wartet höchstens 5 s und macht dann ohne Sperre weiter: ein hängender
/// Prozess darf das Speichern nicht dauerhaft blockieren. Ohne Sperrdatei (kein Schreibrecht)
/// ebenso; das eigentliche Speichern meldet dann den Satz dazu.
pub fn sperre(path: &Path) -> Sperre {
    // Gleiche Sperre wie `crate::sperre`, nur ohne Abbruch: ihr Satz kommt hier nicht weiter.
    Sperre(crate::sperre(path).ok())
}

pub fn find(list: &[Netz], fp: &Fingerprint) -> Option<usize> {
    list.iter().position(|n| n.fingerprint.gleiches_netz(fp))
}

/// Stores the network under `name`. A known fingerprint is renamed/updated, not duplicated.
/// `meins` replaces the old marking, so `merken <Name>` without `--meins` takes it back.
pub fn remember(
    list: &mut Vec<Netz>,
    name: &str,
    fp: Fingerprint,
    meins: bool,
    now: u64,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Der Name ist leer. Beispiel: `netzinfo merken WG`.".into());
    }
    let known = find(list, &fp);
    if let Some(other) = list.iter().position(|n| n.name == name)
        && Some(other) != known
    {
        return Err(format!(
            "Der Name „{name}“ ist schon für ein anderes Netz vergeben. Nimm einen anderen Namen oder `netzinfo vergessen {name}`."
        ));
    }
    match known {
        Some(i) => {
            let n = &mut list[i];
            n.name = name.to_string();
            n.meins = meins;
            n.last_seen = now;
        }
        None => list.push(Netz {
            name: name.to_string(),
            fingerprint: fp,
            meins,
            first_seen: now,
            last_seen: now,
        }),
    }
    Ok(())
}

pub fn forget(list: &mut Vec<Netz>, name: &str) -> Result<(), String> {
    let i = by_name(list, name)?;
    list.remove(i);
    Ok(())
}

/// True if the current network is stored with `meins: true`. Any problem counts as false.
pub fn current_is_meins() -> bool {
    let known = || -> Result<bool, String> {
        let fp = fingerprint(&hier::collect()?)?;
        let list = load(&data_path()?)?;
        Ok(find(&list, &fp).is_some_and(|i| list[i].meins))
    };
    known().unwrap_or(false)
}

/// "Mo 26.10.2026, 21:30 (UTC)" from Unix seconds, std only.
// ponytail: UTC, not local time. Upgrade path: libc localtime_r if the offset matters.
pub fn format_utc(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rest = secs % 86400;
    let wd = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][((days + 3) % 7) as usize];
    // days since 1970-01-01 to y-m-d (Howard Hinnant's civil_from_days)
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{wd} {d:02}.{m:02}.{y}, {:02}:{:02} (UTC)",
        rest / 3600,
        rest % 3600 / 60
    )
}

/// The current network and whether it is known.
#[derive(Debug, Serialize)]
pub struct Aktuell {
    pub info: NetInfo,
    /// The stored network as it was before this visit (`last_seen` is the previous visit, the
    /// file is already updated). `None`: new network, or recognition not possible.
    pub netz: Option<Netz>,
    /// Why there is no fingerprint (no DHCP, e.g. VPN tunnel).
    pub erkennung_fehler: Option<String>,
    /// A problem with the store file. Never fatal.
    pub hinweis: Option<String>,
}

/// Reads the current network, recognises it and updates `last_seen` of a known one.
pub fn aktuell() -> Result<Aktuell, String> {
    Ok(erkennen(hier::collect()?, data_path()))
}

fn erkennen(info: NetInfo, path: Result<PathBuf, String>) -> Aktuell {
    let mut a = Aktuell {
        info,
        netz: None,
        erkennung_fehler: None,
        hinweis: None,
    };
    let fp = match fingerprint(&a.info) {
        Ok(fp) => fp,
        Err(e) => {
            a.erkennung_fehler = Some(e);
            return a;
        }
    };
    let path = match path {
        Ok(p) => p,
        Err(e) => {
            a.hinweis = Some(e);
            return a;
        }
    };
    // Sperre bis nach `save`: ein gleichzeitiges `merken` darf nicht verloren gehen.
    let _sperre = sperre(&path);
    let mut list = match load(&path) {
        Ok(l) => l,
        Err(e) => {
            a.hinweis = Some(e);
            return a;
        }
    };
    if let Some(i) = find(&list, &fp) {
        a.netz = Some(list[i].clone());
        list[i].last_seen = now();
        if let Err(e) = save(&path, &list) {
            a.hinweis = Some(e);
        }
    }
    a
}

/// First line of `netzinfo hier`.
pub fn hier_hinweis(a: &Aktuell, explain_on: bool) {
    if let Some(e) = &a.erkennung_fehler {
        println!("{e}");
        return;
    }
    match &a.netz {
        Some(n) => println!(
            "Bekanntes Netz: {}, zuletzt am {}",
            n.name,
            format_utc(n.last_seen)
        ),
        // store unreadable: only the note, no explanation
        None if a.hinweis.is_some() => {}
        None => crate::satz("Neues Netz. Mit `netzinfo merken <Name>` merkst du es dir."),
    }
    if let Some(h) = &a.hinweis {
        crate::satz(&format!("Hinweis: {h}"));
        if a.netz.is_none() {
            return;
        }
    }
    explain(
        explain_on,
        "Ein Fingerabdruck besteht aus Router-IP, DHCP-Server, Domain und Subnetz. Diese Werte hat der DHCP-Server des Netzes vergeben, sie bleiben bei jedem Besuch gleich und unterscheiden sich meist von Netz zu Netz. So erkenne ich ein Netz wieder, ohne WLAN-Name oder MAC-Adresse zu brauchen.",
    );
}

/// Loads the list, lets `f` change it, saves it, returns what `f` returned.
fn aendern<T>(
    path: &Path,
    f: impl FnOnce(&mut Vec<Netz>) -> Result<T, String>,
) -> Result<T, String> {
    let _sperre = sperre(path);
    let mut list = load(path)?;
    let out = f(&mut list)?;
    save(path, &list)?;
    Ok(out)
}

/// Remembers the current network. Like `remember`: `meins` replaces the old marking.
pub fn merken(name: &str, meins: bool) -> Result<Netz, String> {
    let mut fp = fingerprint(&hier::collect()?)?;
    let path = data_path()?;
    fp.bssid_hash = crate::wlan::bssid_hash_jetzt(&path.with_file_name("salz.json"));
    merken_in(&path, name, fp, meins)
}

fn merken_in(path: &Path, name: &str, fp: Fingerprint, meins: bool) -> Result<Netz, String> {
    aendern(path, |list| {
        remember(list, name, fp.clone(), meins, now())?;
        find(list, &fp)
            .map(|i| list[i].clone())
            .ok_or_else(|| "Das Netz ließ sich nicht speichern.".into())
    })
}

/// Gives the network `alt` the name `neu`; `meins` and all measurements stay.
pub fn umbenennen(alt: &str, neu: &str) -> Result<Netz, String> {
    aendern(&data_path()?, |list| rename(list, alt, neu))
}

/// Marks the network `name` as „meins“ or takes the mark back.
pub fn markieren(name: &str, meins: bool) -> Result<Netz, String> {
    aendern(&data_path()?, |list| mark(list, name, meins))
}

pub fn vergessen(name: &str) -> Result<(), String> {
    aendern(&data_path()?, |list| forget(list, name))
}

pub fn liste() -> Result<Vec<Netz>, String> {
    load(&data_path()?)
}

fn by_name(list: &[Netz], name: &str) -> Result<usize, String> {
    list.iter().position(|n| n.name == name).ok_or_else(|| {
        format!("Ein Netz „{name}“ ist nicht gemerkt. `netzinfo netze` zeigt die Liste.")
    })
}

fn rename(list: &mut [Netz], alt: &str, neu: &str) -> Result<Netz, String> {
    let i = by_name(list, alt)?;
    let neu = neu.trim();
    if neu.is_empty() {
        return Err("Der neue Name ist leer. Nimm einen Namen wie „WG“.".into());
    }
    if neu != alt && list.iter().any(|n| n.name == neu) {
        return Err(format!(
            "Der Name „{neu}“ ist schon für ein anderes Netz vergeben. Nimm einen anderen Namen."
        ));
    }
    list[i].name = neu.to_string();
    Ok(list[i].clone())
}

fn mark(list: &mut [Netz], name: &str, meins: bool) -> Result<Netz, String> {
    let i = by_name(list, name)?;
    list[i].meins = meins;
    Ok(list[i].clone())
}

pub const OPTIONEN_MERKEN: &[&str] = &["--meins"];

pub fn run_merken(args: &[String], explain_on: bool) -> Result<(), String> {
    crate::optionen::nur(args, OPTIONEN_MERKEN, "merken")?;
    let meins = args.iter().any(|a| a == "--meins");
    let mut names = args.iter().filter(|a| *a != "--meins");
    let (Some(name), None) = (names.next(), names.next()) else {
        return Err("Es passt genau ein Name, z. B. `netzinfo merken WG --meins`.".into());
    };
    if name.starts_with("--") {
        return Err(format!(
            "Unbekannte Option „{name}“. `netzinfo hilfe` zeigt alle Optionen."
        ));
    }
    explain(
        explain_on,
        "Ich lese Router, DHCP-Server, Domain und Subnetz des aktuellen Netzes. Zusammen sind sie der Fingerabdruck, unter dem das Netz gespeichert wird.",
    );
    let netz = merken(name, meins)?;
    println!(
        "Netz „{}“ gemerkt{}.",
        netz.name,
        if meins { " (meins)" } else { "" }
    );
    explain(
        explain_on,
        "„meins“ erlaubt `netzinfo ports` in diesem Netz, ohne dass du jedes Mal `--meins` tippst. Markiere nur Netze, die dir gehören.",
    );
    Ok(())
}

pub fn run_netze(args: &[String], explain_on: bool) -> Result<(), String> {
    crate::optionen::nur(args, &[], "netze")?;
    let list = liste()?;
    if list.is_empty() {
        crate::satz("Noch kein Netz gemerkt. Mit `netzinfo merken <Name>` fängst du an.");
        return Ok(());
    }
    for n in &list {
        println!(
            "{}: meins {}, zuletzt am {}, Router {}, {}",
            n.name,
            if n.meins { "ja" } else { "nein" },
            format_utc(n.last_seen),
            n.fingerprint.router,
            n.fingerprint
                .domain
                .as_deref()
                .map_or("ohne Domain".into(), |d| format!("Domain {d}")),
        );
    }
    explain(
        explain_on,
        "Die Liste liegt als JSON-Datei auf deinem Rechner. Pfad ändern geht mit der Umgebungsvariable NETZ_DATEN.",
    );
    Ok(())
}

pub fn run_vergessen(args: &[String], explain_on: bool) -> Result<(), String> {
    crate::optionen::nur(args, &[], "vergessen")?;
    let [name] = args else {
        return Err("Es passt genau ein Name, z. B. `netzinfo vergessen WG`.".into());
    };
    vergessen(name)?;
    println!("Netz „{name}“ vergessen.");
    explain(
        explain_on,
        "Beim nächsten Besuch gilt das Netz wieder als neu, und die Markierung „meins“ ist weg.",
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subnetz;

    fn info() -> NetInfo {
        NetInfo {
            interface: "en0".into(),
            ip: "192.168.178.20".parse().ok(),
            subnet: subnetz::calc("192.168.178.20".parse().unwrap(), 24).ok(),
            router: "192.168.178.1".parse().ok(),
            dhcp_server: "192.168.178.1".parse().ok(),
            domain: Some("fritz.box".into()),
            ..NetInfo::default()
        }
    }

    fn env<'a>(v: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<std::ffi::OsString> + 'a {
        move |k| v.iter().find(|(n, _)| *n == k).map(|(_, w)| (*w).into())
    }

    #[test]
    fn data_path_pro_system() {
        let p = |os, v: &[(&str, &str)]| data_path_from(os, env(v));
        assert_eq!(
            p("macos", &[("HOME", "/Users/x")]).unwrap(),
            PathBuf::from("/Users/x/Library/Application Support/netzinfo/netze.json")
        );
        assert_eq!(
            p("windows", &[("LOCALAPPDATA", "C:/L")]).unwrap(),
            PathBuf::from("C:/L").join("netzinfo").join("netze.json")
        );
        assert_eq!(
            p("linux", &[("XDG_DATA_HOME", "/d"), ("HOME", "/h")]).unwrap(),
            PathBuf::from("/d/netzinfo/netze.json")
        );
        assert_eq!(
            p("linux", &[("XDG_DATA_HOME", ""), ("HOME", "/h")]).unwrap(),
            PathBuf::from("/h/.local/share/netzinfo/netze.json")
        );
        assert_eq!(
            p("linux", &[("NETZ_DATEN", "/f.json"), ("HOME", "/h")]).unwrap(),
            PathBuf::from("/f.json")
        );
        for os in ["macos", "windows", "linux"] {
            assert!(p(os, &[]).unwrap_err().contains("NETZ_DATEN"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn save_setzt_rechte_0600() {
        use std::os::unix::fs::PermissionsExt;
        let f = tmp_dir("rechte").join("netze.json");
        save(&f, &Vec::<Netz>::new()).unwrap();
        assert_eq!(
            std::fs::metadata(&f).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("netz-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rename_and_mark_rules() {
        let fp = fingerprint(&info()).unwrap();
        let mut other = fp.clone();
        other.subnet = "10.0.0.0/24".into();
        let mut list = vec![];
        remember(&mut list, "WG", fp, true, 1).unwrap();
        remember(&mut list, "Büro", other, false, 2).unwrap();
        // taken, empty, unknown
        assert!(
            rename(&mut list, "WG", "Büro")
                .unwrap_err()
                .contains("vergeben")
        );
        assert!(rename(&mut list, "WG", "  ").is_err());
        assert!(
            rename(&mut list, "Nix", "X")
                .unwrap_err()
                .contains("nicht gemerkt")
        );
        assert_eq!(
            fehlerart(&rename(&mut list, "Nix", "X").unwrap_err()),
            Fehlerart::NichtGemerkt
        );
        for satz in [NICHT_GEMERKT_PRUEFEN, NICHT_GEMERKT_MESSEN] {
            assert_eq!(fehlerart(satz), Fehlerart::NichtGemerkt);
        }
        let f = AppFehler::from("Kein Netz gefunden.".to_string());
        assert_eq!(
            serde_json::to_string(&f).unwrap(),
            r#"{"art":"sonstiges","text":"Kein Netz gefunden."}"#
        );
        assert_eq!(fehlerart("Kein Netz gefunden."), Fehlerart::Sonstiges);
        // same name is fine; renaming keeps meins and fingerprint
        let n = rename(&mut list, "WG", "Zuhause").unwrap();
        assert!(n.meins && n.name == "Zuhause");
        assert_eq!(list[0].fingerprint.subnet, "192.168.178.0/24");
        assert!(rename(&mut list, "Zuhause", "Zuhause").is_ok());
        assert!(!mark(&mut list, "Zuhause", false).unwrap().meins);
        assert!(mark(&mut list, "Büro", true).unwrap().meins);
        assert!(mark(&mut list, "Nix", true).is_err());
    }

    #[test]
    fn merken_in_stores_and_aendern_does_not_save_on_error() {
        let dir = tmp_dir("merken-in");
        let path = dir.join("netze.json");
        let fp = fingerprint(&info()).unwrap();
        let n = merken_in(&path, "WG", fp.clone(), true).unwrap();
        assert!(n.meins);
        // a failing change leaves the file as it was
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(aendern(&path, |l| rename(l, "Nix", "X")).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        aendern(&path, |l| forget(l, "WG")).unwrap();
        assert!(load(&path).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn erkennen_known_unknown_and_no_dhcp() {
        let dir = tmp_dir("erkennen");
        let path = dir.join("netze.json");
        let new = erkennen(info(), Ok(path.clone()));
        assert!(new.netz.is_none() && new.erkennung_fehler.is_none() && new.hinweis.is_none());
        let fp = fingerprint(&info()).unwrap();
        merken_in(&path, "WG", fp, false).unwrap();
        let mut list = load(&path).unwrap();
        list[0].last_seen = 5;
        save(&path, &list).unwrap();
        let known = erkennen(info(), Ok(path.clone()));
        // reports the previous visit, the file gets the new time
        assert_eq!(
            known.netz.as_ref().map(|n| (n.name.as_str(), n.last_seen)),
            Some(("WG", 5))
        );
        assert!(load(&path).unwrap()[0].last_seen > 5);
        let vpn = NetInfo {
            interface: "utun4".into(),
            ..NetInfo::default()
        };
        assert!(erkennen(vpn, Ok(path)).erkennung_fehler.is_some());
        // a store problem becomes a note, not an error
        assert!(erkennen(info(), Err("x".into())).hinweis.is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fingerprint_from_dhcp_data() {
        let fp = fingerprint(&info()).unwrap();
        assert_eq!(fp.router, "192.168.178.1".parse::<Ipv4Addr>().unwrap());
        assert_eq!(fp.subnet, "192.168.178.0/24");
        assert_eq!(fp.domain.as_deref(), Some("fritz.box"));
    }

    #[test]
    fn no_dhcp_means_no_fingerprint() {
        let vpn = NetInfo {
            interface: "utun4".into(),
            router: "100.64.0.1".parse().ok(),
            ..NetInfo::default()
        };
        assert!(fingerprint(&vpn).unwrap_err().contains("Fingerabdruck"));
    }

    #[test]
    fn static_address_gets_its_own_message() {
        let fest = NetInfo {
            interface: "eth0".into(),
            fest: true,
            ..NetInfo::default()
        };
        let e = fingerprint(&fest).unwrap_err();
        assert!(e.contains("fester Adresse") && e.contains("DHCP"));
        let vpn = fingerprint(&NetInfo::default()).unwrap_err();
        assert!(vpn.contains("VPN") && !vpn.contains("fester Adresse"));
        // the callers add their own lead-in, so the text must not repeat it
        for t in [e, vpn] {
            assert!(!t.contains("lässt sich nicht wiedererkennen"));
        }
    }

    #[test]
    fn json_round_trip_and_atomic_save() {
        let dir = tmp_dir("save");
        let path = dir.join("sub/netze.json");
        let mut list = Vec::new();
        remember(
            &mut list,
            "WG",
            fingerprint(&info()).unwrap(),
            true,
            1793050200,
        )
        .unwrap();
        save(&path, &list).unwrap();
        assert_eq!(load(&path).unwrap(), list);
        // no temp file left behind
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("netze.json")]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_file_is_empty_list() {
        let dir = tmp_dir("missing");
        assert!(load(&dir.join("netze.json")).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_file_is_moved_aside_not_overwritten() {
        let dir = tmp_dir("corrupt");
        let path = dir.join("netze.json");
        std::fs::write(&path, "{ das ist kein json").unwrap();
        assert!(load(&path).unwrap().is_empty());
        assert!(!path.exists());
        let aside: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(aside.len(), 1);
        assert!(aside[0].to_string_lossy().contains("netze.json.kaputt-"));
        assert_eq!(
            std::fs::read_to_string(&aside[0]).unwrap(),
            "{ das ist kein json"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_file_that_cannot_be_moved_is_an_error() {
        // a read-only directory makes the rename impossible
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir("ro");
        let path = dir.join("netze.json");
        std::fs::write(&path, "kaputt").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let r = load(&path);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        if r.is_ok() {
            // running as root ignores permissions; nothing to assert then
            return;
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "kaputt");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn names_are_unique_and_non_empty() {
        let mut list = Vec::new();
        let fp = fingerprint(&info()).unwrap();
        assert!(remember(&mut list, "  ", fp.clone(), false, 1).is_err());
        remember(&mut list, "WG", fp.clone(), false, 1).unwrap();
        let mut other = fp.clone();
        other.subnet = "10.0.0.0/24".into();
        assert!(remember(&mut list, "WG", other.clone(), false, 2).is_err());
        remember(&mut list, "Arbeit", other, false, 2).unwrap();
        // same fingerprint again: renamed and updated, not duplicated
        remember(&mut list, "WG neu", fp, true, 3).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].name.as_str(), list[0].meins), ("WG neu", true));
        assert_eq!((list[0].first_seen, list[0].last_seen), (1, 3));
        // renaming onto an existing name of another network is refused
        let fp0 = list[0].fingerprint.clone();
        assert!(remember(&mut list, "Arbeit", fp0, true, 4).is_err());
    }

    #[test]
    fn forget_removes_one() {
        let mut list = Vec::new();
        remember(&mut list, "WG", fingerprint(&info()).unwrap(), false, 1).unwrap();
        assert!(forget(&mut list, "Schule").is_err());
        forget(&mut list, "WG").unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn utc_date_format() {
        assert_eq!(format_utc(1793050200), "Mo 26.10.2026, 21:30 (UTC)");
        assert_eq!(format_utc(0), "Do 01.01.1970, 00:00 (UTC)");
        assert_eq!(format_utc(951782405), "Di 29.02.2000, 00:00 (UTC)");
    }

    #[test]
    fn fingerprint_with_and_without_bssid_hash() {
        let mut a = info_fp();
        let mut b = a.clone();
        // fehlt das Feld auf einer Seite, zählt es weder dafür noch dagegen
        assert!(a.gleiches_netz(&b) && a.gleicher_funkpunkt(&b).is_none());
        a.bssid_hash = Some("aa".into());
        assert!(a.gleiches_netz(&b) && a.gleicher_funkpunkt(&b).is_none());
        // mit Hash auf beiden Seiten: anderer Funkpunkt, aber dasselbe Netz (Mesh, Repeater)
        b.bssid_hash = Some("bb".into());
        assert!(a.gleiches_netz(&b));
        assert_eq!(a.gleicher_funkpunkt(&b), Some(false));
        b.bssid_hash = Some("aa".into());
        assert_eq!(a.gleicher_funkpunkt(&b), Some(true));
        assert_eq!(a.key(), b.key(), "der Hash gehört nicht in den Schlüssel");
        // find: ein gemerktes Netz mit Hash wird auch ohne Hash gefunden
        let list = vec![Netz {
            name: "WG".into(),
            fingerprint: a.clone(),
            meins: true,
            first_seen: 1,
            last_seen: 1,
        }];
        assert_eq!(find(&list, &info_fp()), Some(0));
    }

    #[test]
    fn old_store_without_bssid_hash_loads() {
        let alt = r#"[{"name":"WG","fingerprint":{"router":"192.0.2.1","dhcp_server":"192.0.2.1","domain":null,"subnet":"192.0.2.0/24"},"meins":true,"first_seen":1,"last_seen":2}]"#;
        let list: Vec<Netz> = serde_json::from_str(alt).unwrap();
        assert_eq!(list[0].fingerprint.bssid_hash, None);
        // und ohne Hash steht auch kein leeres Feld im neu geschriebenen Speicher
        assert!(!serde_json::to_string(&list).unwrap().contains("bssid_hash"));
    }

    fn info_fp() -> Fingerprint {
        Fingerprint {
            router: "192.0.2.1".parse().unwrap(),
            dhcp_server: "192.0.2.1".parse().unwrap(),
            subnet: "192.0.2.0/24".into(),
            domain: None,
            bssid_hash: None,
        }
    }
}

#[cfg(test)]
mod robust {
    use super::*;
    use std::collections::BTreeMap;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("netzinfo-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("x.json")
    }

    /// App, Wache und Kommandozeile ändern dieselbe Datei gleichzeitig: kein Eintrag geht verloren.
    #[test]
    fn gleichzeitiges_aendern_verliert_nichts() {
        let pfad = tmp("parallel");
        std::thread::scope(|s| {
            for i in 0..8 {
                let pfad = &pfad;
                s.spawn(move || {
                    for j in 0..5 {
                        let _sperre = sperre(pfad);
                        let mut m: BTreeMap<String, u32> = load_json(pfad).unwrap();
                        m.insert(format!("{i}-{j}"), 1);
                        save(pfad, &m).unwrap();
                    }
                });
            }
        });
        let m: BTreeMap<String, u32> = load_json(&pfad).unwrap();
        assert_eq!(m.len(), 40);
        let reste = std::fs::read_dir(pfad.parent().unwrap())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp")
            })
            .count();
        assert_eq!(reste, 0, "Zwischendateien bleiben liegen");
    }

    /// Ohne Schreibrecht für den Ordner kommt ein Satz, kein Absturz.
    #[cfg(unix)]
    #[test]
    fn nicht_schreibbarer_ordner_gibt_einen_satz() {
        use std::os::unix::fs::PermissionsExt;
        let pfad = tmp("lesend");
        let ordner = pfad.parent().unwrap();
        std::fs::set_permissions(ordner, std::fs::Permissions::from_mode(0o500)).unwrap();
        let r = save(&pfad, &BTreeMap::<String, u32>::new());
        let _sperre = sperre(&pfad); // darf nicht abstürzen oder hängen
        std::fs::set_permissions(ordner, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Als root ginge das Schreiben trotzdem; dann gibt es nichts zu prüfen.
        if let Err(e) = r {
            assert!(e.contains("ließ sich nicht speichern"), "{e}");
        }
    }
}
