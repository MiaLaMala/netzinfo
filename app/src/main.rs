//! The Mac app: a thin Tauri shell around the `netzinfo` library.
//!
//! Every command returns data or a German sentence; the UI (app/ui) shows the sentence where it
//! happened.

mod wache;

use netzinfo::netze::{self, Aktuell, AppFehler as Fehler, Netz};
use tauri::menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

const REPO: &str = "https://github.com/MiaLaMala/netzinfo";

#[tauri::command(async)]
fn dieses_netz() -> Result<Aktuell, Fehler> {
    netze::aktuell().map_err(Into::into)
}

#[tauri::command(async)]
fn netz_merken(name: String, meins: bool) -> Result<Netz, Fehler> {
    netze::merken(&name, meins).map_err(Into::into)
}

#[tauri::command(async)]
fn gemerkte_netze() -> Result<Vec<Netz>, Fehler> {
    netze::liste().map_err(Into::into)
}

#[tauri::command(async)]
fn netz_umbenennen(alt: String, neu: String) -> Result<Netz, Fehler> {
    netze::umbenennen(&alt, &neu).map_err(Into::into)
}

#[tauri::command(async)]
fn netz_markieren(name: String, meins: bool) -> Result<Netz, Fehler> {
    netze::markieren(&name, meins).map_err(Into::into)
}

#[tauri::command(async)]
fn pruefen() -> Result<netzinfo::pruefen::PruefErgebnis, Fehler> {
    netzinfo::pruefen::pruefen().map_err(Into::into)
}

#[tauri::command(async)]
fn messen_einmal() -> Result<netzinfo::messen::Probe, Fehler> {
    netzinfo::messen::messen_einmal().map_err(Into::into)
}

#[tauri::command(async)]
fn bericht(name: Option<String>) -> Result<netzinfo::messen::Bericht, Fehler> {
    netzinfo::messen::bericht_daten(name.as_deref()).map_err(Into::into)
}

#[tauri::command(async)]
fn geraete_suchen(
    cidr: Option<String>,
    gross: bool,
) -> Result<netzinfo::geraete::GeraeteErgebnis, Fehler> {
    netzinfo::geraete::suchen_mit(cidr.as_deref(), gross, true).map_err(Into::into)
}

/// Cards of the devices stored for this network, see issue #29. Sends nothing.
#[tauri::command(async)]
fn geraete_karten() -> Result<Vec<netzinfo::geraetekarte::Karte>, Fehler> {
    netzinfo::geraetekarte::karten_jetzt().map_err(Into::into)
}

/// Name and/or type given by the user; no scan overwrites it, see issue #29.
#[tauri::command(async)]
fn geraet_setzen(
    schluessel: String,
    name: Option<String>,
    typ: Option<String>,
) -> Result<(), Fehler> {
    netzinfo::geraetekarte::setzen_jetzt(&schluessel, name.as_deref(), typ.as_deref())
        .map_err(Into::into)
}

/// Hops to `ziel` (default 1.1.1.1), see issue #73.
#[tauri::command(async)]
fn pfad_messen(ziel: Option<String>) -> Result<netzinfo::pfad::PfadErgebnis, Fehler> {
    netzinfo::pfad::pfad_daten(ziel.as_deref().unwrap_or("1.1.1.1"), 20, 10, true)
        .map_err(Into::into)
}

/// Captive portal check, see issue #73.
#[tauri::command(async)]
fn portal_pruefen() -> netzinfo::portal::PortalErgebnis {
    netzinfo::portal::check()
}

/// "Wo hakt es?": four ping series, one verdict, see issue #31.
#[tauri::command(async)]
fn diagnose() -> Result<netzinfo::diagnose::DiagnoseErgebnis, Fehler> {
    netzinfo::diagnose::diagnose_daten().map_err(Into::into)
}

/// Opens a fixed address in the default browser. The UI never passes a URL, so it cannot open anything else.
fn im_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|e| {
                format!(
                    "Der Browser ließ sich nicht öffnen ({}). Öffne {url} von Hand.",
                    netzinfo::io_satz(&e)
                )
            })
    }
    #[cfg(not(target_os = "macos"))]
    Err(format!(
        "Den Browser öffnet nur die Mac-App. Öffne {url} von Hand."
    ))
}

/// Opens the portal login page in the default browser.
#[tauri::command]
fn portal_im_browser_oeffnen() -> Result<(), String> {
    im_browser("http://captive.apple.com")
}

/// Opens the broadband measurement of the Bundesnetzagentur (Tempo view, #207).
#[tauri::command]
fn breitbandmessung_oeffnen() -> Result<(), String> {
    im_browser("https://breitbandmessung.de")
}

/// Clock check against NTP and an HTTPS `Date` header, see issue #69.
#[tauri::command(async)]
fn zeit_pruefen() -> netzinfo::zeit::ZeitErgebnis {
    netzinfo::zeit::pruefen()
}

/// Outgoing TCP ports to the own test server, see issue #54. `ziel` is saved when given.
#[tauri::command(async)]
fn egress_pruefen(ziel: Option<String>) -> Result<netzinfo::egress::EgressAntwort, Fehler> {
    netzinfo::egress::ausfuehren(ziel).map_err(Into::into)
}

#[tauri::command(async)]
fn dns_verschluesselt() -> Result<netzinfo::dnsverschl::DnsErgebnis, Fehler> {
    netzinfo::dnsverschl::dns_daten().map_err(Into::into)
}

/// Radio link of the current Wi-Fi connection, `None` without one, see issue #34.
#[tauri::command(async)]
fn wlan_lesen() -> Result<Option<netzinfo::wlan::Funkverbindung>, Fehler> {
    netzinfo::wlan::lesen().map_err(Into::into)
}

/// Active connections per program, see issue #39. Stores only in „meins“ networks or with `speichern`.
#[tauri::command(async)]
fn verbindungen_zeigen(speichern: bool) -> Result<netzinfo::verbindungen::Ergebnis, Fehler> {
    netzinfo::verbindungen::sammeln(speichern).map_err(Into::into)
}

/// Chain from a program up to launchd, see issue #56.
#[tauri::command(async)]
fn woher_zeigen(pid: u32) -> Result<netzinfo::woher::Herkunft, Fehler> {
    netzinfo::woher::herkunft(pid).map_err(Into::into)
}

/// Bytes per program over `sekunden`, measured on request only, see issue #58.
#[tauri::command(async)]
fn traffic_messen(sekunden: u64) -> Result<Vec<netzinfo::traffic::Verbrauch>, Fehler> {
    netzinfo::traffic::messen(sekunden).map_err(Into::into)
}

#[tauri::command(async)]
fn verbindungen_loeschen() -> Result<bool, Fehler> {
    netzinfo::verbindungen::loeschen().map_err(Into::into)
}

/// Programs with open ports on this Mac, see issue #74. `aussen`: also try the TCP ports on the own address.
#[tauri::command(async)]
fn offen_zeigen(aussen: bool) -> Result<Vec<netzinfo::offen::Lauscher>, Fehler> {
    let mut liste = netzinfo::offen::offen_im_netz()?;
    if aussen {
        netzinfo::offen::aussen_abgleichen(&mut liste, false)?;
    }
    Ok(liste)
}

/// Location permission for SSID and BSSID, see issue #35. Reading the state shows no dialog.
#[tauri::command]
fn ort_status() -> netzinfo::ort::OrtStatus {
    netzinfo::ort::status()
}

/// Shows the system dialog (first time only). Not `async`: Tauri then runs it on the main thread.
#[tauri::command]
fn ort_anfragen() -> Result<netzinfo::ort::OrtStatus, String> {
    netzinfo::ort::anfragen()
}

/// Opens the Location Services pane. Fixed URL on purpose: the UI passes nothing.
#[tauri::command]
fn ort_einstellungen_oeffnen() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Die Systemeinstellungen ließen sich nicht öffnen ({}). Öffne sie von Hand unter Datenschutz & Sicherheit > Ortungsdienste.", netzinfo::io_satz(&e)))
    }
    #[cfg(not(target_os = "macos"))]
    Err("Die Systemeinstellungen gibt es nur auf dem Mac.".into())
}

#[tauri::command(async)]
fn netz_vergessen(name: String) -> Result<(), Fehler> {
    netze::vergessen(&name).map_err(Into::into)
}

/// Last stored DNS measurement of a remembered network, sends nothing, see issue #88.
#[tauri::command(async)]
fn dns_gespeichert(name: String) -> Result<Option<netzinfo::dnsverschl::Gespeichert>, Fehler> {
    netzinfo::dnsverschl::gespeichert(&name).map_err(Into::into)
}

/// IPv6 routers the system learned, compared with the gateway, see issue #68. Reads only.
#[tauri::command(async)]
fn ipv6_router() -> Result<netzinfo::ipv6router::Anzeige, Fehler> {
    netzinfo::ipv6router::anzeige().map_err(Into::into)
}

/// One Wi-Fi sample into the running visit, see issue #36. Stores only in remembered networks.
#[tauri::command(async)]
fn wlan_verlauf_abtasten() -> Result<netzinfo::wlanverlauf::Ansicht, Fehler> {
    netzinfo::wlanverlauf::abtasten().map_err(Into::into)
}

/// One ping to `ziel` for the view „Live“, see issue #46. The view calls it once a second while visible.
#[tauri::command(async)]
fn live_sonde(ziel: String, neu: bool) -> Result<netzinfo::live::Ansicht, Fehler> {
    netzinfo::live::sonde(&ziel, neu).map_err(Into::into)
}

/// Path MTU to a target, see issue #47. Stores in remembered networks.
#[tauri::command(async)]
fn mtu_messen(ziel: Option<String>) -> Result<netzinfo::mtu::MtuErgebnis, Fehler> {
    netzinfo::mtu::mtu_daten(ziel.as_deref().unwrap_or("1.1.1.1")).map_err(Into::into)
}

/// DNS server comparison, sends at most 60 queries per server, see issue #50.
#[tauri::command(async)]
fn dns_tempo() -> Result<netzinfo::dnstempo::Anzeige, Fehler> {
    netzinfo::dnstempo::daten().map_err(Into::into)
}

/// SNI filter check against 1.1.1.1, see issue #52. Stores nothing.
#[tauri::command(async)]
fn sni_pruefen() -> Result<netzinfo::sni::SniErgebnis, Fehler> {
    netzinfo::sni::messen().map_err(Into::into)
}

/// IPv4 against IPv6 with Happy Eyeballs, see issue #48. Takes a few seconds.
#[tauri::command(async)]
fn ipv6_messen() -> Result<netzinfo::ipv6::Ergebnis, Fehler> {
    netzinfo::ipv6::daten().map_err(Into::into)
}

/// Scan of the Wi-Fi channels around the Mac, only on click, stores nothing, see issue #55.
#[tauri::command(async)]
fn wlan_umfeld() -> Result<netzinfo::kanal::Ansicht, Fehler> {
    netzinfo::kanal::umfeld().map_err(Into::into)
}

/// Proxy, PAC and WPAD of the current network, see issue #53.
#[tauri::command(async)]
fn proxy_lesen() -> Result<netzinfo::proxy::ProxyBefund, Fehler> {
    netzinfo::proxy::messen().map_err(Into::into)
}

/// Fetches the PAC file only when the user clicks, returns host names only, see issue #53.
#[tauri::command(async)]
fn proxy_pac_ansehen() -> Result<Vec<String>, Fehler> {
    netzinfo::proxy::pac_ansehen().map_err(Into::into)
}

/// Passive Einschätzung der Router-Seite, nur Gateway und nur in „meins“-Netzen, siehe Issue #67.
#[tauri::command(async)]
fn router_seite() -> Result<netzinfo::router::Ergebnis, Fehler> {
    netzinfo::router::router_jetzt().map_err(Into::into)
}

/// Hinweis, Hotspot-Verdacht und Verlauf für die Karte „Unter Last“, siehe Issue #49. Misst nichts.
#[tauri::command(async)]
fn last_vorab() -> netzinfo::last::Vorab {
    netzinfo::last::vorab()
}

/// Startet den Test unter Last, nur nach Klick, siehe Issue #49. Belastet die Leitung etwa 30 s.
#[tauri::command(async)]
fn last_messen(trotz_hotspot: bool) -> Result<netzinfo::last::Lauf, Fehler> {
    netzinfo::last::messen_und_speichern(trotz_hotspot).map_err(Into::into)
}

/// Port mappings the router opened via UPnP, read-only and only in „meins“ networks, see issue #45.
#[tauri::command(async)]
fn portfreigaben() -> Result<netzinfo::portfreigaben::Anzeige, Fehler> {
    netzinfo::portfreigaben::anzeige().map_err(Into::into)
}

/// Whether the app starts with the login, see issue #9.
#[tauri::command]
fn autostart_lesen() -> Result<bool, Fehler> {
    wache::autostart_lesen().map_err(Into::into)
}

/// Switches the start with the login on or off, see issue #9.
#[tauri::command]
fn autostart_setzen(an: bool) -> Result<bool, Fehler> {
    wache::autostart_setzen(an).map_err(Into::into)
}

/// Hint for the login switch when the app runs from a dev build, `None` otherwise, see issue #142.
#[tauri::command]
fn autostart_hinweis() -> Option<String> {
    wache::autostart_hinweis()
}

#[tauri::command(async)]
fn ausfaelle() -> Result<netzinfo::messen::Ausfaelle, Fehler> {
    netzinfo::messen::ausfall_daten(None).map_err(Into::into)
}

/// Fritz!Box-Zugang aus dem Schlüsselbund: nur der Benutzername, nie das Passwort, see issue #65.
#[tauri::command(async)]
fn fritzbox_zugang() -> Result<Option<String>, Fehler> {
    netzinfo::fritzbox::zugang_lesen()
        .map(|z| z.map(|z| z.benutzer))
        .map_err(Into::into)
}

/// Legt Benutzer und Passwort im Schlüsselbund ab, see issue #65.
#[tauri::command(async)]
fn fritzbox_speichern(benutzer: String, passwort: String) -> Result<(), Fehler> {
    netzinfo::fritzbox::zugang_speichern(&benutzer, &passwort).map_err(Into::into)
}

/// Löscht den Zugang aus dem Schlüsselbund, see issue #65.
#[tauri::command(async)]
fn fritzbox_entfernen() -> Result<(), Fehler> {
    netzinfo::fritzbox::zugang_entfernen().map_err(Into::into)
}

/// Liest die Geräteliste der Fritz!Box (nur lesen, nur in „meins“-Netzen) und mischt sie in die
/// eigene Liste, see issue #65.
#[tauri::command(async)]
fn fritzbox_lesen() -> Result<netzinfo::fritzbox::Abruf, Fehler> {
    netzinfo::fritzbox::abrufen(netzinfo::fritzbox::zugang_lesen).map_err(Into::into)
}

/// Leitung laut Router, WLAN und der am Mac gemessene Durchsatz nebeneinander, siehe Issue #207.
/// Misst nichts; `mac_down_mbit` kommt aus `last_messen`. Fragt den Router nur lesend.
#[tauri::command(async)]
fn engpass_lesen(mac_down_mbit: Option<f64>) -> Result<netzinfo::engpass::Ergebnis, Fehler> {
    netzinfo::engpass::lesen(mac_down_mbit).map_err(Into::into)
}

/// Das Menü der App auf Deutsch. Ohne eigenes zeigt Tauri das englische Standardmenü (About, Hide, Quit).
/// „Über Netzinfo“ zeigt unter macOS Name, Version und Copyright; Lizenz und Link zum Repo stehen in `Credits.rtf`.
fn menue(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let ueber = AboutMetadataBuilder::new()
        .name(Some("Netzinfo"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("© 2026 Mia Grünwald"))
        .build();
    let trenn = || PredefinedMenuItem::separator(app);
    let einstellungen = MenuItem::with_id(
        app,
        "einstellungen",
        "Einstellungen …",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let hilfe = Submenu::with_items(
        app,
        "Hilfe",
        true,
        &[
            &MenuItem::with_id(app, "repo", "Netzinfo auf GitHub", true, None::<&str>)?,
            &MenuItem::with_id(app, "fehler", "Fehler melden", true, None::<&str>)?,
        ],
    )?;
    let fenster = Submenu::with_items(
        app,
        "Fenster",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("Minimieren"))?,
            &PredefinedMenuItem::maximize(app, Some("Zoomen"))?,
            &PredefinedMenuItem::close_window(app, Some("Fenster schließen"))?,
        ],
    )?;
    // Ohne diese beiden Aufrufe fügt macOS seine eigenen Einträge (Suche, Fensterliste) nicht ein.
    // Die beiden gibt es nur unter macOS, die CI baut die App auch unter Linux.
    #[cfg(target_os = "macos")]
    {
        let _ = fenster.set_as_windows_menu_for_nsapp();
        let _ = hilfe.set_as_help_menu_for_nsapp();
    }
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Netzinfo",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("Über Netzinfo"), Some(ueber))?,
                    &trenn()?,
                    &einstellungen,
                    &trenn()?,
                    &PredefinedMenuItem::hide(app, Some("Netzinfo ausblenden"))?,
                    &PredefinedMenuItem::hide_others(app, Some("Andere ausblenden"))?,
                    &PredefinedMenuItem::show_all(app, Some("Alle einblenden"))?,
                    &trenn()?,
                    &PredefinedMenuItem::quit(app, Some("Netzinfo beenden"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Bearbeiten",
                true,
                &[
                    &PredefinedMenuItem::cut(app, Some("Ausschneiden"))?,
                    &PredefinedMenuItem::copy(app, Some("Kopieren"))?,
                    &PredefinedMenuItem::paste(app, Some("Einfügen"))?,
                    &PredefinedMenuItem::select_all(app, Some("Alles auswählen"))?,
                ],
            )?,
            &fenster,
            &hilfe,
        ],
    )
}

fn main() {
    let r = tauri::Builder::default()
        .menu(menue)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            // Das Fenster kann versteckt sein (Schließen versteckt nur): erst holen, dann umschalten.
            "einstellungen" => {
                wache::fenster_oeffnen(app);
                if let Some(w) = app.get_webview_window("main") {
                    // Scheitert das Skript, bleibt es beim geöffneten Fenster.
                    let _ = w.eval("Netz.einstellungen()");
                }
            }
            // Scheitert das Öffnen, passiert nichts: Die Seite steht im README.
            "repo" => drop(im_browser(REPO)),
            "fehler" => drop(im_browser(&format!("{REPO}/issues/new"))),
            _ => {}
        })
        .plugin(tauri_plugin_notification::init())
        .setup(|app| Ok(wache::starten(app)?))
        // Closing the window hides it; the guard keeps running in the menu bar.
        .on_window_event(|w, ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                // Scheitert das Verstecken, bleibt das Fenster sichtbar: harmlos.
                let _ = w.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            dieses_netz,
            netz_merken,
            gemerkte_netze,
            netz_vergessen,
            netz_umbenennen,
            netz_markieren,
            pruefen,
            messen_einmal,
            bericht,
            geraete_suchen,
            pfad_messen,
            portal_pruefen,
            diagnose,
            portal_im_browser_oeffnen,
            breitbandmessung_oeffnen,
            dns_verschluesselt,
            wlan_lesen,
            verbindungen_zeigen,
            verbindungen_loeschen,
            offen_zeigen,
            traffic_messen,
            geraete_karten,
            geraet_setzen,
            ort_status,
            ort_anfragen,
            ort_einstellungen_oeffnen,
            dns_gespeichert,
            wlan_verlauf_abtasten,
            woher_zeigen,
            live_sonde,
            mtu_messen,
            dns_tempo,
            sni_pruefen,
            ipv6_messen,
            zeit_pruefen,
            egress_pruefen,
            wlan_umfeld,
            proxy_lesen,
            proxy_pac_ansehen,
            ipv6_router,
            router_seite,
            last_vorab,
            last_messen,
            autostart_lesen,
            autostart_setzen,
            portfreigaben,
            autostart_hinweis,
            ausfaelle,
            fritzbox_zugang,
            fritzbox_speichern,
            fritzbox_entfernen,
            fritzbox_lesen,
            engpass_lesen,
        ])
        .build(tauri::generate_context!())
        .map(|app| {
            // Click on the Dock icon with the window closed: bring it back. Only macOS has that event.
            #[cfg(target_os = "macos")]
            app.run(|app, ev| {
                if let tauri::RunEvent::Reopen { .. } = ev {
                    wache::fenster_oeffnen(app);
                }
            });
            #[cfg(not(target_os = "macos"))]
            app.run(|_, _| {});
        });
    if let Err(e) = r {
        eprintln!("Die App ließ sich nicht starten: {e}");
        std::process::exit(1);
    }
}
