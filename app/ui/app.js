// Gerüst der App: Seitenleiste, Werkzeugleiste, Erklärmodus und die kleinen Bausteine,
// die alle Ansichten teilen. Jede Ansicht liegt in ansichten/<name>.js und meldet sich mit
// Netz.registriere({ id, titel, icon, render(wurzel), aktualisieren?, teil? }) an. Welche Ansicht in welchem
// Abschnitt der Seitenleiste steht, sagt die Tabelle `abschnitte`; was dort fehlt, landet unten ohne Titel.
// `teil: true` hält eine Ansicht aus der Seitenleiste: Sie lebt eingebettet (Netz.einbetten) in einer anderen.
// Die Einstellungen (id `gemerkte-netze`) sind ein Teil und stehen als abgesetzter Knopf unten in der Seitenleiste (⌘, aus dem Menü der App und hier).
(() => {
  // Vier Ansichten, jede beantwortet oben eine Frage (#208). „Offen“ geht in „Verbindungen“ auf.
  const abschnitte = [[null, ['uebersicht', 'tempo', 'geraete', 'verbindungen', 'offen']]];
  const EINSTELLUNGEN = 'gemerkte-netze';
  const ansichten = [];
  let aktuell = null;
  let reihe = [];
  let zaehler = 0;

  // Fehlt die Brücke zum Kern (z. B. Seite im Browser geöffnet), wirft das einen Satz statt eines TypeError.
  const invoke = async (befehl, args) => {
    const kern = window.__TAURI__?.core?.invoke;
    if (!kern) throw 'Netzinfo erreicht den Kern nicht. Starte die App neu.';
    return kern(befehl, args);
  };

  // Kleiner Elementbauer. `html` (innerHTML) nur für feste Symbole aus dem Quelltext: die Icons unten und in den
  // Ansichten (Netz.icons.*, NETZ_BILDER, SYMBOLE und ZUFALL in geraete.js) sowie das `icon` von leerZustand.
  // Geprüft per grep über app/ui/ (#176): Nie landet dort ein Wert aus dem Netz (SSID, Gerätename, Programmname).
  // Alles Fremde geht über `text` (textContent) oder als Kind (append), beides setzt keinen Markup.
  function el(tag, props = {}, ...kinder) {
    const e = document.createElement(tag);
    for (let [k, v] of Object.entries(props)) {
      // ARIA wants the words true and false, not a present or missing attribute.
      if (k.startsWith('aria-') && typeof v === 'boolean') v = String(v);
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    e.append(...kinder.flat().filter((k) => k != null && k !== false));
    return e;
  }

  const svg = (pfade) =>
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pfade}</svg>`;
  const icons = {
    wlan: svg('<path d="M1.8 6a8.5 8.5 0 0 1 12.4 0M4 8.5a5.4 5.4 0 0 1 8 0M6.2 11a2.3 2.3 0 0 1 3.6 0"/><circle cx="8" cy="13" r=".6" fill="currentColor"/>'),
    merken: svg('<path d="M4 2.5h8v11L8 10.5l-4 3z"/>'),
    pruefung: svg('<path d="M8 1.8 13 3.6v4.2c0 3-2 5.2-5 6.4-3-1.2-5-3.4-5-6.4V3.6z"/><path d="m5.8 8 1.7 1.7L10.4 6.4"/>'),
    qualitaet: svg('<path d="M1.5 8.5h3l2-5 3 9 2-4h3"/>'),
    zahnrad: svg('<path d="M13.3 6.4 L15.1 6.6 L15.1 9.4 L13.3 9.6 L12.9 10.6 L14 12 L12 14 L10.6 12.9 L9.6 13.3 L9.4 15.1 L6.6 15.1 L6.4 13.3 L5.4 12.9 L4 14 L2 12 L3.1 10.6 L2.7 9.6 L0.9 9.4 L0.9 6.6 L2.7 6.4 L3.1 5.4 L2 4 L4 2 L5.4 3.1 L6.4 2.7 L6.6 0.9 L9.4 0.9 L9.6 2.7 L10.6 3.1 L12 2 L14 4 L12.9 5.4z"/><circle cx="8" cy="8" r="2.1"/>'),
    geraete: svg('<rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M5.5 13.5h5M8 11v2.5"/>'),
  };

  // Zeit in der Zeitzone des Macs, z. B. „26.10.2026, 21:30“.
  const zeit = (sekunden) =>
    Number.isFinite(sekunden)
      && sekunden > 0 && !isNaN(new Date(sekunden * 1000)) // 0 und Riesenwerte wären „01.01.1970“ oder „Invalid Date“
      ? new Date(sekunden * 1000).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
      : 'unbekannt';

  // Fehler aus dem Kern sind deutsche Sätze, entweder pur oder als { art, text } (art: nicht_gemerkt,
  // nicht_meins, sonstiges). Ansichten fragen `f?.art`, nie den Satz. Alles andere ist ein Fehler der Oberfläche.
  // Ein Error, ein Objekt ohne `text`, leer oder das Wort „undefined“ ergeben den allgemeinen Satz, nie „[object Object]“.
  const ALLGEMEIN = 'In der Oberfläche ist etwas schiefgegangen. Starte die App neu.';
  // Ein Befehl, der nie antwortet, sperrt keine Ansicht und keinen Knopf: Nach `ms` endet das Warten mit `satz`. Der Kern
  // lässt sich nicht abbrechen, seine späte Antwort zählt nicht mehr. `window.NETZ_ZEITLIMIT_MS` setzt nur die Vorschau.
  const frist = (versprechen, ms, satz = 'Keine Antwort. Prüf, ob du im Netz bist, und versuch es noch mal.') => {
    let uhr;
    const ablauf = new Promise((_, nein) => { uhr = setTimeout(() => nein(satz), window.NETZ_ZEITLIMIT_MS ?? ms); });
    return Promise.race([versprechen, ablauf]).finally(() => clearTimeout(uhr));
  };
  const text = (fehler) => {
    const satz = typeof fehler === 'string' ? fehler : fehler?.text;
    return typeof satz === 'string' && satz.trim() && !/^(\[object \w+\]|undefined|null)$/.test(satz.trim()) ? satz : ALLGEMEIN;
  };

  // Core sentences name CLI commands in `backticks`: show them as code, not as raw marks.
  const mitCode = (satz) => satz.split('`').map((t, i) => (i % 2 ? el('code', { text: t }) : t));

  // Plattform einmal aus dem Webview lesen: Tastenkürzel und Hinweise unterscheiden sich zwischen Mac und Linux.
  const mac = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  const taste = (k) => (mac ? `⌘${k}` : `Strg+${k}`);
  const istTaste = (e) => (mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey;
  // Sätze des Kerns für Funktionen, die es nur auf dem Mac gibt: unter Linux ein ruhiger Hinweis statt einer Fehlerkarte.
  const NUR_MAC = /gibt es (bisher |noch )?nur|nur (unter macOS|auf dem Mac|die Mac-App|im macOS)|noch nicht unterstützt|unter Linux noch nicht|läuft nur auf dem Mac/;
  const nurMac = (satz) => !mac && NUR_MAC.test(typeof satz === 'string' ? satz : text(satz));
  const LINUX_NOCH_NICHT = 'Das gibt es unter Linux noch nicht.';

  const meldung = (satz, farbe = 'rot') =>
    el('p', { class: 'meldung', role: 'alert' }, el('span', { class: `punkt ${farbe}` }), el('span', {}, mitCode(typeof satz === 'string' ? satz : text(satz))));

  // Fehler mit Ausweg: Satz plus „Erneut versuchen“ (lädt die Ansicht neu). `nochmal` ersetzt das Neuladen, z. B. für eine einzelne Messung.
  const fehlerKarte = (satz, nochmal) => nurMac(satz)
    ? el('div', { class: 'fehler-karte' }, meldung(LINUX_NOCH_NICHT, 'grau'))
    : el('div', { class: 'fehler-karte' }, meldung(satz, 'rot'),
      el('button', {
        class: 'knopf', type: 'button', text: 'Erneut versuchen',
        // Zeichnet der Versuch den Inhalt neu, hängt der Fokus sonst am entfernten Knopf.
        onclick: async () => { await (nochmal ?? neuLaden)(); if (document.activeElement === document.body) zumKopf(); },
      }));

  const status = (farbe, wort) =>
    el('p', { class: 'status' }, el('span', { class: `punkt ${farbe}` }), el('span', { text: wort }));

  // Gruppe wie in den Systemeinstellungen: Titel, abgerundete Liste, optional eine Fußnote.
  let gruppenNr = 0;
  function gruppe(titel, zeilen, fuss) {
    // Die Nummer hält die id eindeutig, auch wenn zwei Gruppen denselben Titel tragen.
    const id = `g-${titel.toLowerCase().replace(/[^a-zäöüß]+/g, '-')}-${++gruppenNr}`;
    return el('section', { class: 'gruppe', 'aria-labelledby': id },
      el('h3', { id, text: titel }),
      el('dl', { class: 'liste' }, zeilen),
      fuss && el('p', { class: 'fuss', text: fuss }));
  }

  // Eine Zeile: Name links, Wert rechts, darunter der Satz für den Erklärmodus.
  // `wert` leer = noch unbekannt (gedämpft). `erklaerung` ist ein Satz.
  function zeile(label, wert, erklaerung) {
    const leer = wert == null || wert === '' || (typeof wert === 'number' && !Number.isFinite(wert));
    return el('div', { class: 'zeile' },
      el('dt', { class: 'label', text: label }),
      el('dd', { class: `wert${leer ? ' leer' : ''}`, text: leer ? 'unbekannt' : wert }),
      erklaerung && el('dd', { class: 'erklaerung', text: erklaerung }));
  }

  // `bild` (optional) ist ein Name aus ui/bilder.js und ersetzt das kleine Symbol durch ein Strichbild.
  function leerZustand(icon, satz, bild) {
    const gross = bild && window.NETZ_BILDER?.[bild];
    return el('div', { class: 'leer-zustand' },
      gross ? el('span', { class: 'leer-bild', html: gross }) : el('span', { html: icon }),
      el('p', { text: satz }));
  }

  // „Woher?“: Aktion einer Zeile, lädt die Startkette des Prozesses erst beim Aufklappen (#56).
  // Gibt [Knopf, Feld] zurück; beide als Kinder der Zeile einsetzen (el() flacht Listen).
  let woherNr = 0;
  const QUELLE = { Terminal: 'Terminal', Systemdienst: 'Systemdienst', Anmeldeobjekt: 'Anmeldeobjekt', Unbekannt: 'unbekannt' };
  function woher(pid, programm) {
    const id = `woher-${++woherNr}`;
    const inhalt = el('div', { class: 'woher-inhalt', id, hidden: true });
    const knopf = el('button', { class: 'woher-knopf', type: 'button', text: 'Woher?', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': `Woher kommt ${programm || `PID ${pid}`}?` });
    knopf.addEventListener('click', async () => {
      const auf = inhalt.hidden;
      inhalt.hidden = !auf;
      knopf.setAttribute('aria-expanded', String(auf));
      if (!auf || inhalt.childElementCount) return;
      try {
        const h = await invoke('woher_zeigen', { pid });
        inhalt.append(
          el('div', { class: 'fein', text: `Quelle: ${QUELLE[h.quelle] ?? 'unbekannt'}` }),
          // Fehlt die Kette, steht nur der Satz; Einrückung endet bei 10 Stufen, damit lange Ketten nicht aus dem Fenster laufen.
          el('ul', { class: 'woher-kette' }, [...(h.kette ?? [])].reverse().map((p, i) =>
            el('li', { class: 'num', style: `margin-left:${Math.min(i, 10) * 14}px`, text: `${p?.name ?? 'unbekannt'} (PID ${p?.pid ?? '?'})` }))),
          h.satz && el('p', { class: 'fein', text: h.satz }));
      } catch (f) {
        inhalt.append(meldung(text(f), 'rot'));
      }
    });
    return [knopf, inhalt];
  }

  // Löschen mit Bestätigung: Frage, „Abbrechen“ (auch Escape) und der rote Knopf. `aktion` darf werfen,
  // dann zeigt `fehler(f)` den Satz und der Knopf wird wieder frei. Der Aufrufer setzt das Ergebnis
  // in seine Zeile und baut bei `abbrechen` die alte Zeile zurück. Der Fokus landet auf „Abbrechen“.
  function bestaetigung({ frage, label, aria, knopf = 'Löschen', aktion, abbrechen, fehler }) {
    const nein = el('button', { class: 'knopf', type: 'button', text: 'Abbrechen', onclick: abbrechen });
    const ja = el('button', { class: 'knopf gefahr', type: 'button', text: knopf, 'aria-label': aria });
    ja.addEventListener('click', async () => {
      ja.disabled = true;
      try { await aktion(); } catch (f) { fehler(f); ja.disabled = false; }
    });
    queueMicrotask(() => nein.focus());
    return el('div', {
      class: 'bestaetigung', role: 'group', 'aria-label': label,
      onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); abbrechen(); } },
    }, el('p', { text: frage }), nein, ja);
  }

  // ---- Seitenleiste ----
  function baueMenue() {
    const menue = document.getElementById('menue');
    const eintrag = (a) => el('button', {
      class: 'eintrag', role: 'tab', id: `tab-${a.id}`, 'data-id': a.id,
      'aria-selected': 'false', tabindex: '-1',
      // Ein Klick holt den Fokus in die Seitenleiste (WebKit tut das bei Knöpfen nicht), sonst gehen die Pfeiltasten ins Leere.
      onclick: () => zeige(a.id, { fokus: true }),
      title: `${a.titel} (${taste(reihe.indexOf(a) + 1)})`, 'aria-keyshortcuts': `${mac ? 'Meta' : 'Control'}+${reihe.indexOf(a) + 1}`,
    }, el('span', { html: a.icon }), el('span', { text: a.titel }));
    const rest = new Set(ansichten.filter((a) => !a.teil));
    const bloecke = abschnitte.map(([titel, ids]) => {
      const mit = ids.map((id) => ansichten.find((a) => a.id === id)).filter((a) => a && !a.teil);
      mit.forEach((a) => rest.delete(a));
      return [titel, mit];
    });
    bloecke.push([null, [...rest]]);
    // Pfeiltasten gehen in der Reihenfolge der Seitenleiste, nicht der Anmeldung.
    reihe = bloecke.flatMap(([, mit]) => mit);
    for (const [titel, mit] of bloecke) {
      if (!mit.length) continue;
      menue.append(el('div', { class: 'abschnitt', role: 'presentation' },
        titel && el('div', { class: 'abschnitt-titel', 'aria-hidden': 'true', text: titel }),
        mit.map(eintrag)));
    }
    // Abgesetzt unten, ein Knopf statt eines Tabs: Die Einstellungen sind kein Bereich, sondern ein Ort wie in jeder Mac-App.
    menue.parentElement.append(el('div', { class: 'unten' }, el('button', {
      class: 'eintrag', id: 'einstellungen', type: 'button', title: `Einstellungen (${taste(',')})`, 'aria-keyshortcuts': `${mac ? 'Meta' : 'Control'}+Comma`,
      onclick: () => zeige(EINSTELLUNGEN, { fokus: true }),
    }, el('span', { html: icons.zahnrad }), el('span', { text: 'Einstellungen' }))));
    menue.addEventListener('keydown', (e) => {
      const schritt = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[e.key];
      if (!schritt || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      const i = reihe.findIndex((a) => a.id === aktuell);
      const n = Math.max(0, Math.min(reihe.length - 1, i + schritt));
      zeige(reihe[n].id, { fokus: true });
    });
  }

  // ---- Ansicht anzeigen ----
  async function zeige(id, { fokus = false, neuLaden = false } = {}) {
    const a = ansichten.find((x) => x.id === id);
    if (!a) return;
    const wechsel = id !== aktuell;
    aktuell = id;
    // Ganzseitig gezeigte Teile (auch die Einstellungen) markieren keinen Tab; der erste bleibt dann per Tab erreichbar.
    const ohneTab = !reihe.some((x) => x.id === id);
    for (const b of document.querySelectorAll('#menue .eintrag')) {
      const an = b.dataset.id === id;
      b.setAttribute('aria-selected', an);
      b.tabIndex = an || (ohneTab && b.dataset.id === reihe[0].id) ? 0 : -1;
      if (an && fokus) b.focus();
    }
    const einst = document.getElementById('einstellungen');
    if (id === EINSTELLUNGEN) einst.setAttribute('aria-current', 'page'); else einst.removeAttribute('aria-current');
    if (id === EINSTELLUNGEN && fokus) einst.focus();
    document.getElementById('titel').textContent = a.titel;
    const feld = document.getElementById('scroll');
    const knopf = document.getElementById('aktualisieren');
    // Fokus merken, bevor „Lädt …“ oder das Sperren des Knopfs ihn wegnehmen.
    const imInhalt = feld.contains(document.activeElement);
    const amKnopf = document.activeElement === knopf;
    // A view that owns ⌘R itself (aktualisieren: false) hides the shared button.
    document.getElementById('aktualisieren').hidden = a.aktualisieren === false;
    const nr = ++zaehler;
    bandWeg();
    // data-ansicht scopes a view's CSS file: all views share one document.
    const wurzel = el('div', { class: `ansicht${wechsel ? ' neu' : ''}`, 'data-ansicht': id });
    feld.setAttribute('aria-busy', 'true');
    // Dauert das Laden, steht beim Wechsel nicht die alte Ansicht unter dem neuen Titel.
    knopf.disabled = true;
    const wartet = wechsel && setTimeout(() => {
      if (nr === zaehler) feld.replaceChildren(el('div', { class: 'ansicht' }, leerZustand('', 'Lädt …')));
    }, 250);
    try {
      // Auch eine Ansicht, die beim Aufbau hängen bleibt, gibt ⌘R und den Knopf wieder frei (ohne die Kürzung der Vorschau).
      let uhr;
      const satz = 'Die Ansicht hat nach zweieinhalb Minuten nicht fertig geladen. Versuch es noch einmal.';
      await Promise.race([a.render(wurzel), new Promise((_, nein) => { uhr = setTimeout(nein, 150000, satz); })]).finally(() => clearTimeout(uhr));
    } catch (e) {
      console.error(e);
      wurzel.replaceChildren(fehlerKarte(text(e)));
    }
    clearTimeout(wartet);
    if (nr !== zaehler) return; // inzwischen woanders hingeklickt
    knopf.disabled = false;
    const oben = wechsel || !neuLaden ? 0 : feld.scrollTop;
    feld.replaceChildren(wurzel);
    feld.scrollTop = oben;
    feld.removeAttribute('aria-busy');
    // Wo der Fokus im alten Inhalt stand, steht er jetzt an der Überschrift des neuen (nicht im Nichts).
    if (imInhalt || feld.contains(document.activeElement)) zumKopf();
    else if (amKnopf) knopf.focus();
  }

  // Fokus an die Überschrift der Ansicht (tabindex -1), sonst an „Erneut versuchen“, sonst ans Inhaltsfeld.
  function zumKopf() {
    const feld = document.getElementById('scroll');
    const ziel = feld.querySelector('h2') ?? feld.querySelector('.fehler-karte .knopf') ?? feld;
    if (!ziel.matches('button')) ziel.tabIndex = -1;
    ziel.focus({ preventScroll: true });
  }

  const neuLaden = () => zeige(aktuell, { neuLaden: true });

  // ⌘, kommt aus dem Menü der App (main.rs) und als Tastendruck hierher: Wer zuerst da ist, öffnet, der zweite ändert nichts.
  const einstellungen = (fokus = false) => { if (aktuell !== EINSTELLUNGEN) zeige(EINSTELLUNGEN, { fokus }); };

  // Eine Teilansicht in eine andere einbetten: eigene Wurzel mit data-ansicht, damit ihr CSS greift.
  // Ihre Schleifen enden wie bisher über isConnected, sobald die äußere Ansicht ersetzt wird.
  async function einbetten(id) {
    const a = ansichten.find((x) => x.id === id);
    const w = el('div', { class: 'eingebettet', 'data-ansicht': id });
    try { await a.render(w); } catch (e) { console.error(e); w.replaceChildren(fehlerKarte(text(e))); }
    return w;
  }

  // ---- Erklärmodus ----
  function erklaermodus() {
    const knopf = document.getElementById('erklaeren');
    const setze = (an) => {
      document.body.classList.toggle('erklaeren', an);
      knopf.setAttribute('aria-checked', an);
      try { localStorage.setItem('netzinfo.erklaeren', an ? '1' : '0'); } catch { /* ohne Speicher bleibt er pro Start */ }
    };
    let an = false;
    try { an = localStorage.getItem('netzinfo.erklaeren') === '1'; } catch { /* s. o. */ }
    setze(an);
    knopf.addEventListener('click', () => setze(knopf.getAttribute('aria-checked') !== 'true'));
  }

  // ---- Unbehandelte Fehler ----
  // Ein Fehler außerhalb von render (Zeitgeber, Klick, vergessenes await) ließ die Ansicht still stehen. Jetzt steht ein
  // Satz unten, bis man ihn schließt oder neu lädt. Gegen Schleifen: gleicher Satz binnen 5 s zählt nicht neu, nach 20
  // Meldungen bleibt nur noch die Konsole, und der Fänger selbst wirft nie.
  let bandZahl = 0;
  let bandLetzte = [null, 0];
  function bandWeg() { document.getElementById('fehlerband')?.remove(); }
  function fang(f, quelle) {
    try {
      console.error(quelle, f);
      if (/ResizeObserver loop/.test(String(f?.message ?? f))) return; // harmlos, kein Fehler der App
      // Sätze aus dem Kern (String oder { text }) zeigen wir, bei einem Error der Oberfläche der allgemeine Satz.
      const satz = text(f?.reason ?? f?.error ?? f);
      const jetzt = Date.now();
      if (bandLetzte[0] === satz && jetzt - bandLetzte[1] < 5000) return;
      bandLetzte = [satz, jetzt];
      if (++bandZahl > 20) return;
      bandWeg();
      document.body.append(el('div', { id: 'fehlerband', class: 'fehlerband' }, meldung(satz),
        el('button', { class: 'knopf', type: 'button', text: 'Schließen', onclick: bandWeg }),
        el('button', { class: 'knopf haupt', type: 'button', text: 'Ansicht neu laden', onclick: () => neuLaden() })));
    } catch (e) { console.error(e); }
  }

  function start() {
    window.addEventListener('unhandledrejection', (e) => fang(e, 'unhandledrejection'));
    window.addEventListener('error', (e) => fang(e, 'error'));
    // Only events, no initial check: unknown focus (e.g. headless Chrome) looks active.
    for (const ev of ['focus', 'blur']) window.addEventListener(ev, () => document.documentElement.classList.toggle('inaktiv', ev === 'blur'));
    document.getElementById('aktualisieren-taste').textContent = taste('R');
    document.getElementById('aktualisieren').title = `Aktualisieren (${taste('R')})`;
    baueMenue();
    erklaermodus();
    document.getElementById('aktualisieren').addEventListener('click', neuLaden);
    document.addEventListener('keydown', (e) => {
      if (!istTaste(e)) return;
      // ⌘1 bis ⌘4: Ansichten in der Reihenfolge der Seitenleiste.
      if (/^[1-4]$/.test(e.key) && reihe[e.key - 1]) { e.preventDefault(); zeige(reihe[e.key - 1].id, { fokus: !!document.activeElement?.closest('nav') }); }
      else if (e.key.toLowerCase() === 'r') { e.preventDefault(); neuLaden(); }
      // ⌘, wie in jeder Mac-App: Einstellungen (gemerkte Netze, Autostart, Fritz!Box).
      else if (e.key === ',') { e.preventDefault(); einstellungen(!!document.activeElement?.closest('nav')); }
    });
    if (!reihe.length) return document.getElementById('scroll').append(fehlerKarte('Keine Ansicht geladen. Starte die App neu.', () => location.reload()));
    zeige(reihe[0].id);
  }

  window.Netz = {
    invoke, frist, el, icons, mac, taste, istTaste, nurMac, LINUX_NOCH_NICHT, zeit, text, meldung, fehlerKarte, status, gruppe, zeile, leerZustand, neuLaden, zumKopf, woher, bestaetigung,
    einbetten, zeige, einstellungen,
    registriere: (a) => ansichten.push(a),
  };
  document.addEventListener('DOMContentLoaded', start);
})();
