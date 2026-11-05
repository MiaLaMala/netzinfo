// „Qualität“: misst alle 5 s, solange die Ansicht offen ist, und zeigt Kurve und Kennzahlen.
// „Tempo“ (tempo.js) baut aus denselben Teilen seine Details und das Störungsprotokoll: `Netz.qualitaet.bauen(wurzel, tempo)`.
// Die Kennzahlen folgen `netzinfo bericht` (src/messen.rs).
(() => {
  const { el, zeit, gruppe, zeile, status, meldung, leerZustand } = Netz;
  const NS = 'http://www.w3.org/2000/svg';
  const TAKT = 5000; // ms, never faster: every probe rewrites qualitaet.json
  const LUECKE = 120; // s, same as GAP_SECS in src/messen.rs: a longer pause breaks the line
  // Dash patterns differ per target, so colour is not the only difference.
  const STIL = [
    { farbe: 'var(--accent-lesbar)', dash: '' },
    { farbe: 'var(--gruen)', dash: '6 3' },
    { farbe: 'var(--orange)', dash: '1.5 3' },
  ];
  const E = {
    median: 'Der Median ist der mittlere Wert: Die Hälfte der Antworten war schneller, die Hälfte langsamer. Einzelne Ausreißer ändern ihn kaum.',
    p95: 'Das 95. Perzentil sagt: 95 von 100 Antworten waren schneller. Es zeigt, wie schlecht es an schlechten Momenten wird.',
    max: 'Das Maximum ist die langsamste Antwort, die je gemessen wurde.',
    verlust: 'Ein Verlust ist eine Anfrage, die nach 2 Sekunden keine Antwort hatte. Im Heimnetz sollten es fast null Prozent sein.',
    aussetzer: 'Der längste Aussetzer ist die längste Zeit, in der hintereinander jede Anfrage verloren ging.',
    stunde: 'Die schlechteste Stunde hatte den höchsten Verlust, danach die höchste Durchschnittszeit.',
  };

  let alt = null; // state of the last rendered view: { wurzel, an, stop }
  // Zahlen aus dem Kern können fehlen oder kaputt sein (null, NaN): dann steht ein Strich da, nie „NaN“ und nie ein Absturz.
  const fmt = (n, stellen = 1) => (Number.isFinite(n) ? n.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen }) : '–');
  const ms = (v) => (Number.isFinite(v) && v >= 0 ? `${fmt(v)} ms` : '-');
  const dauer = (sek) => (!Number.isFinite(sek) || sek < 0 ? '-' : sek === 0 ? 'keiner' : sek < 60 ? `${sek} s` : `${Math.floor(sek / 60)} min ${sek % 60} s`);
  const uhr = (sek) => (Number.isFinite(sek) ? new Date(sek * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–');
  const sv = (tag, attr = {}, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attr)) if (v !== '') e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };
  // Nice time ticks (full minutes / hours) so the axis never reads 21:57, 21:59 ...
  const zeitTicks = (von, bis) => {
    const schritt = [60, 120, 300, 600, 900, 1800, 3600].find((s) => (bis - von) / s <= 6) ?? 7200;
    const t = [];
    for (let z = Math.ceil(von / schritt) * schritt; z <= bis; z += schritt) t.push(z);
    return t;
  };
  const rund = (v) => [10, 20, 50, 100, 250, 500, 1000, 2500].find((n) => n >= v) ?? Math.ceil(v / 1000) * 1000;
  // Error with a way out: the button repeats the action (or reloads the view).
  const fehlerAus = (e, nochmal) => Netz.fehlerKarte(Netz.text(e), nochmal);
  const frist = (befehl, args, sek) =>
    Netz.frist(Netz.invoke(befehl, args), sek * 1000, `Keine Antwort nach ${sek} Sekunden. Prüfe die Verbindung und versuche es noch mal.`);
  // After a redraw the focus must not fall to the page: give it back to the button if it was there (or in the result) before.
  const halteFokus = (knopf, ort) => {
    const hatte = knopf.matches(':focus') || ort.contains(document.activeElement);
    return () => { if (hatte && knopf.isConnected && (!document.activeElement || document.activeElement === document.body)) knopf.focus(); };
  };
  const anzahl = (n, eins, viele) => (n === 1 ? `1 ${eins}` : `${n} ${viele}`);
  const stunde = (w) => (w ? `${zeit(w.stunde)}, Verlust ${fmt(w.verlust_prozent)} %, Ø ${ms(w.durchschnitt_ms)}` : null); // for the Markdown report

  // Same text as `netzinfo bericht --markdown`, times in local time.
  function markdown(b) {
    const kopf = '| Ziel | Messungen | Verlust | Median | 95. Perzentil | Maximum | Längster Aussetzer |\n|---|---|---|---|---|---|---|\n';
    const zeilen = b.ziele.map((z) => `| ${z.ziel} | ${z.messungen} | ${fmt(z.verlust_prozent)} % | ${ms(z.median_ms)} | ${ms(z.p95_ms)} | ${ms(z.max_ms)} | ${dauer(z.laengster_aussetzer_s)} |\n`).join('');
    const schlecht = b.ziele.map((z) => `- ${z.ziel}: ${stunde(z.schlechteste_stunde) ?? '-'}\n`).join('');
    return `# Netzqualität: ${b.netz}\n\nZeitraum: ${zeit(b.von)} bis ${zeit(b.bis)}\n\nGemessen mit \`netzinfo messen\` (DNS-Anfragen und TCP-Verbindungen, kein Root). Ein Verlust ist eine Anfrage ohne Antwort innerhalb von 2 Sekunden.\n\n${kopf}${zeilen}\n## Schlechteste Stunde je Ziel\n\n${schlecht}`;
  }

  // Chart of the last `std` hours. Lines break at losses and pauses; losses sit on a strip below.
  function kurve(reihen, std, jetzt) {
    const B = 600, H = 284, L = 56, R = 12, T = 12, Y1 = 196, STREIFEN = 16;
    const von = jetzt - std * 3600;
    // Unbrauchbare Werte (NaN, negativ) werden zur Lücke, nie zu „NaN“ im Pfad; ein Punkt ohne Zeit fällt weg.
    const sichtbar = reihen.map((r) => r.punkte.filter((p) => p.zeit >= von && p.zeit <= jetzt + 60)
      .map((p) => (p.ms == null || (Number.isFinite(p.ms) && p.ms >= 0) ? p : { ...p, ms: null })));
    const hoechst = Math.max(0, ...sichtbar.flat().map((p) => p.ms ?? 0));
    const oben = [10, 20, 30, 40, 50, 100, 200, 500, 1000, 2000].find((n) => n >= hoechst) ?? Math.ceil(hoechst / 1000) * 1000;
    const x = (t) => L + ((t - von) / (jetzt - von)) * (B - L - R);
    const y = (v) => Y1 - (v / oben) * (Y1 - T);
    const g = sv('svg', { viewBox: `0 0 ${B} ${H}`, class: 'kurve', role: 'img' });
    const zusammen = reihen.map((r, k) => {
      const p = sichtbar[k];
      const spitze = p.reduce((m, q) => (q.ms != null && (m == null || q.ms > m.ms) ? q : m), null);
      const werte = p.filter((q) => q.ms != null).map((q) => q.ms).sort((a, b) => a - b);
      const v = p.filter((q) => q.verlust).length;
      return `${r.ziel}: ` + (werte.length ? `Median ${ms(werte[Math.floor(werte.length / 2)])}, Spitze ${ms(spitze.ms)} um ${uhr(spitze.zeit)}, ` : 'keine Antwort, ') + (v === 0 ? 'kein Verlust' : anzahl(v, 'Verlust', 'Verluste'));
    });
    g.setAttribute('aria-label', `Antwortzeit der letzten ${std === 1 ? 'Stunde' : `${std} Stunden`}. ${zusammen.join('. ')}.`);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      g.append(sv('line', { x1: L, x2: B - R, y1: y(oben * f), y2: y(oben * f), class: f === 0 ? 'gitter basis' : 'gitter' }),
        sv('text', { x: L - 8, y: y(oben * f) + 4, class: 'achse', 'text-anchor': 'end' }, f === 1 ? `${fmt(oben * f, 0)} ms` : fmt(oben * f, 0)));
    }
    for (const t of zeitTicks(von, jetzt)) {
      g.append(sv('line', { x1: x(t), x2: x(t), y1: T, y2: Y1 + 28 + (reihen.length - 1) * STREIFEN + 8, class: 'gitter senkrecht' }),
        sv('text', { x: x(t), y: H - 8, class: 'achse', 'text-anchor': 'middle' }, uhr(t)));
    }
    // last series first, so the solid blue line lies on top of the dashed ones
    for (let k = reihen.length - 1; k >= 0; k--) {
      const r = reihen[k];
      let d = '', zuletzt = null;
      for (const p of sichtbar[k]) {
        if (p.ms == null) { zuletzt = null; continue; }
        d += `${zuletzt && p.zeit - zuletzt <= LUECKE ? 'L' : 'M'}${x(p.zeit).toFixed(1)} ${y(p.ms).toFixed(1)}`;
        zuletzt = p.zeit;
      }
      if (d) g.append(sv('path', { d, class: 'linie', stroke: STIL[k].farbe, 'stroke-dasharray': STIL[k].dash }));
      const yv = Y1 + 28 + k * STREIFEN;
      for (const p of sichtbar[k]) {
        if (p.verlust) g.append(sv('line', { x1: x(p.zeit), x2: x(p.zeit), y1: yv - 5, y2: yv + 5, class: 'verlust', stroke: STIL[k].farbe }));
      }
    }
    // strip label with one sample per row (colour and dash), so the rows are not told apart by colour alone
    g.append(sv('text', { x: 0, y: Y1 + 16, class: 'achse' }, 'Verluste'));
    reihen.forEach((_, k) => g.append(sv('line', { x1: L - 30, x2: L - 10, y1: Y1 + 28 + k * STREIFEN, y2: Y1 + 28 + k * STREIFEN, stroke: STIL[k].farbe, 'stroke-dasharray': STIL[k].dash, 'stroke-width': 2, 'stroke-linecap': 'round' })));
    return g;
  }

  function legende(namen) {
    return el('ul', { class: 'legende' }, namen.map((n, k) => {
      const l = sv('svg', { viewBox: '0 0 28 8', class: 'muster', 'aria-hidden': 'true' });
      l.append(sv('line', { x1: 1, x2: 27, y1: 4, y2: 4, stroke: STIL[k].farbe, 'stroke-dasharray': STIL[k].dash, 'stroke-width': 2 }));
      return el('li', {}, l, el('span', { text: n }));
    }));
  }

  // One table, one column per target. The chart shows the chosen range, these numbers cover every stored probe.
  function kennzahlen(b) {
    const zeilen = [
      ['Median', E.median, (z) => ms(z.median_ms)],
      ['95. Perzentil', E.p95, (z) => ms(z.p95_ms)],
      ['Maximum', E.max, (z) => ms(z.max_ms)],
      ['Verlust', E.verlust, (z) => [el('span', { text: `${fmt(z.verlust_prozent)} %` }), el('span', { class: 'klein', text: `${z.verloren} von ${z.messungen}` })]],
      ['Längster Aussetzer', E.aussetzer, (z) => dauer(z.laengster_aussetzer_s)],
      ['Schlechteste Stunde', E.stunde, (z) => (z.schlechteste_stunde
        ? [el('span', { text: zeit(z.schlechteste_stunde.stunde) }), el('span', { class: 'klein', text: `Verlust ${fmt(z.schlechteste_stunde.verlust_prozent)} %` }), el('span', { class: 'klein', text: `Ø ${ms(z.schlechteste_stunde.durchschnitt_ms)}` })]
        : '-')],
    ];
    return el('section', { class: 'gruppe', 'aria-labelledby': 'g-kennzahlen' }, el('h3', { id: 'g-kennzahlen', text: 'Kennzahlen aller gespeicherten Messungen' }),
      el('div', { class: 'karte' }, el('table', { class: 'kennzahlen' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'leer' }, el('span', { class: 'nur-vorlesen', text: 'Kennzahl' })), b.ziele.map((z) => el('th', { scope: 'col', text: z.ziel.replace(/ (\d)/g, '\u00a0$1') })))),
        el('tbody', {}, zeilen.map(([name, erkl, wert]) => [
          el('tr', {}, el('th', { scope: 'row', text: name }), b.ziele.map((z) => el('td', {}, wert(z)))),
          el('tr', { class: 'erkl-zeile' }, el('td', { colspan: b.ziele.length + 1, class: 'erklaerung', text: erkl })),
        ]).flat()))),
      el('p', { class: 'fuss', text: `Gespeichert von ${zeit(b.von)} bis ${zeit(b.bis)}. Die Kurve oben zeigt nur den gewählten Zeitraum.` }));
  }

  // „Wo hakt es?“ (issue #31): own block, `netzinfo diagnose` in the app.
  const AMPEL = { ok: 'gruen', schlecht: 'orange', stumm: 'rot', fehlt: 'grau' };
  const WORT = { ok: 'in Ordnung', schlecht: 'auffällig', stumm: 'stumm', fehlt: 'nicht gemessen' };
  const URTEIL = { funk: 'rot', in_ordnung: 'gruen', weit_weg: 'orange', wlan_oder_router: 'rot', anbieter: 'rot', kein_internet: 'rot' };
  // Funk (issue #37): bottom row; no Wi-Fi = row says so, never an error.
  const FUNK = { gut: ['gruen', 'in Ordnung'], schwach: ['orange', 'schwach'], nicht_geprueft: ['grau', 'nicht geprüft'], kabel: ['grau', 'kein WLAN (Kabel), entfällt'] };
  function funkZeile(f) {
    if (!f) return null;
    const [ampel, wort] = FUNK[f.status] || FUNK.nicht_geprueft;
    const zahlen = [f.rssi_dbm != null && `Signal ${f.rssi_dbm} dBm`, f.snr_db != null && `Abstand zum Rauschen ${f.snr_db} dB`].filter(Boolean).join(', ');
    return el('li', {}, el('span', { class: `punkt ${ampel}` }), el('span', { class: 'diagnose-name', text: 'Funk' }),
      el('span', { class: 'diagnose-wert', text: zahlen ? `${zahlen} · ${wort}` : wort }));
  }
  function diagnoseKarte(tempo) {
    const ort = el('div', { 'aria-live': 'polite' });
    const knopf = el('button', { class: tempo ? 'knopf' : 'knopf haupt', type: 'button', text: 'Jetzt prüfen', 'aria-label': 'Wo hakt es? Jetzt prüfen' }); // in Tempo gehört die Hauptaktion „Tempo messen“
    knopf.addEventListener('click', async () => {
      const zurueck = halteFokus(knopf, ort);
      knopf.disabled = true;
      ort.replaceChildren(status('grau', 'Misst etwa 5 Sekunden an vier Stellen'));
      try {
        const r = await frist('diagnose', undefined, 30);
        ort.replaceChildren(
          el('ul', { class: 'diagnose-ziele' }, funkZeile(r.funk), r.ziele.map((z) => el('li', {},
            el('span', { class: `punkt ${AMPEL[z.status]}` }),
            el('span', { class: 'diagnose-name', text: z.name }),
            el('span', { class: 'diagnose-wert', text: z.status === 'fehlt' ? 'nicht gemessen'
              : `${z.beantwortet === 0 ? 'keine Antwort' : `${ms(z.median_ms)}, Verlust ${fmt(z.verlust_prozent)} %`} · ${WORT[z.status]}` })))),
          el('p', { class: 'diagnose-urteil' }, el('span', { class: `punkt ${URTEIL[r.urteil]}` }), el('strong', { text: r.satz })),
          el('ul', { class: 'diagnose-gruende' }, r.begruendung.map((t) => el('li', { text: t }))),
          r.verlauf ? el('p', { class: 'diagnose-verlauf', text: r.verlauf }) : '',
          el('p', { class: 'diagnose-hinweis', text: `${r.mit_basis ? 'Verglichen mit den gespeicherten Werten dieses Netzes.' : 'Für dieses Netz gibt es noch keine gespeicherten Werte, es gelten feste Grenzen.'} Das Urteil ist eine Vermutung, kein Beweis.` }));
      } catch (e) {
        ort.replaceChildren(fehlerAus(e, () => knopf.click()));
      }
      knopf.disabled = false;
      zurueck();
    });
    return el('section', { class: 'gruppe', 'aria-labelledby': 'g-hakt' }, el('h3', { id: 'g-hakt', text: 'Wo hakt es?' }),
      el('div', { class: 'karte diagnose' }, el('p', { class: 'fuss', text: 'Misst etwa 5 Sekunden Router, Anbieter und Internet und prüft das WLAN-Signal. Das Ergebnis sagt, wo es wahrscheinlich hakt.' }), knopf, ort));
  }

  // ---- Karte „Weg zum Ziel“ (`netzinfo pfad`, src/pfad.rs) ----
  const EW = {
    karte: 'Jedes Paket hat eine Lebensdauer (TTL), die an jedem Router um eins sinkt. Ich schicke Pakete mit TTL 1, 2, 3 …: Der Router, bei dem sie ablaufen, meldet sich. So sehe ich Station für Station, wo die Zeit vergeht.',
    balken: 'Der Balken zeigt den Median der Antwortzeit an dieser Station, relativ zur langsamsten.',
    verlust: 'Verlust nur an einer Station mitten im Weg ist meist harmlos: Viele Router beantworten diese Anfragen absichtlich nur selten. Verlust am Ende des Wegs (rot) ist ein echtes Zeichen, dass Pakete das Ziel nicht erreichen.',
  };
  // Running measurement and last answer live outside the view: ⌘R or a tab change must neither
  // start a second run nor lose the answer. The backend cannot be cancelled, a late answer is only stored.
  let wegLaeuft = null; // { ziel, p: Promise }
  let wegLetzt = null; // { erg } | { fehler }

  function hopZeile(h, max, ende) {
    const adr = h.adressen.length ? (h.name ?? h.adressen[0]) + (h.adressen.length > 1 ? ` (+${h.adressen.length - 1})` : '') : 'keine Antwort';
    const rot = ende && h.verlust_prozent > 0;
    const breite = h.median_ms != null && max > 0 ? Math.max(2, (h.median_ms / max) * 100) : 0;
    return el('li', { class: `hop${rot ? ' ende-verlust' : ''}${h.adressen.length ? '' : ' stumm'}` },
      el('span', { class: 'ttl' }, el('span', { class: 'nur-vorlesen', text: 'Station ' }), String(h.ttl)),
      el('span', { class: 'adresse', title: adr, text: adr + (h.ziel ? ' (Ziel)' : '') }),
      el('span', { class: 'balken', 'aria-hidden': 'true' }, el('span', { style: `width:${breite}%` })),
      el('span', { class: 'zahl', text: ms(h.median_ms) }),
      el('span', { class: `zahl verlust${h.verlust_prozent > 0 ? ' hat' : ''}`, text: `${fmt(h.verlust_prozent, 0)} % Verlust` }));
  }

  function wegKarte() {
    const eingabe = el('input', { type: 'text', class: 'ziel-feld', value: wegLaeuft?.ziel ?? '1.1.1.1', 'aria-label': 'Ziel für den Weg', placeholder: '1.1.1.1', autocapitalize: 'off', spellcheck: 'false' });
    const router = el('button', { class: 'knopf', type: 'button', text: 'Router eintragen', title: 'Trägt den Router dieses Netzes als Ziel ein', onclick: async () => {
      try { const r = (await Netz.invoke('dieses_netz')).info.router; if (r) eingabe.value = r; } catch { /* the field keeps its value */ }
    } });
    const knopf = el('button', { class: 'knopf', type: 'button', text: 'Pfad messen', onclick: messe });
    eingabe.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') messe(); });
    const lauf = el('p', { class: 'fuss fortschritt', 'aria-live': 'polite' });
    const ort = el('div', { 'aria-live': 'polite' });
    const k = el('section', { class: 'gruppe weg-karte', 'aria-labelledby': 'g-weg' },
      el('h3', { id: 'g-weg', text: 'Weg zum Ziel' }),
      el('div', { class: 'karte weg' },
        el('div', { class: 'werkzeuge' }, eingabe, router, knopf), lauf, ort,
        el('p', { class: 'erklaerung', text: EW.karte })));

    function zeichneWeg() {
      const laeuft = wegLaeuft != null;
      knopf.disabled = laeuft;
      eingabe.disabled = router.disabled = laeuft;
      lauf.replaceChildren(...(laeuft ? [el('progress', { 'aria-label': 'Messung läuft' }), ` Messe den Weg zu ${wegLaeuft.ziel} … das dauert bis zu 30 Sekunden.`] : []));
      if (laeuft) return ort.replaceChildren();
      if (!wegLetzt) return ort.replaceChildren(); // the explanation below already says what the button does
      if (wegLetzt.fehler) return ort.replaceChildren(Netz.fehlerKarte(wegLetzt.fehler, messe));
      const e = wegLetzt.erg;
      const max = Math.max(0, ...e.hops.map((h) => h.median_ms ?? 0));
      ort.replaceChildren(...[
        status(e.erreicht ? 'gruen' : 'orange', `${e.ziel} (${e.ziel_ip}) · ${e.hops.length} Stationen · ${zeit(e.zeitpunkt)}`),
        !e.erreicht && meldung('Das Ziel hat nicht geantwortet. Der Weg endet dort, wo die Antworten aufhören. Das Ziel kann Anfragen auch absichtlich ignorieren.', 'orange'),
        el('ol', { class: 'hops', 'aria-label': `Weg zum Ziel, ${anzahl(e.hops.length, 'Station', 'Stationen')}` }, e.hops.map((h, i) => hopZeile(h, max, i === e.hops.length - 1))),
        el('p', { class: 'erklaerung', text: EW.balken }),
        el('p', { class: 'erklaerung', text: EW.verlust })].filter(Boolean));
    }

    async function messe() {
      if (wegLaeuft) return;
      const zurueck = halteFokus(knopf, ort);
      const ziel = eingabe.value.trim() || '1.1.1.1';
      const p = frist('pfad_messen', { ziel }, 90).then((erg) => ({ erg }), (f) => ({ fehler: Netz.text(f) }));
      wegLaeuft = { ziel, p };
      zeichneWeg();
      wegLetzt = await p;
      wegLaeuft = null;
      if (k.isConnected) { zeichneWeg(); zurueck(); }
    }

    zeichneWeg();
    // Re-render during a run: wait for the same run, then draw.
    if (wegLaeuft) wegLaeuft.p.then(() => k.isConnected && zeichneWeg());
    return k;
  }

  // ---- Karte „WLAN-Verlauf“ (`netzinfo wlan --verlauf`, src/wlanverlauf.rs, issue #36) ----
  const EV = {
    marken: 'Roaming heißt: Der Mac hat den Zugangspunkt gewechselt, ohne dass die Verbindung abriss. Das ist normal, wenn man sich bewegt, und ein Problem, wenn man am Schreibtisch sitzt.',
    vergleich: 'Verglichen wird der Median dieses Besuchs mit dem Median der Mediane früherer Besuche in diesem Netz.',
    ohne_hash: 'Ohne Standortfreigabe sieht Netzinfo keinen Wechsel des Zugangspunkts, Abbrüche schon. Die Freigabe gibst du in „Dieses Netz“.',
  };
  const ARTEN = { Roaming: ['Zugangspunkt gewechselt', 'currentColor', 'M0 -5L4 0L0 5L-4 0Z'], Getrennt: ['Verbindung weg', 'var(--rot)', 'M-4 -4L4 4M4 -4L-4 4'], Verbunden: ['wieder verbunden', 'var(--gruen)', 'M-4 0L-1 4L5 -4'], Bandwechsel: ['Band gewechselt', 'var(--orange)', 'M-4 4L0 -5L4 4Z'] };

  // Signal (solid) and rate (dashed) of the ring buffer; events as marks on a strip below.
  function wlanKurve(a) {
    const B = 600, H = 270, L = 72, R = 56, T = 28, Y1= 180;
    const p = a.proben;
    const von = p[0].zeit, bis = Math.max(p[p.length - 1].zeit, von + 60);
    const x = (t) => L + ((t - von) / (bis - von)) * (B - L - R);
    const ySig = (v) => Y1 - ((Math.min(-30, Math.max(-90, v)) + 90) / 60) * (Y1 - T);
    const rmax = rund(Math.max(100, ...p.map((q) => q.rate ?? 0)));
    const yRate = (v) => Y1 - (v / rmax) * (Y1 - T);
    const g = sv('svg', { viewBox: `0 0 ${B} ${H}`, class: 'wlan-kurve', role: 'img' });
    const med = (w) => { const l = p.map(w).filter((v) => v != null).sort((m, n) => m - n); return l.length ? l[Math.floor(l.length / 2)] : null; };
    const sig = med((q) => q.rssi), rate = med((q) => q.rate);
    const ereig = a.ereignisse.filter((q) => q.zeit >= von);
    g.setAttribute('aria-label', `Signal und Senderate der letzten ${Math.max(1, Math.round((bis - von) / 60))} Minuten`
      + `${sig != null ? `: Signal im Median ${sig} dBm` : ''}${rate != null ? `, Senderate im Median ${fmt(rate, 0)} Mbit/s` : ''}. `
      + (ereig.length ? `${anzahl(ereig.length, 'Ereignis', 'Ereignisse')}: ${ereig.slice(0, 4).map((e) => `${ARTEN[e.art][0]} um ${uhr(e.zeit)}`).join(', ')}${ereig.length > 4 ? ' und weitere' : ''}.` : 'Keine Ereignisse.'));
    for (const f of [0, 0.5, 1]) {
      const yy = Y1 - f * (Y1 - T);
      g.append(sv('line', { x1: L, x2: B - R, y1: yy, y2: yy, class: f === 0 ? 'gitter basis' : 'gitter' }),
        sv('text', { x: L - 8, y: yy + 4, class: 'achse signal', 'text-anchor': 'end' }, `${-90 + f * 60} dBm`),
        sv('text', { x: B - R + 8, y: yy + 4, class: 'achse rate' }, `${fmt(rmax * f, 0)}`));
    }
    g.append(sv('text', { x: L - 8, y: T - 12, class: 'achse signal', 'text-anchor': 'end' }, 'Signal'),
      sv('text', { x: B - R + 8, y: T - 12, class: 'achse rate' }, 'Mbit/s'));
    for (const t of zeitTicks(von, bis)) {
      g.append(sv('line', { x1: x(t), x2: x(t), y1: T, y2: Y1, class: 'gitter senkrecht' }),
        sv('text', { x: x(t), y: H - 8, class: 'achse', 'text-anchor': 'middle' }, uhr(t)));
    }
    const linie = (wert, y, attr) => {
      let d = '', vor = null;
      for (const q of p) {
        const w = q.verbunden ? wert(q) : null;
        if (w == null) { vor = null; continue; }
        d += `${vor != null && q.zeit - vor <= 30 ? 'L' : 'M'}${x(q.zeit).toFixed(1)} ${y(w).toFixed(1)}`;
        vor = q.zeit;
      }
      if (d) g.append(sv('path', { d, class: 'linie', ...attr }));
    };
    linie((q) => q.rate, yRate, { stroke: 'var(--gruen)', 'stroke-dasharray': '6 3' });
    linie((q) => q.rssi, ySig, { stroke: 'var(--accent-lesbar)' });
    g.append(sv('text', { x: L - 8, y: Y1 + 28, class: 'achse', 'text-anchor': 'end' }, 'Ereignisse'));
    for (const e of a.ereignisse.filter((q) => q.zeit >= von)) {
      const [name, farbe, form] = ARTEN[e.art];
      const m = sv('g', { transform: `translate(${x(e.zeit).toFixed(1)} ${Y1 + 28})`, class: 'marke' });
      m.append(sv('title', {}, `${uhr(e.zeit)}: ${name}`), sv('path', { d: form, stroke: farbe, fill: e.art === 'Bandwechsel' ? farbe : 'none' }));
      g.append(sv('line', { x1: x(e.zeit), x2: x(e.zeit), y1: T, y2: Y1 + 18, class: 'marke-linie', stroke: farbe }), m);
    }
    return g;
  }

  function wlanKarte() {
    const ort = el('div'); // no live region: redrawn every 5 s
    const k = el('section', { class: 'gruppe wlan-karte', 'aria-labelledby': 'g-wlan' }, el('h3', { id: 'g-wlan', text: 'WLAN-Verlauf' }), el('div', { class: 'karte' }, ort));
    let timer = null;
    ort.replaceChildren(status('grau', 'Liest das WLAN …'));

    function zeichne(a) {
      if (a.verbunden && !a.proben?.length) return ort.replaceChildren(status('grau', 'Verbunden, aber noch keine Messwerte. Gleich geht es weiter.'));
      if (!a.verbunden && a.proben.every((q) => !q.verbunden)) {
        return ort.replaceChildren(leerZustand(Netz.icons.qualitaet, 'Kein WLAN. Am Kabel oder bei ausgeschaltetem WLAN gibt es keinen Funkverlauf zu zeigen.', 'kein-wlan'));
      }
      const b = a.besuch;
      const arten = [...new Set(a.ereignisse.map((e) => e.art))];
      ort.replaceChildren(...[
        status(a.verbunden ? 'gruen' : 'orange', a.verbunden ? `Verbunden · tastet alle 5 s ab${a.gemerkt ? ' · Besuch wird gespeichert' : ' · Netz nicht gemerkt, nichts wird gespeichert'}` : 'Gerade keine Funkverbindung'),
        wlanKurve(a),
        el('ul', { class: 'legende' },
          ...['Signal', 'Senderate'].map((n, i) => {
            const l = sv('svg', { viewBox: '0 0 28 8', class: 'muster', 'aria-hidden': 'true' });
            l.append(sv('line', { x1: 1, x2: 27, y1: 4, y2: 4, stroke: STIL[i].farbe, 'stroke-dasharray': STIL[i].dash, 'stroke-width': 2 }));
            return el('li', {}, l, el('span', { text: n }));
          }),
          ...arten.map((n) => {
            const l = sv('svg', { viewBox: '-7 -7 14 14', class: 'zeichen', 'aria-hidden': 'true' });
            l.append(sv('path', { d: ARTEN[n][2], stroke: ARTEN[n][1], fill: n === 'Bandwechsel' ? ARTEN[n][1] : 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
            return el('li', {}, l, el('span', { text: ARTEN[n][0] }));
          })),
        b && gruppe('Dieser Besuch', [
          zeile('Signal', b.signal ? `Median ${b.signal.median} dBm (${b.signal.min} bis ${b.signal.max})` : '-'),
          zeile('Senderate', b.rate ? `Median ${fmt(b.rate.median, 0)} Mbit/s (${fmt(b.rate.min, 0)} bis ${fmt(b.rate.max, 0)})` : '-'),
          zeile('Wechsel des Zugangspunkts', a.roaming_erkennbar ? String(b.wechsel) : 'nicht erkennbar', EV.marken),
          zeile('Abbrüche', String(b.abbrueche)),
        ]),
        a.vergleich && el('p', { class: 'wlan-vergleich', text: a.vergleich, title: EV.vergleich }),
        !a.roaming_erkennbar && meldung(EV.ohne_hash, 'orange'),
        a.hinweis && meldung(a.hinweis),
      ].filter(Boolean));
    }

    async function tick() {
      if (!k.isConnected) return; // view was left: the loop ends, nothing else to clean up
      if (document.hidden) return; // resumed by `sicht`
      try {
        const a = await frist('wlan_verlauf_abtasten', undefined, 15);
        delete ort.dataset.fehler;
        zeichne(a);
      } catch (e) {
        // the same error is drawn once: a new alert every 5 s would be read out again and again, and would take the focus from the button
        const t = Netz.text(e);
        if (ort.dataset.fehler !== t) { ort.dataset.fehler = t; ort.replaceChildren(fehlerAus(e, () => { clearTimeout(timer); tick(); })); }
      }
      if (k.isConnected) timer = setTimeout(tick, TAKT);
    }
    const sicht = () => {
      if (!k.isConnected) return document.removeEventListener('visibilitychange', sicht);
      clearTimeout(timer);
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', sicht);
    setTimeout(tick, 100); // the caller attaches the view only after render() returned
    return k;
  }

  // ---- Karte „Paketgröße“ (`netzinfo mtu`, src/mtu.rs, issue #47) ----
  const EM = {
    karte: 'Jedes Netzgerät gibt nur Pakete bis zu einer Obergrenze weiter (MTU). Ich schicke Pings mit dem Zeichen „Nicht zerlegen“ und halbiere den Bereich von 576 bis 1500 Byte, bis die Grenze feststeht. Normal sind 1500 Byte; weniger heißt, dass etwas auf dem Weg Platz für eigene Kopfdaten braucht (DSL, Tunnel, VPN, Mobilfunk). Das ist eine Erklärung, kein Beweis.',
  };
  const MTU_AMPEL = { normal: 'gruen', pppoe: 'gruen', tunnel: 'gruen', klein: 'orange', ungewoehnlich: 'orange' };
  let mtuLaeuft = null; // { ziel, p }, outside the view like the path card: ⌘R must not start a second run
  let mtuLetzt = null; // { erg } | { fehler }

  function mtuKarte() {
    const eingabe = el('input', { type: 'text', class: 'ziel-feld', value: mtuLaeuft?.ziel ?? '1.1.1.1', 'aria-label': 'Ziel für die Paketgröße', placeholder: '1.1.1.1', autocapitalize: 'off', spellcheck: 'false' });
    const knopf = el('button', { class: 'knopf', type: 'button', text: 'Paketgröße messen', onclick: messe });
    eingabe.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') messe(); });
    const lauf = el('p', { class: 'fuss fortschritt', 'aria-live': 'polite' });
    const ort = el('div', { 'aria-live': 'polite' });
    const k = el('section', { class: 'gruppe mtu-karte', 'aria-labelledby': 'g-mtu' },
      el('h3', { id: 'g-mtu', text: 'Paketgröße' }),
      el('div', { class: 'karte mtu' }, el('div', { class: 'werkzeuge' }, eingabe, knopf), lauf, ort,
        el('p', { class: 'erklaerung', text: EM.karte })));

    function zeichneMtu() {
      const laeuft = mtuLaeuft != null;
      knopf.disabled = eingabe.disabled = laeuft;
      lauf.replaceChildren(...(laeuft ? [el('progress', { 'aria-label': 'Messung läuft' }), ` Messe die Paketgröße zu ${mtuLaeuft.ziel} … das dauert bis zu 30 Sekunden.`] : []));
      if (laeuft) return ort.replaceChildren();
      if (!mtuLetzt) return ort.replaceChildren();
      if (mtuLetzt.fehler) return ort.replaceChildren(Netz.fehlerKarte(mtuLetzt.fehler, messe));
      const e = mtuLetzt.erg;
      ort.replaceChildren(...[
        status(e.quelle === 'stille' ? 'orange' : MTU_AMPEL[e.einstufung], `${e.ziel} (${e.ziel_ip}) · ${e.pfad_mtu} Byte · ${zeit(e.zeitpunkt)}`),
        gruppe('Ergebnis', [
          zeile('Größtes Paket ohne Zerlegen', `${e.pfad_mtu} Byte`),
          e.lokale_mtu != null && zeile('Grenze deiner Schnittstelle', `${e.lokale_mtu} Byte`),
          e.netz && zeile('Gespeichert für', e.netz),
          e.vorher != null && zeile('Letzter Besuch', `${e.vorher} Byte`),
        ].filter(Boolean)),
        el('p', { class: 'mtu-satz', text: e.satz }),
        e.vorher != null && e.vorher !== e.pfad_mtu && meldung(`Beim letzten Besuch waren es ${e.vorher} Byte, jetzt ${e.pfad_mtu} Byte.`, 'orange'),
        !e.netz && meldung('Dieses Netz ist nicht gemerkt, es wird nichts gespeichert.', 'orange'),
      ].filter(Boolean));
    }

    async function messe() {
      if (mtuLaeuft) return;
      const zurueck = halteFokus(knopf, ort);
      const ziel = eingabe.value.trim() || '1.1.1.1';
      const p = frist('mtu_messen', { ziel }, 90).then((erg) => ({ erg }), (f) => ({ fehler: Netz.text(f) }));
      mtuLaeuft = { ziel, p };
      zeichneMtu();
      mtuLetzt = await p;
      mtuLaeuft = null;
      if (k.isConnected) { zeichneMtu(); zurueck(); }
    }

    zeichneMtu();
    if (mtuLaeuft) mtuLaeuft.p.then(() => k.isConnected && zeichneMtu());
    return k;
  }

  // ---- Karte „DNS-Tempo“ (`netzinfo dns --tempo`, src/dnstempo.rs, issue #50) ----
  function dnsTempoKarte() {
    const ort = el('div', { 'aria-live': 'polite' });
    const knopf = el('button', { class: 'knopf', type: 'button', text: 'DNS vergleichen' });
    knopf.addEventListener('click', async () => {
      const zurueck = halteFokus(knopf, ort);
      knopf.disabled = true;
      ort.replaceChildren(status('grau', 'Misst vier Server nacheinander, etwa 20 Sekunden'));
      try {
        const r = await frist('dns_tempo', undefined, 90);
        const hoechst = Math.max(...r.zeilen.flatMap((z) => [z.bekannt_p95, z.unbekannt_p95]).filter((v) => v != null), 1);
        const balken = (v) => { const b = el('span', { class: 'balken' }, el('span')); b.firstChild.style.width = `${v == null ? 0 : Math.max(2, (v / hoechst) * 100)}%`; return b; };
        ort.replaceChildren(
          el('ul', { class: 'dns-tempo' }, r.zeilen.map((z, i) => el('li', { class: i === r.empfehlung ? 'rat' : '' },
            el('span', { class: 'name', text: z.name }),
            el('span', { class: 'werte' }, balken(z.bekannt_median), el('span', { class: 'zahl', text: `bekannt ${ms(z.bekannt_median)}` })),
            el('span', { class: 'werte' }, balken(z.unbekannt_median), el('span', { class: 'zahl', text: `neu ${ms(z.unbekannt_median)}` })),
            el('span', { class: 'zahl', text: z.fehlerrate == null ? 'Fehlerrate unbekannt' : `${Math.round(z.fehlerrate * 100)} % Fehler` })))),
          status('gruen', r.satz),
          el('p', { class: 'fuss', text: r.datenschutz }),
          el('p', { class: 'erklaerung', text: r.erklaerung }));
      } catch (e) {
        ort.replaceChildren(fehlerAus(e, () => knopf.click()));
      }
      knopf.disabled = false;
      zurueck();
    });
    return el('section', { class: 'gruppe dns-tempo-karte', 'aria-labelledby': 'g-dns-tempo' }, el('h3', { id: 'g-dns-tempo', text: 'DNS-Tempo' }),
      el('div', { class: 'karte' }, el('p', { class: 'fuss', text: 'Fragt je Server höchstens 60 Namen ab, nacheinander. Balken: Median, bekannte Namen und neue.' }), knopf, ort));
  }

  // ---- Karte „IPv6“ (`netzinfo ipv6`, src/ipv6.rs) ----
  const V6 = {
    kein_ipv6: ['grau', 'kein IPv6'], gleich: ['gruen', 'IPv6 nutzbar und gleich schnell'], langsamer: ['orange', 'IPv6 nutzbar, aber langsamer'],
    kaputt: ['rot', 'IPv6 kaputt'], unsicher: ['grau', 'unsicher'],
  };
  function ipv6Spalte(p) {
    if (!p.aufgeloest) return 'keine Adresse';
    return p.median_ms == null ? `scheitert (${p.fehler} von ${p.versuche})` : `${ms(p.median_ms)}${p.fehler ? `, ${p.fehler} von ${p.versuche} gescheitert` : ''}`;
  }
  function ipv6Karte() {
    const ort = el('div', { 'aria-live': 'polite' });
    const knopf = el('button', { class: 'knopf', type: 'button', text: 'IPv6 messen' });
    knopf.addEventListener('click', async () => {
      const zurueck = halteFokus(knopf, ort);
      knopf.disabled = true;
      ort.replaceChildren(status('grau', 'Misst etwa 5 Sekunden an fünf Diensten'));
      try {
        const r = await frist('ipv6_messen', undefined, 30);
        const [ampel, wort] = V6[r.urteil];
        ort.replaceChildren(
          r.ziele.length ? el('table', { class: 'ipv6-tabelle' },
            el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Dienst' }), el('th', { scope: 'col', text: 'IPv4' }), el('th', { scope: 'col', text: 'IPv6' }))),
            el('tbody', {}, r.ziele.map((z) => el('tr', {}, el('th', { scope: 'row', text: z.name }), el('td', { text: ipv6Spalte(z.v4) }), el('td', { text: ipv6Spalte(z.v6) }))))) : '',
          el('p', { class: 'diagnose-urteil' }, el('span', { class: `punkt ${ampel}` }), el('strong', { text: wort })),
          el('p', { class: 'ipv6-satz', text: r.satz }));
      } catch (e) {
        ort.replaceChildren(fehlerAus(e, () => knopf.click()));
      }
      knopf.disabled = false;
      zurueck();
    });
    return el('section', { class: 'gruppe', 'aria-labelledby': 'g-ipv6' }, el('h3', { id: 'g-ipv6', text: 'IPv6' }), el('div', { class: 'karte ipv6-karte' }, knopf, ort));
  }

  // ---- Zeile „Uhrzeit“ (`netzinfo zeit`, src/zeit.rs, issue #69) ----
  function zeitKarte() {
    const ort = el('div', { 'aria-live': 'polite' });
    const k = el('section', { class: 'zeit-karte' }, ort);
    const sek = (v) => `${v > 0 ? '+' : ''}${Math.abs(v) < 10000 ? `${v} ms` : `${fmt(v / 1000)} s`}`;
    ort.replaceChildren(gruppe('Uhrzeit', [zeile('Uhr', 'wird geprüft …')]));
    frist('zeit_pruefen', undefined, 30).then((e) => {
      ort.replaceChildren(gruppe('Uhrzeit', [
        zeile('Uhr', e.klasse ? { Harmlos: 'stimmt', Auffaellig: 'weicht ab', Alarm: 'Alarm' }[e.klasse] : 'nicht geprüft', 'Abweichung zur Uhr dieses Macs, gemessen per NTP und HTTPS-Date. Ich stelle die Uhr nie.'),
        ...e.befunde.map((b) => zeile(b.quelle, b.versatz_ms == null ? 'keine Antwort' : sek(b.versatz_ms))),
      ], e.satz));
    }).catch((f) => ort.replaceChildren(fehlerAus(f))); // auch ein Fehler beim Zeichnen: sonst bliebe „wird geprüft …“ stehen
    return k;
  }

  // ---- Karte „Was darf raus?“ (`netzinfo ports --raus`, src/egress.rs, issue #54): misst nur auf Klick, nur gegen den eigenen Testserver ----
  function egressKarte() {
    const ort = el('div', { 'aria-live': 'polite' });
    const feld = el('input', { type: 'text', class: 'ziel-feld', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Testserver, leer = gespeicherter', 'aria-label': 'Testserver' });
    const knopf = el('button', { class: 'knopf', type: 'button', text: 'Ports prüfen' });
    const WORT = { offen: 'offen', abgelehnt: 'abgelehnt', verschluckt: 'verschluckt', fehler: 'Fehler' };
    feld.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') knopf.click(); });
    knopf.addEventListener('click', async () => {
      if (knopf.disabled) return;
      const zurueck = halteFokus(knopf, ort);
      knopf.disabled = true;
      ort.replaceChildren(status('grau', 'Prüft 16 Ports, das dauert bis zu 15 Sekunden'));
      try {
        const a = await frist('egress_pruefen', { ziel: feld.value.trim() || null }, 60);
        ort.replaceChildren(gruppe(`Ausgehende Ports zu ${a.ziel}`,
          a.ports.map((p) => zeile(`${p.port} ${p.name}`, p.status === 'offen' || p.status === 'abgelehnt' ? `${WORT[p.status]} (${p.ms} ms)` : `${WORT[p.status]} (keine Antwort)`, p.satz)), a.hinweise.join(' ')));
      } catch (e) {
        ort.replaceChildren(fehlerAus(e, () => knopf.click()));
      }
      knopf.disabled = false;
      zurueck();
    });
    return el('section', { class: 'gruppe egress-karte', 'aria-labelledby': 'g-egress' }, el('h3', { id: 'g-egress', text: 'Was darf raus?' }),
      el('div', { class: 'karte' }, el('div', { class: 'egress-werkzeuge' }, feld, knopf), ort));
  }

  // ---- Karte „Funkumfeld“ (`netzinfo wlan --umfeld`, src/kanal.rs): scannt nur auf Klick, speichert nichts ----
  const BAENDER = ['2,4 GHz', '5 GHz', '6 GHz'];
  // One sentence per channel: the bars are no list for VoiceOver, so the whole row is one picture with this text.
  function umfeldText(a, band, kanal, n, ziel) {
    const stoert = a.belegung.find((l) => l.band === band && l.kanal === kanal);
    const du = a.aktuell?.band === band && a.aktuell.kanal === kanal;
    const rat = ziel?.band === band && ziel.kanal === kanal;
    return `Kanal ${kanal}${du ? ' (dein Kanal)' : rat ? ' (empfohlen)' : ''}: ${anzahl(n, 'Netz sendet', 'Netze senden')} hier${stoert ? `, mit Nachbarkanälen ${stoert.netze} Netze, zusammen ${Math.round(stoert.dbm)} dBm` : ''}`;
  }
  function umfeldBalken(a) {
    if (a.belegung.length === 0) return meldung('Der Scan hat kein Netz gehört. Ohne Standortfreigabe liefert macOS manchmal nichts; erteile sie unter „Dieses Netz“.', 'orange');
    const eigene = (band, kanal) => a.beobachtungen.filter((b) => b.band === band && b.kanal === kanal).length;
    const hoechst = Math.max(1, ...a.beobachtungen.map((b) => eigene(b.band, b.kanal)));
    const ziel = a.empfehlung.ziel;
    return el('div', {},
      el('p', { class: 'umfeld-summe', text: `${a.beobachtungen.length} Netze in Reichweite${a.land ? `, Regelgebiet ${a.land}` : ''}` }),
      BAENDER.map((band) => {
        const kanaele = [...new Set([...a.beobachtungen, a.aktuell, ziel].filter((k) => k?.band === band).map((k) => k.kanal))].sort((x, y) => x - y);
        return kanaele.length > 0 && el('div', { class: 'umfeld-band' }, el('h4', { text: band }),
          el('ul', { class: 'umfeld-balken', role: 'img', 'aria-label': `${band}: ${kanaele.map((kanal) => umfeldText(a, band, kanal, eigene(band, kanal), ziel)).join('; ')}` }, kanaele.map((kanal) => {
            const n = eigene(band, kanal);
            const du = a.aktuell?.band === band && a.aktuell.kanal === kanal;
            const rat = ziel?.band === band && ziel.kanal === kanal;
            const saeule = el('span', { class: 'saeule' });
            saeule.style.setProperty('--h', `${Math.round((n / hoechst) * 80)}px`);
            return el('li', { class: du ? 'jetzt' : rat ? 'rat' : '', title: umfeldText(a, band, kanal, n, ziel) },
              du || rat ? el('span', { class: 'tag', text: du ? 'du' : 'Rat' }) : '', el('span', { class: 'zahl', text: String(n) }), saeule, el('span', { class: 'kanal', text: String(kanal) }));
          })));
      }),
      el('p', { class: 'umfeld-legende', text: 'Zahl = Netze auf genau diesem Kanal. Der Rat zählt im 2,4 GHz Band die Nachbarkanäle mit, weil sie sich überlappen. „du“ (blau) ist dein Kanal, „Rat“ (grün) der empfohlene.' }),
      el('p', { class: 'umfeld-rat', text: a.empfehlung.text }));
  }

  function umfeldKarte() {
    const ort = el('div', { 'aria-live': 'polite' });
    const knopf = el('button', { class: 'knopf', type: 'button', text: 'Umgebung ansehen' });
    knopf.addEventListener('click', async () => {
      const zurueck = halteFokus(knopf, ort);
      knopf.disabled = true;
      ort.replaceChildren(status('grau', 'Scannt etwa 5 Sekunden, die Verbindung kann kurz haken'));
      try {
        ort.replaceChildren(umfeldBalken(await frist('wlan_umfeld', undefined, 30)));
      } catch (e) {
        ort.replaceChildren(fehlerAus(e, () => knopf.click()));
      }
      knopf.disabled = false;
      zurueck();
    });
    return el('section', { class: 'gruppe umfeld-karte', 'aria-labelledby': 'g-umfeld' }, el('h3', { id: 'g-umfeld', text: 'Funkumfeld' }),
      el('div', { class: 'karte' }, el('p', { class: 'umfeld-hinweis', text: 'Zählt Netze je Kanal, ohne Namen. Von den Nachbarn wird nichts gespeichert. Der Scan läuft nur auf Klick.' }), knopf, ort));
  }

  // ---- Karte „Unter Last“ (`netzinfo last`, src/last.rs): misst nur auf Klick, belastet die Leitung ----
  const mbit = (b) => (b == null ? '-' : `${fmt(b / 1e6, 0)} Mbit/s`);
  const einstufung = (r) => (r >= 800 ? 'sehr reaktionsfähig' : r >= 200 ? 'gut' : r >= 100 ? 'mäßig' : 'schlecht');
  function lastZahlen(e, tempo) {
    const rpm = e.rpm;
    return [
      tempo ? zeile('Upload', mbit(e.up_bps)) : zeile('Download / Upload', `${mbit(e.down_bps)} / ${mbit(e.up_bps)}`),
      zeile('Antwortzeit in Ruhe', ms(e.ruhe_ms), 'Wie lange eine kleine Anfrage braucht, wenn sonst nichts läuft.'),
      zeile('Antwortzeit unter Last', `${ms(e.last_down_ms)} (Download) / ${ms(e.last_up_ms)} (Upload)`, 'Dieselbe Anfrage, während die Leitung voll ausgelastet ist. Steigt sie stark, staut der Router Pakete (Bufferbloat) und Anrufe ruckeln.'),
      zeile('Antworten pro Minute', rpm == null ? 'nicht gemeldet' : `${fmt(rpm, 0)}, ${einstufung(rpm)}`, 'Je mehr, desto besser. Ab 800 sehr reaktionsfähig, 200 bis 799 gut, 100 bis 199 mäßig, darunter schlecht.'),
    ];
  }
  const lastVerlauf = (v) => (v.length === 0 ? [] : [
    el('h4', { text: 'Verlauf (neueste zuerst)' }),
    el('ul', { class: 'last-verlauf' }, [...v].reverse().map((l) => el('li', { text: `${zeit(l.zeit)}: ${l.ergebnis.rpm == null ? 'keine Antworten pro Minute' : `${fmt(l.ergebnis.rpm, 0)} pro Minute, ${einstufung(l.ergebnis.rpm)}`}, ${mbit(l.ergebnis.down_bps)} runter` }))),
  ]);

  // Messung `netzinfo last` auf Knopfdruck, mit Hotspot-Rückfrage, Fortschritt und Verlauf. Die Karte „Unter Last“ und
  // die Hauptaktion „Tempo messen“ (tempo.js) teilen sich diesen Ablauf. `nach(ergebnis)` bekommt jedes frische Ergebnis,
  // `vorab(v)` die Antwort von `last_vorab` (letzter gespeicherter Lauf steht in v.verlauf).
  function lastSteuerung({ knopf, ort, verlauf, hinweis, nach, vorab, tempo }) {
    let hotspot = false;
    let frage = '';
    const zeigeVerlauf = (v) => verlauf.replaceChildren(...lastVerlauf(v));
    async function lauf(trotz) {
      const zurueck = halteFokus(knopf, ort);
      knopf.disabled = true;
      ort.replaceChildren(status('grau', 'Misst bis zu 30 Sekunden, die Leitung ist dabei voll ausgelastet'));
      try {
        const l = await frist('last_messen', { trotzHotspot: trotz }, 90);
        ort.replaceChildren(el('dl', { class: 'liste' }, lastZahlen(l.ergebnis, tempo)));
        knopf.textContent = 'Noch einmal messen';
        // Die Messung steht schon da: Scheitert nur der Verlauf, bleibt er, wie er war, und das Ergebnis geht nicht verloren.
        try { zeigeVerlauf((await frist('last_vorab', undefined, 15)).verlauf); } catch (v) { console.error(v); }
        await nach?.(l.ergebnis);
      } catch (e) {
        ort.replaceChildren(fehlerAus(e, () => knopf.click()));
        knopf.textContent = 'Noch einmal versuchen';
      }
      knopf.disabled = false;
      zurueck();
    }
    knopf.addEventListener('click', () => {
      if (!hotspot || ort.querySelector('.last-trotzdem')) return lauf(hotspot);
      // Zweite Rückfrage im Hotspot: erst der Hinweis, dann derselbe Knopf noch einmal.
      ort.replaceChildren(el('div', { class: 'last-trotzdem' }, meldung(frage, 'orange')));
      knopf.textContent = 'Trotzdem messen';
    });
    // Ein Fehler beim Lesen oder Zeichnen darf `vorab` nicht verschlucken: Tempo wartet darauf, um die Engpass-Karte zu laden.
    (async () => {
      let v = null;
      try {
        v = await frist('last_vorab', undefined, 15);
        hinweis.textContent = v.hinweis ?? '';
        // Apples networkQuality gibt es nur auf dem Mac: Knopf und Hinweis ehrlich machen.
        if (!Netz.mac) { hinweis.textContent = 'Die Messung unter Last gibt es unter Linux noch nicht.'; knopf.disabled = true; }
        hotspot = !!v.hotspot;
        frage = v.hotspot_frage ?? '';
        zeigeVerlauf(v.verlauf ?? []);
      } catch (f) { hinweis.replaceChildren(fehlerAus(f)); }
      vorab?.(v);
    })();
  }

  function lastKarte() {
    const ort = el('div', { 'aria-live': 'polite' });
    const verlauf = el('div');
    const knopf = el('button', { class: 'knopf', type: 'button', text: 'Reaktionsfähigkeit messen' });
    const hinweis = el('p', { class: 'last-hinweis' });
    lastSteuerung({ knopf, ort, verlauf, hinweis });
    return el('section', { class: 'gruppe last-karte', 'aria-labelledby': 'g-last' }, el('h3', { id: 'g-last', text: 'Unter Last' }),
      el('div', { class: 'karte' }, hinweis, knopf, ort, verlauf));
  }

  // ---- Gruppe „Ausfälle“ (src/ausfall.rs, issue #51): Zeitleiste der letzten 7 Tage und Text für den Anbieter ----
  const TAGE7 = 7 * 86400;
  const MAX_LISTE = 50; // mehr Zeilen machen die Ansicht zäh; der Text für den Anbieter enthält alle
  const ORT = { router_oder_wlan: 'Router oder WLAN', anbieter_oder_weiter: 'Anbieter oder weiter weg', nur_dns: 'nur DNS', unklar: 'nicht zuzuordnen' };
  const ERKL = {
    router_oder_wlan: 'Der Router war nicht erreichbar. Das spricht für ein Problem im WLAN oder am Router.',
    anbieter_oder_weiter: 'Der Router war erreichbar, das Internet nicht. Das spricht für eine Störung beim Anbieter oder weiter weg.',
    nur_dns: 'Nur die Namensauflösung fiel aus, eine direkte Verbindung ging. Das liegt am DNS-Server, nicht an der Leitung.',
    unklar: 'Der Router lässt sich in diesem Netz nicht messen, deshalb ist die Ursache nicht zuzuordnen.',
  };
  function ausfallKarte(tempo) {
    const ort = el('div', { 'aria-live': 'polite' });
    const hinweis = el('p', { class: 'fuss' });
    const fuss = el('div', { class: 'ausfall-fuss' });
    const knopf = el('button', { class: 'knopf', type: 'button', text: 'Text für den Anbieter kopieren' });
    const rueck = el('span', { class: 'fuss', role: 'status' });
    let d = null;
    ort.replaceChildren(status('grau', 'Lädt die Ausfälle …'));
    knopf.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(d.text);
        rueck.textContent = 'Kopiert';
        setTimeout(() => { rueck.textContent = ''; }, 2000);
      } catch {
        rueck.textContent = 'Das Kopieren ging nicht. Erlaube der App den Zugriff auf die Zwischenablage.';
      }
    });
    function zeichne() {
      if (!d) return;
      const bis = Math.floor(Date.now() / 1000);
      const von = bis - TAGE7;
      const liste = d.liste.filter((e) => e.beginn >= von);
      const aus = d.aussetzer.filter((t) => t >= von);
      // Bei der Zeitumstellung (am 25.10.2026 ging die Uhr von 3 auf 2 Uhr zurück) kommt 2:30 Uhr zweimal vor: Dann steht MESZ oder MEZ dabei.
      const gezeigt = [...liste].reverse().slice(0, MAX_LISTE);
      const labels = gezeigt.map((e) => zeit(e.beginn));
      const doppelt = new Set(labels.filter((t, i) => labels.indexOf(t) !== i));
      const wann = (s) => (doppelt.has(zeit(s)) ? `${zeit(s)} ${new Intl.DateTimeFormat('de-DE', { timeZoneName: 'short' }).formatToParts(new Date(s * 1000)).find((t) => t.type === 'timeZoneName')?.value ?? ''}` : zeit(s));
      const x = (t) => `${Math.min(100, Math.max(0, ((t - von) / TAGE7) * 100))}%`;
      knopf.hidden = liste.length === 0;
      if (liste.length === 0) {
        // Leer heißt „nichts aufgezeichnet“, nicht „alles gut“: Ohne den Schalter misst niemand.
        const zeichnet = tempo ? 'Antwortzeiten aufzeichnen' : 'Messen';
        ort.replaceChildren(status('grau', 'Keine Ausfälle aufgezeichnet'), el('p', { class: 'fuss', text: aus.length ? `${anzahl(aus.length, 'kurzer Aussetzer', 'kurze Aussetzer')}, jeweils unter 15 Sekunden` : `Netzinfo erkennt Ausfälle nur, solange „${zeichnet}“ an ist.` }));
        return;
      }
      const leiste = el('div', { class: 'ausfall-leiste', role: 'img', 'aria-label': `${anzahl(liste.length, 'Ausfall', 'Ausfälle')} und ${anzahl(aus.length, 'kurzer Aussetzer', 'kurze Aussetzer')} in den letzten 7 Tagen, Einzelheiten in der Liste darunter` },
        aus.map((t) => { const a = el('span', { class: 'strich', title: `Aussetzer, ${zeit(t)}` }); a.style.left = x(t); return a; }),
        liste.map((e) => { const b = el('span', { class: 'ausfall-balken', title: `Ausfall, ${wann(e.beginn)}, ${dauer(e.dauer_s)}, ${ORT[e.schicht] ?? ORT.unklar}` }); b.style.left = x(e.beginn); b.style.width = `max(4px, ${((e.dauer_s || 0) / TAGE7) * 100}%)`; return b; }));
      ort.replaceChildren(leiste,
        el('div', { class: 'ausfall-achse' }, el('span', { text: 'vor 7 Tagen' }), el('span', { text: 'jetzt' })),
        el('dl', { class: 'liste' }, gezeigt.map((e) => zeile(wann(e.beginn), `Ausfall, ${dauer(e.dauer_s)}`, `${ORT[e.schicht] ?? ORT.unklar}${e.aussetzer ? `, ${e.aussetzer} Aussetzer dabei` : ''}`, ERKL[e.schicht]))),
        liste.length > MAX_LISTE ? el('p', { class: 'fuss', text: `Hier stehen die ${MAX_LISTE} neuesten. Die ${liste.length - MAX_LISTE} älteren stehen im Text für den Anbieter.` }) : '',
        el('p', { class: 'fuss', text: `Strich = Aussetzer unter 15 Sekunden (${aus.length}), roter Balken = Ausfall. Die Zuordnung ist eine Vermutung aus der Messung.` }));
    }
    const lade = async () => {
      try {
        const r = await frist('ausfaelle', undefined, 15);
        if (!Array.isArray(r?.liste) || !Array.isArray(r.aussetzer)) throw 'Das Störungsprotokoll kam in einer unbekannten Form an. Starte die App neu; hilft das nicht, melde es als Fehler auf GitHub.';
        d = r;
        zeichne();
      } catch (f) { d = null; knopf.hidden = true; ort.replaceChildren(fehlerAus(f, lade)); } // auch ein Fehler beim Zeichnen: sonst bliebe „Lädt …“ stehen
    };
    lade();
    return {
      lade,
      wurzel: el('section', { class: 'gruppe ausfall-karte', 'aria-labelledby': 'g-ausfall' }, el('h3', { id: 'g-ausfall', text: tempo ? 'Störungen' : 'Ausfälle' }),
        el('div', { class: 'karte' }, hinweis, ort, el('div', { class: 'ausfall-fuss' }, knopf, rueck))),
      misst(an) { hinweis.textContent = an ? '' : tempo ? 'Ausfälle werden nur gezählt, solange unter „Details“ „Antwortzeiten aufzeichnen“ an ist.' : 'Ausfälle werden nur gezählt, solange gemessen wird.'; },
    };
  }

  Netz.registriere({
    id: 'qualitaet',
    teil: true,
    titel: 'Qualität',
    icon: Netz.icons.qualitaet,
    render: (wurzel) => bauen(wurzel),
  });
  Netz.qualitaet = { bauen, lastSteuerung, frist };

  // `tempo` (aus tempo.js): `{ ausfall }` bekommt das Störungsprotokoll; `wurzel` nimmt dann nur die Details auf,
  // ohne Kopf, ohne „Unter Last“ (das ist die Hauptaktion der Karte) und mit dem Schalter „Antwortzeiten aufzeichnen“.
  async function bauen(wurzel, tempo) {
      const SCHALTER = tempo ? 'Antwortzeiten aufzeichnen' : 'Messen';
      // Reload of the same view (⌘R) keeps measuring; leaving the view stopped it.
      const weiter = alt?.wurzel.isConnected && alt.an;
      alt?.stop();
      const ausfaelle = ausfallKarte(tempo);
      if (tempo) tempo.ausfall = ausfaelle.wurzel;
      let b;
      try {
        b = await frist('bericht', { name: null }, 15);
      } catch (e) {
        const unbekannt = e?.art === 'nicht_gemerkt';
        if (tempo) {
          wurzel.append(unbekannt
            ? el('div', { class: 'fehler-karte' }, meldung('Merke das Netz in der Übersicht, dann speichert Netzinfo Messungen dazu.', 'orange'),
              el('button', { class: 'knopf', type: 'button', text: 'Zur Übersicht', onclick: () => Netz.zeige('uebersicht') }))
            : fehlerAus(e, () => Netz.neuLaden()));
          return;
        }
        wurzel.append(
          el('div', { class: 'kopf' }, el('h2', { text: 'Qualität' }),
            status(unbekannt ? 'orange' : 'rot', unbekannt ? 'Netz nicht gemerkt' : 'Messen gerade nicht möglich')),
          unbekannt
            ? el('div', { class: 'fehler-karte' }, meldung('Merke das Netz unter „Dieses Netz“, dann speichert Netzinfo Messungen dazu.', 'orange'),
              el('button', { class: 'knopf haupt', type: 'button', text: 'Zu „Dieses Netz“', onclick: () => Netz.zeige('dieses-netz') }))
            : fehlerAus(e));
        return;
      }

      let std = 1;
      let timer = null;
      let gezeigt = null; // report the table was drawn for
      let seit = 0; // probes since the last full report
      const zustand = { wurzel, an: false, stop: () => { zustand.an = false; clearTimeout(timer); document.removeEventListener('visibilitychange', sicht); } };
      const stat = el('div'); // no live region: it is redrawn with every probe, the switch announces its own state
      const kurvenOrt = el('div', { class: 'karte' });
      const zahlen = el('div');
      const fehler = el('div', { 'aria-live': 'polite' });
      const schalter = el('button', { class: 'erklaeren-schalter', role: 'switch', 'aria-checked': 'false', type: 'button' }, el('span', { class: 'spur' }), el('span', { text: SCHALTER }));
      const zeitraum = el('select', { 'aria-label': 'Zeitraum der Kurve', onchange: () => { std = Number(zeitraum.value); zeichne(); } },
        el('option', { value: '1', text: 'Kurve: 1 Stunde' }), el('option', { value: '6', text: 'Kurve: 6 Stunden' }));
      const kopieren = el('button', { class: 'knopf', type: 'button', text: 'Bericht kopieren', onclick: async () => {
        try {
          await navigator.clipboard.writeText(markdown(b));
          fehler.replaceChildren();
          kopieren.textContent = 'Kopiert';
          setTimeout(() => { kopieren.textContent = 'Bericht kopieren'; }, 2000);
        } catch {
          fehler.replaceChildren(meldung('Das Kopieren ging nicht. Erlaube der App den Zugriff auf die Zwischenablage und versuche es noch mal.'));
        }
      } });

      function zeichne() {
        const leer = b.ziele.length === 0;
        const letzte = Math.max(0, ...b.reihen.map((r) => r.punkte.at(-1)?.zeit ?? 0));
        stat.replaceChildren(leer
          ? status('grau', 'Noch keine Messungen')
          : status(zustand.an ? 'gruen' : 'grau', zustand.an ? 'Misst alle 5 s' : `Misst gerade nicht${letzte ? `, letzte Messung ${zeit(letzte)}` : ''}. Schalte „${SCHALTER}“ ein`));
        kopieren.disabled = leer;
        kopieren.title = leer ? 'Erst nach der ersten Messung möglich' : '';
        ausfaelle.misst(zustand.an);
        if (leer && !b.reihen.some((r) => r.punkte.length)) {
          kurvenOrt.replaceChildren(leerZustand(Netz.icons.qualitaet, `Noch keine Messungen für dieses Netz. Schalte „${SCHALTER}“ ein, dann entsteht die Kurve.`, 'keine-messungen'));
          zahlen.replaceChildren();
          gezeigt = null;
          return;
        }
        const jetzt = Math.floor(Date.now() / 1000);
        const leerer = !b.reihen.some((r) => r.punkte.some((p) => p.zeit >= jetzt - std * 3600));
        kurvenOrt.replaceChildren(el('h3', { class: 'nur-vorlesen', text: 'Antwortzeit' }), kurve(b.reihen, std, jetzt), legende(['Router (DNS)', '1.1.1.1 (DNS)', '1.1.1.1 (TCP 443)']),
          leerer ? el('p', { class: 'fuss', text: `Im gewählten Zeitraum gibt es keine Messung.${std === 1 ? ' Wähle 6 Stunden oder schalte' : ' Schalte'} „${SCHALTER}“ ein, dann wächst die Kurve.` }) : '');
        if (gezeigt !== b) { zahlen.replaceChildren(kennzahlen(b)); gezeigt = b; } // the table changes only with a new report: VoiceOver is not thrown out of it every 5 s
      }

      async function tick() {
        if (!wurzel.isConnected) return zustand.stop(); // view was left
        try {
          const p = await frist('messen_einmal', undefined, 15);
          fehler.replaceChildren();
          delete fehler.dataset.t;
          p.werte.forEach((w, k) => {
            if (w.ms == null && !w.verlust) return; // not measured
            (b.reihen[k] ??= { ziel: w.ziel, punkte: [] }).punkte.push({ zeit: p.zeit, ms: w.ms, verlust: w.verlust });
          });
          // Die Kurve zeigt höchstens 6 Stunden: Ältere Punkte bleiben nicht im Speicher, sonst wächst das Feld über Tage.
          if (Number.isFinite(p.zeit)) for (const r of b.reihen) { const i = r.punkte.findIndex((q) => q.zeit >= p.zeit - 6 * 3600); r.punkte.splice(0, i < 0 ? r.punkte.length : i); }
          // ponytail: Kennzahlen are reread on the first and every 6th probe, the chart grows locally
          if (b.ziele.length === 0 || ++seit % 6 === 0) { b = { ...(await frist('bericht', { name: null }, 15)), reihen: b.reihen }; ausfaelle.lade(); }
        } catch (e) {
          if (fehler.dataset.t !== Netz.text(e)) { fehler.dataset.t = Netz.text(e); fehler.replaceChildren(meldung(Netz.text(e))); } // once, not every 5 s
        }
        if (!zustand.an || !wurzel.isConnected) return;
        zeichne();
        timer = setTimeout(tick, TAKT);
      }

      // Window hidden: no probes. Shown again: continue if the switch is on.
      function sicht() {
        clearTimeout(timer);
        if (!document.hidden && zustand.an) tick();
      }

      function schalte(an) {
        zustand.stop();
        zustand.an = an;
        schalter.setAttribute('aria-checked', an);
        // Nach ⌘R hängt die neue Ansicht noch nicht im Dokument: sofort zu messen hielte den Schalter an und die Messung aus.
        if (an) { document.addEventListener('visibilitychange', sicht); if (wurzel.isConnected) tick(); else setTimeout(tick, 100); } else zeichne();
      }
      schalter.addEventListener('click', () => schalte(!zustand.an));
      alt = zustand;

      wurzel.append(tempo ? el('p', { class: 'fuss', text: `Netz: ${b.netz}` }) : el('div', { class: 'kopf' }, el('h2', { text: b.netz })), stat,
        el('div', { class: 'werkzeuge' }, schalter, zeitraum, kopieren), fehler, kurvenOrt, zahlen);
      wurzel.append(diagnoseKarte(tempo));
      if (!tempo) wurzel.append(ausfaelle.wurzel);
      zeichne();
      wurzel.append(wegKarte());
      wurzel.append(wlanKarte());
      wurzel.append(mtuKarte());
      wurzel.append(ipv6Karte());
      wurzel.append(dnsTempoKarte());
      wurzel.append(zeitKarte());
      wurzel.append(egressKarte());
      wurzel.append(umfeldKarte());
      if (!tempo) wurzel.append(lastKarte());
      if (weiter) schalte(true);
  }
})();
