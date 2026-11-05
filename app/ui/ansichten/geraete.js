// „Geräte“: eine Karte je gemerktem Gerät (Typ, Hersteller, Dienste, Hinweise), „Suchen“ frischt auf.
// Die Schutzregel („meins“) steckt im Kern (src/geraete.rs). Hier wird nur ihre Ablehnung gezeigt.
(() => {
  const { el, zeit, status, meldung, gruppe, zeile, leerZustand } = Netz;

  const DIENSTE = {
    22: 'SSH', 53: 'DNS', 80: 'Web', 443: 'Web (TLS)', 445: 'Dateifreigabe (SMB)', 548: 'Dateifreigabe (AFP)',
    631: 'Drucker (IPP)', 7000: 'AirPlay', 8009: 'Cast', 9100: 'Drucker (RAW)', 62078: 'iPhone-Sync',
  };
  // Sort key per address: IPv4 numeric (192.0.2.9 before 192.0.2.10), then IPv6 group by group.
  const v6 = (ip) => {
    const [a, b] = ip.split('::');
    const teil = (t) => (t ? t.split(':') : []);
    const l = teil(a);
    const r = b === undefined ? [] : teil(b);
    return [...l, ...Array(Math.max(0, 8 - l.length - r.length)).fill('0'), ...r].map((g) => parseInt(g, 16) || 0);
  };
  const ipSchluessel = (ip) => {
    const s = String(ip ?? '').split('%')[0];
    return s.includes(':') ? [6, ...v6(s)] : [4, ...s.split('.').map((o) => Number(o) || 0)];
  };
  const ipVergleich = (a, b) => {
    const x = ipSchluessel(a);
    const y = ipSchluessel(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
    return 0;
  };
  // Lookups with names from outside (type, port, state): „constructor“ must not find Object.prototype.
  const nach = (tabelle, schluessel) => (Object.hasOwn(tabelle, schluessel) ? tabelle[schluessel] : undefined);
  // The shell cannot cancel a command, but a view must not wait forever: after the limit the button is free again.
  Netz.geraeteLimit = { suche: 180000, router: 30000, speichern: 20000 };
  const mitLimit = (versprechen, ms) =>
    Netz.frist(versprechen, ms, 'Das dauert ungewöhnlich lange. Prüfe die Verbindung zum Netz und versuche es noch einmal.');
  const SEITE = 60; // cards drawn at once; a /24 has up to 254

  const E = {
    abgelehnt: 'Wenn du an einen Port klopfst und die Verbindung aktiv abgelehnt wird, hat ein laufendes Gerät geantwortet: Nur ein Gerät kann diese Ablehnung (ein RST-Paket) schicken. Auch ohne offenen Port beweist sie also, dass dort jemand ist.',
    ptr: 'PTR ist die Rückwärtsauflösung im DNS: von der IP zum Namen, abgefragt unter z. B. 20.178.168.192.in-addr.arpa. Viele Router tragen dort die Namen ihrer DHCP-Kunden ein, andere liefern nichts, dann bleibt der Name leer.',
    mac: 'Die MAC-Adresse ist die Hardware-Nummer der Netzkarte und bleibt gleich, auch wenn der Router dem Gerät eine andere IP gibt. Dein Rechner kennt sie aus seiner Nachbartabelle (ARP): Er fragt „Wer hat diese IP?“ und merkt sich die Antwort. Darum erkenne ich ein Gerät wieder und zeige seine früheren IPs.',
    typ: 'Der Typ kommt aus Regeln: Bietet ein Gerät per Bonjour „Drucken“ an oder hat Port 631 offen, hält Netzinfo es für einen Drucker. Mehrere Hinweise zählen zusammen; bei Gleichstand bleibt es „Unbekannt“. Ein Gerät kann sich anders ausgeben, als es ist. Was du selbst einträgst, ändert kein neuer Lauf.',
    fritz: 'Diese Liste kommt vom Router selbst. Der Router weiß auch von Geräten, die auf Netzinfo nicht antworten. Netzinfo fragt die Fritz!Box über TR-064, ihren Fernzugriff im Heimnetz, und meldet sich dort mit HTTP Digest an: Das Passwort geht nicht im Klartext über das Netz, nur ein MD5-Wert aus Passwort und einer Zahl, die die Fritz!Box vorgibt. Gelesen wird nur die Geräteliste. Das Passwort liegt im macOS-Schlüsselbund, nie in einer Datei.',
    fehlen: 'Ohne Root-Rechte kann Netzinfo weder pingen noch ARP lesen. Ein Gerät, das jedes Paket verwirft (Firewall im Tarnmodus, Handy im Standby), antwortet auf nichts und bleibt unsichtbar. „Verschwunden“ heißt deshalb nur: diesmal nicht gefunden.',
  };

  // Eine unsichtbare, höfliche Ansage für Ergebnisse, die einmal kommen (Suche fertig, Router gelesen).
  // Ganze Blöcke mit Erklärtexten als aria-live vorzulesen wäre zu viel.
  const ansageOrt = el('div', { class: 'nur-vorlesen', role: 'status', 'aria-live': 'polite' });
  const ansage = (satz) => { ansageOrt.textContent = ''; setTimeout(() => { ansageOrt.textContent = satz; }, 50); };
  let idNr = 0;
  const neueId = (n) => `geraete-${n}-${++idNr}`;
  // Das Feld, das zur Fehlermeldung gehört, zeigt auf sie (VoiceOver liest sie beim Feld mit).
  const amFeld = (felder, ort) => felder.forEach((f) => { f.setAttribute('aria-invalid', 'true'); f.setAttribute('aria-describedby', ort.id); });
  const ohneFehler = (felder) => felder.forEach((f) => { f.removeAttribute('aria-invalid'); f.removeAttribute('aria-describedby'); });

  let letztes = null; // last result, so a tab change does not lose it
  let laufend = null; // running search; a re-render (⌘R) waits for it instead of starting a second scan

  // The kernel names the refusal in `art`; the view never reads the sentence.
  const abgelehnt = (f) => f?.art === 'nicht_meins';
  // Der Kern verweist dort auf die Kommandozeile; die App sagt, was man hier tut.
  const NICHT_MEINS = 'In diesem Netz sucht Netzinfo nicht, weil es nicht als „meins“ markiert ist. Markiere es in den Einstellungen, wenn es dir gehört. Wer in Schule, Firma oder fremdem WLAN Geräte durchprobiert, bekommt schnell Ärger.';
  const satz = (f) => (abgelehnt(f) ? NICHT_MEINS : Netz.text(f));

  // Card = one stored device (Rust: geraetekarte::Karte). All texts about the device come from the core.
  const TYPEN = ['Router', 'Drucker', 'Medien', 'Smart Home', 'Computer', 'Handy', 'Unbekannt'];
  // A type the view does not know (new core, foreign data) counts and shows as „Unbekannt“, never as a raw word.
  const sorte = (k) => (TYPEN.includes(k.typ) ? k.typ : 'Unbekannt');
  let filter = null; // null = all types
  let karten = [];
  let anzahl = SEITE; // how many cards are drawn
  let markiert = new Map(); // ip -> 'neu' | 'weg', from the last search
  const ZUFALL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5h2.5c3 0 4 7 7 7H14M2 11.5h2.5c1 0 1.8-1 2.5-2.2M9 6.2c.7-1 1.5-1.7 2.5-1.7H14M12.5 3 14 4.5 12.5 6M12.5 10 14 11.5 12.5 13"/></svg>';

  // Type icons in the line style of the sidebar; the core also sends an emoji (`symbol`), which is not shown.
  const SYMBOLE = {
    Router: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 17h.01M11 17h.01M8 11a6 6 0 0 1 8 0M5.5 8.5a10 10 0 0 1 13 0"/></svg>',
    Drucker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9V4h10v5M7 17H4V9h16v8h-3"/><rect x="7" y="14" width="10" height="6" rx="1"/></svg>',
    Medien: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    'Smart Home': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/></svg>',
    Computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 20h20"/></svg>',
    Handy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
    Unbekannt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 16.5h.01"/></svg>',
  };

  function bearbeiten(k, zu) {
    const nid = neueId('name');
    const tid = neueId('typ');
    const name = el('input', { id: nid, type: 'text', value: k.von_mia?.name ?? '', maxlength: '60', placeholder: k.anzeigename || k.ip, autocomplete: 'off' });
    const typ = el('select', { id: tid }, el('option', { value: '', text: 'Typ automatisch' }),
      TYPEN.slice(0, -1).map((t) => el('option', { value: t, text: t, selected: k.von_mia?.typ === t })));
    const fehler = el('div', { id: neueId('fehler') });
    const speichern = el('button', { class: 'knopf haupt', type: 'submit', text: 'Speichern' });
    return el('form', {
      class: 'karte-formular', 'aria-label': `Name und Typ ändern: ${k.anzeigename || k.ip}`,
      onsubmit: async (e) => {
        e.preventDefault();
        speichern.disabled = true;
        ohneFehler([name, typ]);
        try {
          await mitLimit(Netz.invoke('geraet_setzen', { schluessel: k.mac || k.ip, name: name.value.trim(), typ: typ.value }), Netz.geraeteLimit.speichern);
          try {
            karten = await Netz.invoke('geraete_karten');
          } catch (f) { // saved, only the list did not reload: say so instead of „not saved“
            speichern.disabled = false;
            kartenOrt.replaceChildren(Netz.fehlerKarte(`Gespeichert, aber die Liste lässt sich nicht neu laden. ${Netz.text(f)}`, ladeKarten));
            return;
          }
          zeichne(`[data-schluessel="${CSS.escape(k.mac || k.ip)}"]`);
        } catch (f) {
          fehler.replaceChildren(meldung(Netz.text(f), 'rot'));
          amFeld([name, typ], fehler);
          speichern.disabled = false;
          name.focus();
        }
      },
      onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); zu(); } },
    }, el('label', { class: 'nur-vorlesen', for: nid, text: 'Name' }), name,
    el('label', { class: 'nur-vorlesen', for: tid, text: 'Typ' }), typ,
    el('button', { class: 'knopf', type: 'button', text: 'Abbrechen', onclick: zu }), speichern, fehler);
  }

  // The core words some hints that the card already shows elsewhere (random address as a chip,
  // visits and dates in the time line). Here they are dropped instead of said twice.
  const doppelt = (k, h) => (k.mac_zufaellig && h.includes('zufällige MAC')) || /^wurde erst einmal gesehen/.test(h) || /^zuletzt vor .* gesehen$/.test(h);

  // Open ports and Bonjour services in one list: a port with its service name, a service without a port after it.
  function angebote(k) {
    const nachPort = new Map((k.ports ?? []).map((p) => [p, []]));
    const ohnePort = [];
    for (const d of k.dienste ?? []) {
      const name = d.instanz || d.typ;
      if (!d.port) ohnePort.push(name);
      else nachPort.set(d.port, [...(nachPort.get(d.port) ?? []), name]);
    }
    return [...nachPort].sort((x, y) => x[0] - y[0]).map(([port, namen]) => [String(port), nach(DIENSTE, port) ?? 'unbekannter Dienst', [...new Set(namen)].join(', ')])
      .concat(ohnePort.map((n) => ['', n, '']));
  }

  function zeiten(k) {
    return k.besuche <= 1 ? `Einmal gesehen am ${zeit(k.last_seen)}`
      : `Seit ${zeit(k.first_seen)}, zuletzt ${zeit(k.last_seen)}, ${k.besuche} Besuche`;
  }

  function karte(k, nr) {
    const tag = markiert.get(k.ip);
    const wort = tag === 'neu' ? ['gruen', 'neu'] : tag === 'weg' ? ['orange', 'nicht gefunden'] : null;
    const formular = el('div', { class: 'karte-bearbeiten' });
    const hinweise = (k.hinweise ?? []).filter((h) => !doppelt(k, h));
    const liste = angebote(k);
    // One grid: the symbol column runs through the whole card, so all text shares one left edge.
    const aendern = el('button', {
      class: 'knopf leise', type: 'button', text: 'Name und Typ ändern', 'data-schluessel': k.mac || k.ip,
      'aria-label': `Name und Typ ändern: ${k.anzeigename || k.ip}`,
      onclick: (e) => {
        const knopf = e.currentTarget;
        knopf.hidden = true;
        formular.replaceChildren(bearbeiten(k, () => { formular.replaceChildren(); knopf.hidden = false; knopf.focus(); }));
        formular.querySelector('input').focus();
      },
    });
    const kid = neueId('karte');
    return el('div', { class: k.gateway ? 'karte karte-breit' : 'karte', role: 'group', 'aria-labelledby': kid, tabindex: '-1', 'data-nr': String(nr) },
      el('span', { class: 'karte-symbol', html: SYMBOLE[sorte(k)], 'aria-hidden': 'true' }),
      el('div', { class: 'karte-kopf' },
        el('div', { class: 'text' },
          el('h3', { class: 'netz-name', id: kid, text: k.anzeigename || k.ip || 'Gerät ohne Namen' }),
          el('div', { class: 'fein' },
            el('span', { text: k.hersteller || 'Hersteller unbekannt' }),
            k.namequelle && el('span', { text: `Name: ${k.namequelle}` }),
            k.mac_zufaellig && el('span', { class: 'zufall' }, el('span', { html: ZUFALL }), el('span', { text: 'Zufällige Adresse' })))),
        el('div', { class: 'karte-rechts' },
          el('span', { class: 'karte-typ', text: sorte(k) }),
          wort && el('span', { class: 'status geraet-status' }, el('span', { class: `punkt ${wort[0]}` }), el('span', { text: wort[1] })))),
      el('div', { class: 'fein num', text: [k.ip, k.mac && `MAC ${k.mac}`].filter(Boolean).join(' · ') }),
      k.upnp && [k.upnp.modell, k.upnp.geraetetyp?.split(':')[3]].some(Boolean) && el('div', { class: 'fein', text: `UPnP: ${[k.upnp.modell, k.upnp.geraetetyp?.split(':')[3]].filter(Boolean).join(' · ')}` }),
      k.router && el('div', { class: 'fein', text: `${k.router.nur_router ? 'Nur vom Router bekannt' : 'Router'}: ${[k.router.verbindung !== 'unbekannt' && k.router.verbindung, k.router.aktiv ? 'aktiv' : 'nicht verbunden'].filter(Boolean).join(', ')}` }),
      el('div', { class: 'fein', text: zeiten(k) }),
      liste.length > 0 && el('ul', { class: 'karte-ports', role: 'list', 'aria-label': 'Offene Ports und Dienste' },
        liste.map(([port, name, wer]) => el('li', {}, el('span', { class: 'num', text: port }), el('span', {}, name, wer && el('span', { class: 'marke', text: ` · ${wer}` }))))),
      hinweise.length > 0 && el('ul', { class: 'karte-hinweise', role: 'list', 'aria-label': 'Hinweise' }, hinweise.map((h) => el('li', { text: h }))),
      k.erklaerung && el('p', { class: 'erklaerung', text: k.erklaerung }),
      k.gateway ? el('div', { class: 'karte-aktionen' }, routerKnoepfe()) : null,
      k.gateway && routerOrt,
      el('div', { class: 'karte-aktionen' }, aendern),
      formular);
  }

  // Router (Rust: router::Ergebnis, portfreigaben::Anzeige): two read-only looks at the gateway,
  // shown inside the router card. Both send, so both wait for a click.
  const E_ROUTER = 'Netzinfo ruft die Startseite des Routers einmal über http ab und lässt sich über https das Zertifikat zeigen. Gelesen wird nur die Kennung des Webservers, der Seitentitel und das Zertifikat. Es gibt kein Anmelden und kein Ausprobieren anderer Seiten. Ein selbst ausgestelltes Zertifikat ist bei Routern üblich und kein Zeichen für einen Angriff.';
  const E_FREIGABEN = 'Jede Zeile ist eine offene Tür: Was aus dem Internet an diesen Port kommt, geht an das Gerät im Heimnetz. Spielkonsolen legen so etwas oft selbst an, zum Beispiel Port 3074. Netzinfo fragt den Router per UPnP und kann nichts ändern. Von Hand im Router angelegte Freigaben erscheinen hier nicht.';
  const portStatus = (s) => (s === 'offen' ? 'erreichbar' : s === 'zu' ? 'geschlossen' : s?.fehler ?? 'unbekannt');
  let routerErgebnis = null;
  let freigabenErgebnis = null;
  const seiteOrt = el('div', { class: 'router-seite' });
  const freigabenOrt = el('div', { class: 'router-seite' });
  const fritzOrt = el('div', { class: 'router-seite fritz' });
  const routerOrt = el('div', { class: 'karte-router' }, seiteOrt, freigabenOrt, fritzOrt);

  function zeigeSeite(r) {
    const s = r.seite;
    const z = s.zertifikat;
    seiteOrt.replaceChildren(...[
      el('h4', { class: 'router-titel', text: 'Router-Webseite' }),
      el('div', { class: 'fein', text: `http (80): ${portStatus(s.http)}${s.http === 'offen' ? (s.umleitung ? ', leitet auf https um' : ', ohne Umleitung auf https') : ''}` }),
      el('div', { class: 'fein', text: `https (443): ${portStatus(s.https)}` }),
      z && el('div', { class: 'fein', text: `Zertifikat bis ${z.gueltig_bis}${z.abgelaufen ? ' (abgelaufen)' : ''}${z.selbstsigniert ? ', selbst ausgestellt' : ''}` }),
      s.server && el('div', { class: 'fein', text: `Server: ${s.server}` }),
      s.titel && el('div', { class: 'fein', text: `Seitentitel: ${s.titel}` }),
      r.hinweise.length > 0 && el('ul', { class: 'karte-hinweise', role: 'list', 'aria-label': 'Hinweise zur Router-Seite' }, r.hinweise.map((h) => el('li', { text: h }))),
      el('p', { class: 'erklaerung', text: E_ROUTER })].filter(Boolean));
  }

  function zeigeFreigaben(a) {
    const doppelNat = a.externe_ip_klasse === 'privat' || a.externe_ip_klasse === 'cgnat';
    const alarm = a.befunde.some(([schlimm]) => schlimm);
    let kopf;
    if (!a.upnp) kopf = [status('grau', 'UPnP aus'), el('div', { class: 'fein', text: 'Der Router antwortet nicht auf UPnP. Dann kann kein Programm selbst Ports ins Internet öffnen. Von Hand angelegte Freigaben siehst du hier nicht.' })];
    else if (a.liste_nur_mit_login) kopf = [status('orange', 'Liste nur mit Login'), el('div', { class: 'fein', text: 'Der Router zeigt seine Portfreigaben erst nach Anmeldung (bei der Fritz!Box üblich). Schau dort in der Oberfläche nach.' })];
    else if (a.listenfehler) kopf = [status('rot', 'Liste nicht lesbar'), el('div', { class: 'fein', text: a.listenfehler })];
    else if (!a.freigaben.length) kopf = [status('gruen', 'Keine Portfreigaben')];
    else kopf = [status(alarm ? 'rot' : 'orange', `${a.freigaben.length} ${a.freigaben.length === 1 ? 'Portfreigabe' : 'Portfreigaben'}`)];
    freigabenOrt.replaceChildren(...[
      el('h4', { class: 'router-titel', text: 'Portfreigaben' }),
      ...kopf,
      a.freigaben.length > 0 && el('ul', { class: 'karte-ports freigaben', role: 'list', 'aria-label': 'Portfreigaben' },
        a.freigaben.map((f) => el('li', {},
          el('span', { class: 'num', text: f.extern }),
          el('span', {}, `${f.protokoll} → ${f.intern_ip}:${f.intern_port}`,
            el('span', { class: 'marke', text: ` · ${[DIENSTE[f.extern], f.beschreibung?.toLowerCase() === DIENSTE[f.extern]?.toLowerCase() ? '' : f.beschreibung, f.aktiv ? '' : 'ausgeschaltet'].filter(Boolean).join(', ') || 'ohne Beschreibung'}` }))))),
      a.upnp && !a.listenfehler && !a.liste_nur_mit_login && el('div', { class: 'fein', text: `Verbindung: ${a.verbindung}. Externe Adresse: ${a.externe_ip_klasse}${doppelNat ? ', der Router hat keine öffentliche Adresse (Doppel-NAT), Freigaben bringen nichts' : ''}.` }),
      ...a.befunde.map(([schlimm, satz]) => meldung(satz, schlimm ? 'rot' : 'orange')),
      el('p', { class: 'erklaerung', text: E_FREIGABEN })].filter(Boolean));
  }

  function routerKnoepfe() {
    const lauf = (knopf, ort, ruf, zeige, fertig) => async () => {
      knopf.disabled = true;
      try {
        const r = await mitLimit(ruf(), Netz.geraeteLimit.router);
        zeige(r);
        ansage(fertig(r));
      } catch (f) {
        ort.replaceChildren(meldung(satz(f), abgelehnt(f) ? 'orange' : 'rot'));
      }
      knopf.disabled = false;
      knopf.focus(); // ein deaktivierter Knopf gibt den Fokus ab
    };
    const seite = el('button', { class: 'knopf', type: 'button', text: 'Sicherheit der Router-Webseite prüfen' });
    const freigaben = el('button', { class: 'knopf', type: 'button', text: 'Portfreigaben ansehen' });
    seite.addEventListener('click', lauf(seite, seiteOrt, async () => (routerErgebnis = await Netz.invoke('router_seite')), zeigeSeite, () => 'Router-Webseite geprüft. Das Ergebnis steht unter dem Knopf.'));
    freigaben.addEventListener('click', lauf(freigaben, freigabenOrt, async () => (freigabenErgebnis = await Netz.invoke('portfreigaben')), zeigeFreigaben,
      (a) => (a.freigaben.length ? `Portfreigaben gelesen: ${a.freigaben.length}. Das Ergebnis steht unter dem Knopf.` : 'Portfreigaben gelesen. Das Ergebnis steht unter dem Knopf.')));
    if (routerErgebnis) zeigeSeite(routerErgebnis);
    if (freigabenErgebnis) zeigeFreigaben(freigabenErgebnis);
    return el('span', { class: 'router-knoepfe' }, seite, freigaben);
  }

  // Fritz!Box (Rust: fritzbox::Abruf): die Geräteliste vom Router selbst über TR-064. Der Zugang liegt im
  // Schlüsselbund, hier kennt die Oberfläche nur den Benutzernamen, nie das Passwort.
  const istFritzbox = (k) => k.gateway && (/(^|\.)fritz\.box$/i.test(k.name ?? '') || /AVM|FRITZ/i.test(k.hersteller ?? ''));
  const fritz = { erkannt: false, geladen: false, benutzer: null, ergebnis: null, fehler: null, laeuft: false };
  const FRITZ_ZUSTAND = {
    zugang_falsch: ['rot', 'Zugang abgelehnt'],
    tr064_aus: ['orange', 'TR-064 ist aus'],
    nicht_erreichbar: ['orange', 'Nicht erreichbar'],
    keine_fritzbox: ['grau', 'Keine Fritz!Box'],
  };

  function fritzZeichne(fokus) {
    if (!fritz.erkannt || !fritz.geladen) { fritzOrt.replaceChildren(); return; }
    const teile = [el('h4', { class: 'router-titel', text: 'Fritz!Box-Geräteliste' })];
    const e = fritz.ergebnis;
    const bekannt = nach(FRITZ_ZUSTAND, e?.zustand);
    const zuEinstellungen = (text) => el('button', { class: 'knopf fritz-einrichten', type: 'button', text, onclick: () => Netz.fritzEintragen() });
    if (!fritz.benutzer) {
      teile.push(el('div', { class: 'fein', text: 'Die Fritz!Box kennt jedes Gerät im Heimnetz, auch die, die auf keinen Scan antworten. Dafür braucht Netzinfo einen eigenen Zugang. Den trägst du in den Einstellungen ein.' }),
        el('div', { class: 'karte-aktionen' }, zuEinstellungen('Zugang in den Einstellungen eintragen')));
      if (fritz.fehler) teile.push(meldung(Netz.text(fritz.fehler), 'rot'));
    } else {
      teile.push(el('div', { class: 'fein', text: `Zugang „${fritz.benutzer}“ im Schlüsselbund. Ändern oder entfernen kannst du ihn in den Einstellungen.` }),
        el('div', { class: 'karte-aktionen' }, el('button', { class: 'knopf fritz-lesen', type: 'button', text: 'Geräteliste lesen', disabled: fritz.laeuft, onclick: fritzLesen })));
      if (fritz.laeuft) teile.push(el('div', { class: 'fein', text: 'Lese die Liste …' }));
      else if (fritz.fehler) teile.push(meldung(satz(fritz.fehler), abgelehnt(fritz.fehler) ? 'orange' : 'rot'));
      else if (e?.zustand === 'ok') {
        const gefunden = e.gefunden ?? 0;
        teile.push(status('gruen', `${gefunden} ${gefunden === 1 ? 'Gerät' : 'Geräte'} vom Router gelesen`),
          el('div', { class: 'fein', text: e.neu ? `${e.neu} ${e.neu === 1 ? 'davon war' : 'davon waren'} neu in deiner Liste.` : 'Alle waren schon in deiner Liste.' }));
      } else if (e && bekannt) {
        teile.push(status(...bekannt), el('div', { class: 'fein', text: e.satz }));
      } else if (e) { // a state this view does not know: say so instead of showing nothing
        teile.push(status('orange', 'Antwort nicht verstanden'), el('div', { class: 'fein', text: e.satz || 'Die Fritz!Box hat etwas geantwortet, das Netzinfo nicht kennt. Versuche es noch einmal.' }));
      }
    }
    teile.push(el('p', { class: 'erklaerung', text: E.fritz }));
    fritzOrt.replaceChildren(...teile);
    if (fokus) fritzOrt.querySelector(fokus)?.focus();
  }

  async function fritzLesen() {
    if (fritz.laeuft) return; // a second click or the end of a search must not start a second read
    Object.assign(fritz, { laeuft: true, fehler: null });
    fritzZeichne();
    try {
      fritz.ergebnis = await mitLimit(Netz.invoke('fritzbox_lesen'), Netz.geraeteLimit.router);
      if (fritz.ergebnis.zustand === 'ok') karten = await Netz.invoke('geraete_karten');
    } catch (f) {
      Object.assign(fritz, { ergebnis: null, fehler: f });
    }
    fritz.laeuft = false;
    zeichne();
    fritzZeichne('.fritz-lesen');
    const e = fritz.ergebnis;
    ansage(fritz.fehler ? 'Geräteliste der Fritz!Box nicht gelesen.' : e?.zustand === 'ok' ? `Geräteliste der Fritz!Box gelesen: ${e.gefunden} ${e.gefunden === 1 ? 'Gerät' : 'Geräte'}, ${e.neu} neu.` : `Geräteliste der Fritz!Box nicht gelesen: ${nach(FRITZ_ZUSTAND, e?.zustand)?.[1] ?? 'Antwort nicht verstanden'}.`);
  }

  async function fritzLaden() {
    try {
      fritz.benutzer = await mitLimit(Netz.invoke('fritzbox_zugang'), Netz.geraeteLimit.router);
    } catch (f) {
      fritz.fehler = f;
    }
    fritz.geladen = true;
    fritzZeichne();
  }

  const kartenOrt = el('div', { class: 'karten-ort' });
  function zeichne(fokus) {
    const vorhanden = new Set(karten.map(sorte));
    if (filter && !vorhanden.has(filter)) filter = null;
    // Newest first; devices seen in the same scan keep a stable order by address.
    const sicht = karten.filter((k) => !filter || sorte(k) === filter)
      .sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0) || ipVergleich(a.ip, b.ip));
    const chip = (t) => el('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(filter === t), onclick: () => { filter = t; anzahl = SEITE; zeichne(`.chip[data-filter="${t ?? ''}"]`); ansage(`${t ?? 'Alle'}: ${karten.filter((k) => !t || sorte(k) === t).length} Geräte angezeigt.`); }, 'data-filter': t ?? '',
      text: t === null ? `Alle ${karten.length}` : `${t} ${karten.filter((k) => sorte(k) === t).length}`,
    });
    if (!karten.length) {
      kartenOrt.replaceChildren(leerZustand(Netz.icons.geraete, 'Noch keine Geräte gemerkt. Die Suche legt für jedes gefundene Gerät eine Karte an.', 'geraete'));
      return;
    }
    kartenOrt.replaceChildren(...[
      el('div', { class: 'filter', role: 'group', 'aria-label': 'Nach Typ filtern' },
        [null, ...TYPEN.filter((t) => vorhanden.has(t))].map(chip)),
      el('p', { class: 'fuss', text: 'Zuletzt gesehen zuerst. Der Typ ist eine Vermutung aus dem, was ein Gerät selbst ankündigt.' }),
      el('section', { class: 'karten', 'aria-label': 'Gerätekarten' }, sicht.slice(0, anzahl).map((k, nr) => karte(k, nr))),
      sicht.length <= anzahl ? null : el('div', { class: 'karten-mehr' },
        el('p', { class: 'fuss', text: `${anzahl} von ${sicht.length} Geräten angezeigt.` }),
        el('button', {
          class: 'knopf', type: 'button', text: `Weitere ${Math.min(SEITE, sicht.length - anzahl)} anzeigen`,
          onclick: () => { const erste = anzahl; anzahl += SEITE; zeichne(`.karte[data-nr="${erste}"]`); ansage(`${Math.min(anzahl, sicht.length)} von ${sicht.length} Geräten angezeigt.`); },
        }))].filter(Boolean));
    if (fokus) kartenOrt.querySelector(fokus)?.focus(); // das Neuzeichnen darf den Fokus nicht ins Leere schicken
  }

  async function ladeKarten() {
    try {
      karten = await Netz.invoke('geraete_karten');
      zeichne();
      fritz.erkannt = karten.some(istFritzbox);
      if (fritz.erkannt && !fritz.geladen) await fritzLaden();
      else fritzZeichne();
    } catch (f) {
      kartenOrt.replaceChildren(Netz.fehlerKarte(Netz.text(f), ladeKarten));
    }
  }

  function ergebnis(r) {
    markiert = new Map([...r.neu.map((d) => [d.ip, 'neu']), ...r.verschwunden.map((d) => [d.ip, 'weg'])]);
    const teile = [`${r.geraete.length} gefunden in ${r.bereich}`];
    if (!r.erster_lauf) teile.push(`${r.neu.length} neu`, `${r.verschwunden.length} verschwunden`);
    const kopf = status(r.geraete.length ? 'gruen' : 'orange', teile.join(' · '));
    const erster = r.erster_lauf && el('p', { class: 'fuss', text: 'Erster Lauf in diesem Netz: Das ist der Ausgangsstand, nichts ist „neu“. Ab dem nächsten Lauf siehst du, was dazukommt und was fehlt.' });
    return [kopf, erster, !r.geraete.length && el('p', { class: 'fuss', text: Netz.mac ? 'Keine Geräte gefunden. Hat dir macOS „Lokales Netzwerk“ für Netzinfo verweigert? Schalte es unter Systemeinstellungen > Datenschutz & Sicherheit > Lokales Netzwerk ein und such noch mal.' : 'Keine Geräte gefunden. Prüfe, ob eine Firewall das Absuchen blockt, und such noch mal.' })];
  }

  Netz.registriere({
    id: 'geraete',
    titel: 'Geräte',
    icon: Netz.icons.geraete,
    aktualisieren: false, // „Netz absuchen“ lädt die Karten ebenfalls neu
    async render(wurzel) {
      anzahl = SEITE;
      fritz.geladen = false; // der Zugang kann in den Einstellungen geändert worden sein
      const knopf = el('button', { class: 'knopf haupt', type: 'button', text: letztes ? 'Netz noch mal absuchen' : 'Netz absuchen' });
      const fortschritt = el('p', { class: 'fuss fortschritt' });
      const ort = el('div', { class: 'ergebnis' });
      // Der Systemdialog kommt erst beim ersten Absuchen: Vorher steht hier, wofür und was ohne die Freigabe fehlt.
      const hinweis = el('p', { class: 'fuss aktion-hinweis', text: Netz.mac ? 'Das Absuchen tastet das Netz ab. Beim ersten Mal fragt macOS, ob Netzinfo im „Lokalen Netzwerk“ suchen darf. Erlaube es, sonst findet die Suche keine Geräte.' : 'Das Absuchen tastet das Netz ab.' });
      // Ohne „meins“ lehnt der Kern ab: Das steht vorher da, und der erste Schritt ist das Markieren, nicht eine Suche, die scheitert.
      let erst = null;
      mitLimit(Netz.invoke('dieses_netz'), 10000).then((d) => {
        if (!knopf.isConnected || d?.netz?.meins) return;
        const neu = !d?.netz;
        hinweis.textContent = neu ? 'Dieses Netz ist noch nicht gemerkt. Netzinfo sucht nur in Netzen, die du als „meins“ markiert hast.' : 'Dieses Netz ist nicht als „meins“ markiert. Netzinfo sucht nur in Netzen, die dir gehören.';
        knopf.textContent = neu ? 'Dieses Netz merken …' : 'Als „meins“ markieren …';
        erst = () => Netz.zeige(neu ? 'uebersicht' : 'gemerkte-netze', { fokus: true });
      }).catch(() => {}); // ohne Antwort bleibt der Knopf eine Suche, der Kern sagt dann selbst, was fehlt

      async function suche() {
        if (erst) return erst();
        knopf.disabled = true;
        ort.replaceChildren();
        let bereich = 'deinem Netz';
        try {
          const s = (await mitLimit(Netz.invoke('dieses_netz'), Netz.geraeteLimit.router)).info.subnet;
          if (s) bereich = `${s.network}/${s.prefix}`;
          // The app searches the whole own subnet and has no „--gross“; the core refuses above /22 (src/geraete.rs).
          if (s && s.prefix < 22) {
            ort.replaceChildren(meldung(`Dein Netz ${bereich} ist sehr groß (über 1000 Adressen). Die App sucht nur in Netzen bis /22, damit sie das Netz nicht belastet. Auf der Kommandozeile geht \`netzinfo geraete --gross\`.`, 'orange'));
            ansage('Suche nicht gestartet: Das Netz ist zu groß.');
            knopf.disabled = false;
            knopf.focus();
            return;
          }
        } catch { /* the sentence stays general, the search itself reports real problems */ }
        fortschritt.textContent = `Suche in ${bereich} …`;
        ansage(`Suche in ${bereich} läuft.`);
        try {
          // ponytail: a hung search is only given up on in the view (the shell cannot cancel), a late result is dropped.
          laufend ??= mitLimit(Netz.invoke('geraete_suchen', { cidr: null, gross: false }), Netz.geraeteLimit.suche).finally(() => { laufend = null; });
          letztes = await laufend;
          if (!knopf.isConnected) return; // the view was left: the next visit shows `letztes`, no second read of the router
          ort.replaceChildren(...ergebnis(letztes).filter(Boolean));
          ansage(`Suche fertig: ${ort.querySelector('.status')?.textContent}.`);
          await ladeKarten();
          if (fritz.erkannt && fritz.benutzer) await fritzLesen(); // der Zugang ist eingerichtet: die Liste des Routers dazu
        } catch (f) {
          const nein = abgelehnt(f);
          ansage(nein ? 'Suche nicht erlaubt in diesem Netz.' : 'Suche fehlgeschlagen.');
          ort.replaceChildren(...[nein ? meldung(NICHT_MEINS, 'orange') : Netz.fehlerKarte(Netz.text(f), suche),
            nein && el('div', { class: 'aktion' }, el('button', {
              class: 'knopf', type: 'button', text: 'Zu den Einstellungen',
              onclick: () => Netz.zeige('gemerkte-netze'),
            }))].filter(Boolean));
        }
        fortschritt.textContent = '';
        knopf.disabled = false;
        knopf.focus();
      }
      knopf.addEventListener('click', suche);

      wurzel.append(
        el('div', { class: 'kopf' }, el('h2', { text: 'Geräte im Netz' }),
          el('p', { class: 'status' }, el('span', { text: 'Nur in Netzen, die du als „meins“ markiert hast.' }))),
        el('div', { class: 'aktion' }, knopf),
        hinweis,
        fortschritt, ort, ansageOrt, kartenOrt,
        Object.assign(gruppe('So funktioniert die Suche', [
          zeile('Abgelehnter Port', 'zeigt ein Gerät', E.abgelehnt),
          zeile('Name (PTR)', 'Rückwärts-DNS', E.ptr),
          zeile('MAC-Adresse', 'bleibt gleich', E.mac),
          zeile('Typ eines Geräts', 'eine Vermutung', E.typ),
          zeile('Geräteliste der Fritz!Box', 'vom Router selbst', E.fritz),
          zeile('Fehlende Geräte', 'können sich verstecken', E.fehlen),
        ]), { className: 'gruppe erklaer-gruppe' }));
      if (letztes) ort.replaceChildren(...ergebnis(letztes).filter(Boolean));
      ladeKarten();
      if (laufend) suche(); // reattach to the running search
    },
  });
})();
