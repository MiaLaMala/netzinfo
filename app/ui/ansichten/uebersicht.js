// „Übersicht“: beantwortet oben „Ist das noch mein Netz?“ (#208). Aus „Dieses Netz“ und „Prüfung“:
// oben die Antwort, darunter höchstens fünf Werte und eine Hauptaktion, alles Übrige unter „Details“.
// Die Daten kommen aus denselben Befehlen (`dieses_netz`, `pruefen`); den Messlauf teilt sie mit der Prüfung über Netz.pruefung.
(() => {
  const { el, zeit, gruppe, zeile, meldung, status } = Netz;

  // Thema des wichtigsten Unterschieds (aus pruefung.js) als Satzteil.
  const SATZ = {
    'DHCP-Server': 'ein anderer DHCP-Server verteilt Adressen',
    DNS: 'das Netz nennt andere DNS-Server',
    Umleitung: 'das Netz erfindet Antworten für falsche Namen',
    'Weg ins Internet': 'der Weg ins Internet führt anders',
    Sperre: 'ein Name wird jetzt blockiert',
    'Öffentliche IP': 'die öffentliche IP hat gewechselt',
    WLAN: 'das WLAN ist anders',
  };
  const satzteil = (t) => SATZ[t] ?? (String(t).startsWith('Zertifikat von ') ? `das ${t} ist anders` : 'etwas ist anders');

  // Die Lage in einem Satz: { farbe, satz, mehr, fuss, fehler, portal }.
  function lage(d, vpn) {
    const p = Netz.pruefung;
    const { z } = p;
    const erg = z.erg;
    const nm = d.netz?.name || 'dieses Netz'; // ein Name aus nichts als Leerstellen oder ohne Namen bleibt lesbar
    if (d.erkennung_fehler) {
      return { farbe: 'grau', satz: vpn ? 'Du bist über ein VPN verbunden, das Netz dahinter lässt sich nicht wiedererkennen.' : 'Dieses Netz lässt sich nicht wiedererkennen.', fuss: d.erkennung_fehler };
    }
    if (!d.netz) return { farbe: 'grau', satz: 'Neues Netz. Merk es dir, dann vergleicht Netzinfo beim nächsten Besuch.' };
    if (z.fehler && !z.offen.vergleich) return { farbe: 'rot', satz: `Der Vergleich für ${nm} ist fehlgeschlagen.`, fehler: z.fehler };
    if (z.offen.vergleich || !erg) return { farbe: 'grau', satz: `Ich vergleiche ${nm} mit dem letzten Besuch …` };

    const misst = z.offen.sni || z.offen.portal;
    const was = [z.offen.sni && 'Webfilter', z.offen.portal && 'Anmeldeseite'].filter(Boolean).join(' und ');
    const wartet = misst ? [status('grau', `${was} ${z.offen.sni && z.offen.portal ? 'werden' : 'wird'} noch gemessen.`)] : [];
    const portal = p.portalHinweis();
    if (portal) {
      return { farbe: 'orange', portal, satz: `Anmeldung nötig: ${nm} leitet vermutlich auf eine Anmeldeseite um${portal.ziel_host ? ` (${portal.ziel_host})` : ''}.`, mehr: wartet };
    }
    if (erg.erster_besuch) return { farbe: 'grau', satz: `Das ist ${nm}. Erste Messung, ab jetzt vergleicht Netzinfo damit.`, mehr: [...p.kartenBefunde(), ...wartet] };

    const erster = p.diffs(erg)[0];
    const n = p.diffs(erg).filter((u) => u.klasse !== 'Harmlos').length - 1;
    const teil = erster && satzteil(p.thema(erster.text)) + (n > 0 ? ` (dazu ${n} ${n === 1 ? 'weiterer Unterschied' : 'weitere Unterschiede'})` : '');
    if (erster?.klasse === 'Alarm') return { farbe: 'rot', satz: `Vielleicht nicht mehr ${nm}: ${teil}. Klär das, bevor du Passwörter eingibst.`, mehr: [...p.kartenBefunde(), ...wartet] };
    if (erster?.klasse === 'Auffaellig') return { farbe: 'orange', satz: `Das ist ${nm}, aber ${teil}.`, mehr: [...p.kartenBefunde(), ...wartet] };
    const b = p.befunde();
    if (b.length) {
      const h = b.find((x) => x[0] === 'rot') ?? b[0];
      return { farbe: h[0], satz: `${nm}: ${h[2]}`, mehr: [...b.filter((x) => x !== h).map(([f, w, t]) => status(f, `${w}. ${t}`)), ...wartet] }; // dieselbe Liste b, sonst bliebe h doppelt
    }
    const seit = Number.isFinite(erg.vorher?.time) ? `am ${zeit(erg.vorher.time)}` : 'beim letzten Besuch';
    if (misst) return { farbe: 'grau', satz: `Bisher ist bei ${nm} nichts anders als ${seit}.`, mehr: wartet };
    // Eine Prüfung, die selbst fehlschlug, ist kein „alles gut“.
    if (p.luecken()) return { farbe: 'grau', satz: `Bei ${nm} ist nichts anders als ${seit}, aber ${p.luecken()}.` };
    return { farbe: 'gruen', satz: `Das ist ${nm}, wie ${Number.isFinite(erg.vorher?.time) ? `beim letzten Besuch am ${zeit(erg.vorher.time)}` : 'beim letzten Besuch'}.`, mehr: [z.sni?.unklar && status('grau', 'Der Webfilter ließ sich nicht beurteilen.')] };
  }

  // Die fünf Werte: Netz, Adresse, Router, DNS, Signal. Das Wort „gut“ steht im Wert, die Farbe verstärkt es nur.
  function werte(d, funk, vpn) {
    const i = d.info;
    const E = Netz.dieses.E;
    const st = funk && Netz.dieses.staerkeVon(funk.rssi_dbm);
    const sd = Netz.dieses.liste(i.system_dns);
    const dns = sd.length > 1 ? `${sd[0]} und ${sd.length - 1} ${sd.length === 2 ? 'weiterer' : 'weitere'}` : sd[0];
    const signal = zeile('Signal', funk ? (st ? `${funk.rssi_dbm} dBm, ${st}` : null) : vpn ? 'VPN-Tunnel' : 'Kabel',
      funk ? 'Das Signal liegt bei einer Zahl unter null. Je näher an null, desto besser, ab minus 70 dBm wird es merklich schlechter.' : 'Ohne Funk gibt es kein Signal, das Kabel ist die Verbindung.');
    if (st) signal.querySelector('.wert').classList.add({ gut: 'gut', mittel: 'mittel', schwach: 'schlecht' }[st]);
    return gruppe('Auf einen Blick', [
      zeile('Netz', (Netz.dieses.ssidOk(funk?.ssid) ? funk.ssid : null) ?? (d.netz?.name || null) ?? (funk ? 'WLAN' : vpn ? 'VPN-Tunnel' : 'Kabel'), funk && !Netz.dieses.ssidOk(funk.ssid) && !d.netz
        ? 'macOS gibt den Namen des WLANs erst mit Standortfreigabe heraus, bis dahin steht hier „WLAN“.'
        : 'Der Name des WLANs, sonst der Name, unter dem du das Netz gemerkt hast.'),
      zeile('Adresse', i.ip ?? 'keine IPv4-Adresse', E.ip(i.dhcp_server != null)),
      zeile('Router', i.router ?? 'kein IPv4-Router', E.router),
      zeile('DNS', dns, E.systemDns(sd.includes('100.100.100.100'))),
      signal,
    ]);
  }

  let nummer = 0;

  Netz.registriere({
    id: 'uebersicht',
    titel: 'Übersicht',
    icon: Netz.icons.wlan,
    aktualisieren: false, // ⌘R heißt hier „Jetzt prüfen“ (ohne bekanntes Netz: neu lesen)
    async render(wurzel) {
      const mein = ++nummer;
      let d;
      let funk;
      try {
        const { mitFrist } = Netz.dieses;
        [d, funk] = await Promise.all([
          mitFrist(Netz.invoke('dieses_netz'), 30000, 'Das Netz hat nicht geantwortet. Prüf, ob du mit WLAN oder Kabel verbunden bist, und versuch es noch mal.'),
          mitFrist(Netz.invoke('wlan_lesen'), 20000).catch(() => null)]);
        if (!d?.info) throw 'Der Mac hat keine Netzdaten geliefert. Verbinde ihn mit WLAN oder Kabel und versuch es noch mal.';
        d.info = { ...d.info, interface: d.info.interface ?? '' };
      } catch (e) {
        wurzel.append(el('div', { class: 'kopf' }, el('h2', { tabindex: '-1', text: 'Übersicht' })), Netz.fehlerKarte(Netz.text(e)));
        return;
      }
      const p = Netz.pruefung;
      const { z } = p;
      const vpn = d.info.interface.startsWith('utun');
      p.frischen();
      // Ein Ergebnis eines anderen Netzes zählt nicht.
      if (d.netz && z.erg && z.erg.netz && z.erg.netz !== d.netz.name) { z.erg = z.fehler = z.sni = z.portal = null; }

      const ansage = el('p', { class: 'nur-vorlesen', role: 'status', 'aria-live': 'polite' });
      const kopf = el('div', { class: 'kopf' });
      const belege = el('div', { class: 'eingebettet', 'data-ansicht': 'pruefung' }); // die Liste der Unterschiede, gestaltet wie in der Prüfung
      const aktion = el('div', { class: 'aktion' });
      const pruefKnopf = el('button', { class: 'knopf haupt', type: 'button', onclick: () => p.lauf() });
      const details = el('details', { class: 'details' }, el('summary', { text: 'Details' }));
      const kannPruefen = !!d.netz && !d.erkennung_fehler;

      // Zeichnet bei jedem Schritt der Prüfung neu, solange diese Ansicht die letzte ist.
      const zeichne = () => {
        const l = lage(d, vpn);
        const hatteFokus = kopf.contains(document.activeElement);
        const erg = z.erg;
        kopf.replaceChildren(...[
          el('h2', { class: 'antwort', tabindex: '-1' }, el('span', { class: `punkt ${l.farbe}`, 'aria-hidden': 'true' }), el('span', { text: l.satz })),
          d.hinweis && meldung(d.hinweis, 'orange'),
          l.portal && el('p', { class: 'fuss', text: 'Solange du dich nicht angemeldet hast, sind die übrigen Ergebnisse unzuverlässig.' }),
          l.portal && el('button', { class: 'knopf haupt', type: 'button', text: 'Im Browser öffnen', 'aria-label': `Im Browser öffnen, Anmeldeseite${l.portal.ziel_host ? ` von ${l.portal.ziel_host}` : ''}`,
            onclick: p.browserOeffnen }),
          l.fuss && el('p', { class: 'fuss', text: l.fuss }),
          l.fehler && Netz.fehlerKarte(l.fehler, p.lauf),
          l.mehr,
          el('p', { class: 'erklaerung', text: 'Netz wiedererkennen heißt: Netzinfo merkt sich einen Fingerabdruck aus Router, DHCP-Server und Subnetz und vergleicht ihn beim nächsten Besuch.' }),
        ].flat().filter(Boolean)); // replaceChildren würde undefined als Text einsetzen
        // Die Unterschiede sind der Beleg für die Antwort und stehen direkt darunter.
        belege.replaceChildren(...(kannPruefen && erg && !z.offen.vergleich && !erg.erster_besuch && p.diffs(erg).length ? [p.unterschiede(erg)] : []));
        if (kannPruefen) {
          pruefKnopf.setAttribute('aria-disabled', String(z.laeuft)); // nicht disabled: sonst fällt der Fokus an den Seitenanfang
          pruefKnopf.classList.toggle('haupt', !l.portal); // nur eine Hauptaktion: mit Anmeldehinweis führt dessen Knopf
          pruefKnopf.replaceChildren(z.laeuft ? 'Prüfe …' : 'Jetzt prüfen', ...(z.laeuft ? [] : [el('span', { class: 'kbd', 'aria-hidden': 'true', text: Netz.taste('R') })]));
          aktion.hidden = !!l.fehler; // dort trägt die Fehlerkarte den Knopf
        }
        if (hatteFokus) kopf.querySelector('h2').focus({ preventScroll: true });
      };

      // Ohne Standortfreigabe zeigt macOS den WLAN-Namen nicht: Das steht hier, wo „Netz: WLAN“ steht, nicht tief in „Details“.
      const ort = funk ? Netz.dieses.ortKarte(await Netz.dieses.mitFrist(Netz.invoke('ort_status'), 10000).catch(() => 'Erlaubt')) : null;
      wurzel.append(ansage, kopf, belege, werte(d, funk, vpn), aktion, ort ? el('div', { class: 'eingebettet', 'data-ansicht': 'dieses-netz' }, ort) : '', details); // append schreibt null als Text
      if (kannPruefen) aktion.append(pruefKnopf);
      else if (d.erkennung_fehler) aktion.append(el('button', { class: 'knopf haupt', type: 'button', onclick: () => Netz.neuLaden() }, 'Neu lesen', el('span', { class: 'kbd', 'aria-hidden': 'true', text: Netz.taste('R') })));
      else aktion.append(Netz.dieses.offenKnopf());

      // Alles Übrige: beide alten Ansichten ohne Kopf und ohne das, was oben schon steht.
      details.append(...(await Promise.all(['dieses-netz', 'pruefung'].map(Netz.einbetten))));

      p.lausche((was) => {
        if (mein !== nummer) return false; // eine neuere Übersicht hat übernommen
        if (was === 'zeichne') zeichne();
        else if (was === 'start') ansage.textContent = 'Prüfung läuft';
        else ansage.textContent = (kopf.querySelector('h2')?.innerText ?? '').replace(/\s+/g, ' ');
      });
      zeichne();
      if (kannPruefen && !z.laeuft && !z.erg && (!z.fehler || z.art === 'nicht_gemerkt')) p.lauf();
    },
  });

  // ⌘R: bei bekanntem Netz „Jetzt prüfen“, sonst neu lesen. Läuft vor dem gemeinsamen Handler in app.js.
  document.addEventListener('keydown', (e) => {
    if (!(Netz.istTaste(e) && e.key.toLowerCase() === 'r')
      || document.getElementById('tab-uebersicht')?.getAttribute('aria-selected') !== 'true') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const knopf = document.querySelector("[data-ansicht='uebersicht'] .aktion button[aria-disabled]");
    if (knopf) knopf.click(); else Netz.neuLaden();
  }, true);
})();
