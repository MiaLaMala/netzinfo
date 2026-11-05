// „Tempo“: beantwortet oben „Bekomme ich, wofür ich zahle, und wo bremst es?“ (#208, #207).
// Oben die Engpass-Karte (Kern: src/engpass.rs, Vertrag im Kopf von vorschau/engpass.js) mit der Hauptaktion „Tempo messen“,
// darunter das Störungsprotokoll und die Live-Kurve, alles Übrige unter „Details“ (der Rest von „Qualität“, qualitaet.js).
// Das CSS dieser Ansicht steht am Ende von qualitaet.css: index.html bindet kein eigenes tempo.css ein.
(() => {
  const { el, meldung } = Netz;
  // Zahlen vom Router können fehlen oder kaputt sein (null, NaN, negativ): dann steht ein Strich da, nie „NaN Mbit/s“ und kein Absturz.
  const ok = (v) => Number.isFinite(v) && v >= 0;
  const rate = (v) => (ok(v) ? `${v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 })} Mbit/s` : '–');
  // Ein Mac-Download aus einer älteren Messung sagt nichts mehr über das Netz von jetzt: nach einer Stunde zählt er nicht.
  const FRISCH_S = 3600;
  const AMPEL = { keiner: 'gruen', wlan: 'orange', leitung: 'orange', router: 'orange', unklar: 'grau' };
  // Wo man am Router die Zahl der Leitung freischaltet; ohne Router (kein_router) gibt es nichts zu tun.
  const UPNP = 'Schalte am Router die Statusinformationen über UPnP ein (bei der Fritz!Box unter Heimnetz, Netzwerk, Netzwerkeinstellungen).';

  // Drei Werte, gleiche Schrift; der Engpass trägt ein Wort und einen Rahmen, nie nur Farbe.
  function zahlen(e) {
    const feld = (label, wert, klein, bremst) => el('div', { class: `zahl-feld${bremst ? ' bremst' : ''}` },
      el('dt', { class: 'label', text: label }),
      el('dd', { class: 'gross num', text: wert }),
      klein && el('dd', { class: 'klein', text: klein }),
      bremst && el('dd', { class: 'engpass-wort' }, el('span', { class: 'punkt orange' }), 'Engpass'));
    const l = e.leitung;
    const leitung = l
      ? feld('Leitung laut Router', rate(l.down_mbit), ok(l.vertrag_down_mbit) ? `gebucht ${rate(l.vertrag_down_mbit)}` : 'Vertrag unbekannt', e.engpass === 'leitung')
      : feld('Leitung laut Router', '–', e.leitung_fehlt?.satz ?? 'Der Router nennt keine Zahl.');
    const w = e.wlan;
    const funk = e.kabel
      ? feld('WLAN', 'Kabel', 'kein WLAN dazwischen')
      : feld('WLAN', w ? rate(w.nutz_mbit) : '–', w ? `${ok(w.rate_mbit) ? `Senderate ${rate(w.rate_mbit)}` : 'Senderate unbekannt'}${w.band ? `, ${w.band}` : ''}` : 'nicht ermittelt', e.engpass === 'wlan');
    const mac = feld(Netz.mac ? 'Am Mac' : 'Am Rechner', rate(e.mac_down_mbit), ok(e.mac_down_mbit) ? 'Download, gemessen' : 'noch nicht gemessen');
    return el('dl', { class: 'engpass-zahlen' }, leitung, funk, mac);
  }

  // Wie es weitergeht, wenn der Router keine Zahl nennt: je `art` ein Ausweg.
  function ausweg(f) {
    if (f?.art === 'anmeldung') return el('p', { class: 'engpass-ausweg' }, el('button', { class: 'knopf', type: 'button', text: 'Zugang eintragen', onclick: () => Netz.fritzEintragen() }));
    if (f?.art === 'upnp') return el('p', { class: 'engpass-ausweg fuss', text: UPNP });
    return '';
  }

  Netz.registriere({
    id: 'tempo',
    titel: 'Tempo',
    icon: Netz.icons.qualitaet,
    async render(wurzel) {
      // Die Antwort ist die Überschrift, wie in Übersicht und Verbindungen.
      const antwort = el('h2', { class: 'antwort' });
      const antworte = (farbe, satz) => antwort.replaceChildren(el('span', { class: `punkt ${farbe}`, 'aria-hidden': 'true' }), el('span', { text: satz }));
      antworte('grau', 'Lädt …');
      const zahlenOrt = el('div');
      const rat = el('p', { class: 'engpass-rat', hidden: true });
      const ort = el('div', { 'aria-live': 'polite' });
      const verlauf = el('div', { class: 'verlauf' });
      const hinweis = el('p', { class: 'last-hinweis fuss' });
      const knopf = el('button', { class: 'knopf haupt', type: 'button', text: 'Tempo messen' });
      let mac = null; // letzter Download am Mac in Mbit/s, aus dem Verlauf oder der Messung

      let stand = 0; // nur die jüngste Antwort zählt: „Erneut versuchen“ und die Messung können sich überholen
      async function lies() {
        const nr = ++stand;
        try {
          const e = await Netz.qualitaet.frist('engpass_lesen', { macDownMbit: mac }, 20);
          if (nr !== stand) return;
          antworte(AMPEL[e.engpass] ?? 'grau', e.satz);
          zahlenOrt.replaceChildren(zahlen(e), ausweg(e.leitung_fehlt));
          rat.textContent = e.rat ?? '';
          rat.hidden = !e.rat;
        } catch (f) {
          if (nr !== stand) return;
          antworte('rot', 'Das Tempo ist gerade nicht lesbar');
          zahlenOrt.replaceChildren(Netz.fehlerKarte(Netz.text(f), lies));
          rat.hidden = true;
        }
      }

      // Messung, Hotspot-Rückfrage, Fortschritt und Verlauf teilt sich die Karte mit „Unter Last“ in „Qualität“.
      Netz.qualitaet.lastSteuerung({
        knopf, ort, verlauf, hinweis, tempo: true,
        vorab: (v) => { const l = v?.verlauf?.at(-1); mac = l?.zeit > Date.now() / 1000 - FRISCH_S && ok(l.ergebnis?.down_bps) ? l.ergebnis.down_bps / 1e6 : null; lies(); },
        nach: (r) => { mac = ok(r?.down_bps) ? r.down_bps / 1e6 : null; return lies(); },
      });

      const karte = el('section', { class: 'gruppe engpass-karte', 'aria-labelledby': 'g-engpass' },
        el('h3', { id: 'g-engpass', text: 'Wo bremst es?' }),
        el('div', { class: 'karte' }, zahlenOrt, rat,
          el('div', { class: 'engpass-aktion' }, knopf, hinweis), ort,
          el('details', { class: 'details verlauf-details' }, el('summary', { text: 'Frühere Messungen' }), verlauf),
          el('p', { class: 'fuss' }, 'Das ersetzt nicht die Breitbandmessung der Bundesnetzagentur, die für eine Minderung zählt: ',
            // Tauri öffnet target=_blank nicht: Die App öffnet die feste Adresse selbst im Browser.
            el('a', { href: 'https://breitbandmessung.de', text: 'breitbandmessung.de', onclick: (e) => {
              e.preventDefault();
              Netz.invoke('breitbandmessung_oeffnen').catch((f) => e.target.closest('.fuss').after(meldung(Netz.text(f), 'rot')));
            } }), '.')));

      // „Details“ zuerst bauen: das Störungsprotokoll gehört zu „Qualität“, steht aber hier oben.
      // Bricht ein Teil ab, zeigt nur dieser Teil seine Fehlerkarte; die Engpass-Karte oben bleibt.
      const gemeinsam = { ausfall: null };
      const detailsInhalt = el('div', { class: 'eingebettet', 'data-ansicht': 'qualitaet' });
      const live = el('div', { class: 'eingebettet', 'data-ansicht': 'live' });
      for (const [ort, bau] of [[detailsInhalt, () => Netz.qualitaet.bauen(detailsInhalt, gemeinsam)], [live, () => Netz.live.bauen(live, true)]]) {
        try { await bau(); } catch (f) { console.error(f); ort.replaceChildren(Netz.fehlerKarte(Netz.text(f))); }
      }

      wurzel.append(
        el('div', { class: 'kopf', 'aria-live': 'polite' }, antwort),
        karte,
        gemeinsam.ausfall ? el('div', { class: 'eingebettet', 'data-ansicht': 'qualitaet' }, gemeinsam.ausfall) : '',
        el('section', { class: 'gruppe', 'aria-labelledby': 'g-live-kurve' }, el('h3', { id: 'g-live-kurve', text: 'Live-Kurve' }), live),
        el('details', { class: 'details' }, el('summary', { text: 'Details' }), detailsInhalt));
    },
  });
})();
