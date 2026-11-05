//! Menu bar guard, see issue #9: shows the state of the current network, re-checks after a network
//! change and posts a macOS notification when something is off. Closing the window keeps it running.

use netzinfo::netze;
use netzinfo::pruefen::{self, Klasse, Unterschied};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError, TryLockError};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{App, AppHandle, Manager, Wry};
use tauri_plugin_notification::NotificationExt;

const KENNUNG: &str = "dev.mia-gruenwald.netzinfo";
const INTERVALL: Duration = Duration::from_secs(20);
/// Time for DHCP to hand out the address after the network changed.
const DHCP_WARTEN: Duration = Duration::from_secs(5);

/// One check at a time: `pruefen()` writes `pruefungen.json`.
static LAEUFT: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq)]
enum Zustand {
    Unbekannt,
    KeinNetz,
    Unauffaellig,
    Auffaellig,
    Alarm,
}

impl Zustand {
    fn symbol(self) -> &'static str {
        match self {
            Self::Unbekannt => "?",
            Self::KeinNetz => "○",
            Self::Unauffaellig => "✓",
            Self::Auffaellig => "!",
            Self::Alarm => "!!",
        }
    }

    fn text(self) -> &'static str {
        match self {
            Self::Unbekannt => "unbekanntes Netz",
            Self::KeinNetz => "kein Netz",
            Self::Unauffaellig => "bekannt und unauffällig",
            Self::Auffaellig => "auffällig",
            Self::Alarm => "Alarm",
        }
    }
}

fn zustand(u: &[Unterschied]) -> Zustand {
    match u.iter().map(|u| u.klasse).max() {
        Some(Klasse::Alarm) => Zustand::Alarm,
        Some(Klasse::Auffaellig) => Zustand::Auffaellig,
        _ => Zustand::Unauffaellig,
    }
}

fn z_klasse(z: Zustand) -> Klasse {
    if z == Zustand::Alarm {
        Klasse::Alarm
    } else {
        Klasse::Auffaellig
    }
}

/// Title and text of the notification, `None` when nothing is off. Plain text only: the text
/// comes from the network and goes to `osascript` as an argument, never into script code.
fn mitteilung(netz: &str, u: &[Unterschied]) -> Option<(String, String)> {
    let z = zustand(u);
    let schlimm = u.iter().filter(|u| u.klasse >= Klasse::Auffaellig);
    let anzahl = schlimm.clone().count();
    // Der schwerste Fund zuerst, nicht der erste in der Liste.
    let erster = schlimm.clone().find(|u| u.klasse == z_klasse(z))?;
    let titel = if z == Zustand::Alarm {
        format!("Netzinfo: Alarm im Netz {netz}")
    } else {
        format!("Netzinfo: {netz} ist {}", z.text())
    };
    let text = match anzahl {
        1 => erster.text.clone(),
        n => format!(
            "{} (und {} weitere in der App unter Prüfung)",
            erster.text,
            n - 1
        ),
    };
    Some((titel, text))
}

/// Shown by the notification plugin, so macOS lists it as Netzinfo, not as Script Editor.
fn mitteilen(app: &AppHandle, titel: &str, text: &str) {
    if let Err(e) = app.notification().builder().title(titel).body(text).show() {
        eprintln!(
            "Die Mitteilung ließ sich nicht anzeigen ({e}). Erlaube sie unter Systemeinstellungen > Mitteilungen."
        );
    }
}

/// "29.10.2026, 11:06" in local time. `date` knows the time zone, so no new dependency.
// ponytail: one process per check; libc localtime_r if that ever matters.
fn ortszeit(secs: u64) -> String {
    // BSD `date -r <seconds>`, GNU `date -d @<seconds>` (there `-r` wants a file).
    let (flag, wert) = if cfg!(target_os = "macos") {
        ("-r", secs.to_string())
    } else {
        ("-d", format!("@{secs}"))
    };
    std::process::Command::new("date")
        .args([flag, &wert, "+%d.%m.%Y, %H:%M"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map_or_else(|| netze::format_utc(secs), |t| t.trim().to_string())
}

struct Menue {
    tray: TrayIcon,
    netz: MenuItem<Wry>,
    zuletzt: MenuItem<Wry>,
}

fn anzeigen(app: &AppHandle, z: Zustand, netz: &str, zuletzt: &str) {
    let m = app.state::<Menue>();
    // Cosmetic updates: a failure here must not stop the guard.
    let _ = m.tray.set_title(Some(z.symbol()));
    // Der Tooltip nennt den Zustand in Worten (VoiceOver liest ihn als Hilfetext); im Titel steht nur das Kürzel.
    let _ = m.tray.set_tooltip(Some(format!("Netzinfo: {}", z.text())));
    let _ = m.netz.set_text(format!("{netz}: {}", z.text()));
    let _ = m.zuletzt.set_text(zuletzt);
}

fn schluessel() -> Option<String> {
    let info = netzinfo::hier::collect().ok()?;
    Some(netze::fingerprint(&info).ok()?.key())
}

/// Checks the current network now and updates the icon and menu.
fn pruefe(app: &AppHandle) {
    // Eine Panik in einer früheren Runde vergiftet die Sperre; die Wache soll trotzdem weiterlaufen.
    let _sperre = match LAEUFT.try_lock() {
        Ok(g) => g,
        Err(TryLockError::Poisoned(g)) => g.into_inner(),
        Err(TryLockError::WouldBlock) => return,
    };
    if schluessel().is_none() {
        return anzeigen(app, Zustand::KeinNetz, "Kein Netz", "Nicht geprüft");
    }
    match pruefen::pruefen() {
        Ok(e) => {
            let z = zustand(&e.unterschiede);
            anzeigen(
                app,
                z,
                &e.netz,
                &format!("Geprüft: {}", ortszeit(e.messung.time)),
            );
            if let Some((titel, text)) = mitteilung(&e.netz, &e.unterschiede) {
                mitteilen(app, &titel, &text);
            }
        }
        Err(f) if f == netze::NICHT_GEMERKT_PRUEFEN => {
            anzeigen(
                app,
                Zustand::Unbekannt,
                "Neues Netz",
                "Nicht gemerkt, daher nicht geprüft",
            );
        }
        Err(f) => {
            eprintln!("{f}");
            anzeigen(
                app,
                Zustand::Unbekannt,
                "Netz",
                "Prüfung fehlgeschlagen, Grund unter Prüfung in der App",
            );
        }
    }
}

pub fn fenster_oeffnen(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Kosmetik: scheitert eines davon, bleibt das Fenster eben, wo es war.
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Builds the tray icon and starts the guard thread. Called once from `setup`.
pub fn starten(app: &mut App) -> tauri::Result<()> {
    let netz = MenuItem::with_id(app, "netz", "Netz wird geprüft", false, None::<&str>)?;
    let zuletzt = MenuItem::with_id(app, "zuletzt", "Noch nicht geprüft", false, None::<&str>)?;
    let jetzt = MenuItem::with_id(app, "jetzt", "Jetzt prüfen", true, None::<&str>)?;
    let fenster = MenuItem::with_id(app, "fenster", "Netzinfo öffnen", true, None::<&str>)?;
    let beenden = MenuItem::with_id(
        app,
        "beenden",
        "Netzinfo beenden",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let menue = Menu::with_items(
        app,
        &[
            &netz,
            &zuletzt,
            &PredefinedMenuItem::separator(app)?,
            &jetzt,
            &fenster,
            &PredefinedMenuItem::separator(app)?,
            &beenden,
        ],
    )?;
    // Template image: macOS tints it for light and dark. The state is the text next to it.
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/wache-template.png"))?;
    let tray = TrayIconBuilder::with_id("wache")
        .icon(icon)
        .icon_as_template(true)
        .menu(&menue)
        .title(Zustand::Unbekannt.symbol())
        .tooltip(format!("Netzinfo: {}", Zustand::Unbekannt.text()))
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "jetzt" => {
                let app = app.clone();
                std::thread::spawn(move || pruefe(&app));
            }
            "fenster" => fenster_oeffnen(app),
            "beenden" => app.exit(0),
            _ => {}
        });
    let tray = tray.build(app)?;
    app.manage(Menue {
        tray,
        netz,
        zuletzt,
    });

    let app = app.handle().clone();
    std::thread::spawn(move || {
        let mut haengt = 0u32;
        loop {
            // Jede Runde läuft in einem eigenen Thread: eine Panik oder ein hängender
            // Systembefehl in einer Runde hält die Wache nicht an.
            if RUNDE.swap(true, Ordering::AcqRel) {
                haengt += 1;
                if haengt == HAENGT_NACH {
                    anzeigen(
                        &app,
                        Zustand::Unbekannt,
                        "Netz",
                        "Die Prüfung hängt, die nächste Runde wartet darauf",
                    );
                }
            } else {
                haengt = 0;
                let app = app.clone();
                std::thread::spawn(move || {
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runde(&app)));
                    if r.is_err() {
                        eprintln!("Eine Runde der Wache ist abgestürzt, die nächste läuft normal.");
                    }
                    RUNDE.store(false, Ordering::Release);
                });
            }
            std::thread::sleep(INTERVALL);
        }
    });
    Ok(())
}

/// Läuft gerade eine Runde? Nur eine zur Zeit.
static RUNDE: AtomicBool = AtomicBool::new(false);
/// Nach so vielen übersprungenen Takten (3 Minuten) gilt eine Runde als hängend.
const HAENGT_NACH: u32 = 9;
/// Der zuletzt gesehene Netzschlüssel. `None`: noch nichts gesehen, die erste Runde prüft immer.
static LETZTER: Mutex<Option<Option<String>>> = Mutex::new(None);

fn runde(app: &AppHandle) {
    let jetzt = schluessel();
    let neu = LETZTER
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        != Some(&jetzt);
    if neu {
        if jetzt.is_some() {
            std::thread::sleep(DHCP_WARTEN);
        }
        pruefe(app);
        *LETZTER.lock().unwrap_or_else(PoisonError::into_inner) = Some(schluessel());
    }
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn plist(exe: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key><string>{KENNUNG}</string>\n  <key>ProgramArguments</key><array><string>{}</string></array>\n  <key>RunAtLoad</key><true/>\n</dict>\n</plist>\n",
        xml(exe)
    )
}

fn autostart_pfad() -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("Der Ordner des Benutzers ist unbekannt (HOME fehlt). Starte die App aus dem Programme-Ordner.")?;
    Ok(std::path::Path::new(&home).join(format!("Library/LaunchAgents/{KENNUNG}.plist")))
}

/// The login item is a launchd plist; other systems have nothing to write (the UI shows the sentence as a hint).
const NUR_MAC_START: &str = "Den Start mit der Anmeldung gibt es unter Linux noch nicht.";

pub fn autostart_lesen() -> Result<bool, String> {
    if cfg!(not(target_os = "macos")) {
        return Err(NUR_MAC_START.into());
    }
    Ok(autostart_pfad()?.exists())
}

/// A dev build starts from `target/debug`, which is gone after a clean build: say so at the switch.
pub fn autostart_hinweis() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    entwicklung(&exe).then(|| {
        "Das ist ein Entwicklungsstand (target/debug). Der Start mit der Anmeldung zeigt auf diese Datei und geht ins Leere, wenn du neu baust. Schalte ihn lieber in der installierten App ein.".into()
    })
}

fn entwicklung(exe: &std::path::Path) -> bool {
    exe.components().any(|c| c.as_os_str() == "target")
}

/// Writes or removes the login item. Takes effect at the next login.
pub fn autostart_setzen(an: bool) -> Result<bool, String> {
    if cfg!(not(target_os = "macos")) {
        return Err(NUR_MAC_START.into());
    }
    let pfad = autostart_pfad()?;
    if an {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Der Pfad der App ließ sich nicht lesen ({}). Starte die App aus dem Programme-Ordner.", netzinfo::io_satz(&e)))?;
        let ordner = pfad
            .parent()
            .ok_or("Der Ordner für Anmeldeobjekte fehlt.")?;
        std::fs::create_dir_all(ordner)
            .and_then(|()| std::fs::write(&pfad, plist(&exe.to_string_lossy())))
            .map_err(|e| format!("Der Start mit der Anmeldung ließ sich nicht einrichten ({}). Prüfe die Rechte auf {}.", netzinfo::io_satz(&e), ordner.display()))?;
    } else if let Err(e) = std::fs::remove_file(&pfad)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        return Err(format!(
            "Der Start mit der Anmeldung ließ sich nicht abschalten ({}). Lösche {} von Hand.",
            netzinfo::io_satz(&e),
            pfad.display()
        ));
    }
    Ok(an)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(klasse: Klasse, text: &str) -> Unterschied {
        Unterschied {
            klasse,
            text: text.into(),
        }
    }

    #[test]
    fn zustand_nimmt_das_schlimmste() {
        assert_eq!(zustand(&[]), Zustand::Unauffaellig);
        assert_eq!(zustand(&[u(Klasse::Harmlos, "a")]), Zustand::Unauffaellig);
        let beide = [u(Klasse::Auffaellig, "a"), u(Klasse::Alarm, "b")];
        assert_eq!(zustand(&beide), Zustand::Alarm);
    }

    #[test]
    fn mitteilung_nur_bei_auffaelligem() {
        assert_eq!(mitteilung("WG", &[u(Klasse::Harmlos, "x")]), None);
        let (t, b) = mitteilung(
            "WG",
            &[u(Klasse::Harmlos, "x"), u(Klasse::Auffaellig, "DNS neu")],
        )
        .unwrap();
        assert_eq!(
            (t.as_str(), b.as_str()),
            ("Netzinfo: WG ist auffällig", "DNS neu")
        );
        let (t, b) = mitteilung(
            "WG",
            &[
                u(Klasse::Auffaellig, "DNS neu"),
                u(Klasse::Alarm, "Router neu"),
                u(Klasse::Alarm, "MAC neu"),
            ],
        )
        .unwrap();
        assert_eq!(t, "Netzinfo: Alarm im Netz WG");
        assert!(b.starts_with("Router neu (und 2 weitere"), "{b}");
    }

    #[test]
    fn entwicklungsstand_wird_erkannt() {
        assert!(entwicklung(std::path::Path::new(
            "/x/netz/target/debug/netzinfo-app"
        )));
        assert!(!entwicklung(std::path::Path::new(
            "/Applications/Netzinfo.app/Contents/MacOS/netzinfo-app"
        )));
    }

    #[test]
    fn ortszeit_hat_das_format() {
        let t = ortszeit(1793050200);
        assert_eq!(t.len(), 17, "{t}");
        assert_eq!(&t[2..3], ".");
    }

    #[test]
    fn plist_maskiert_den_pfad() {
        let p = plist("/Apps/A&B <x>/Netzinfo");
        assert!(p.contains("<string>/Apps/A&amp;B &lt;x&gt;/Netzinfo</string>"));
        assert!(p.contains(KENNUNG) && p.contains("RunAtLoad"));
    }
}
