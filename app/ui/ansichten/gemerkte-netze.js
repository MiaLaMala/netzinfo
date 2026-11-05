// „Einstellungen“ (⌘,): gemerkte Netze aus netze.json, Autostart und der Zugang zur Fritz!Box.
// Die Id bleibt `gemerkte-netze`, damit Marken, CSS und Verweise weiter passen.
(() => {
  const { el, zeit, meldung } = Netz;

  // Datum ohne Uhrzeit; fehlt der Wert oder ist er unsinnig, steht „unbekannt“ statt „Invalid Date“.
  const tag = (s) => (Number.isFinite(s) && s > 0 && !isNaN(new Date(s * 1000)) ? new Date(s * 1000).toLocaleDateString('de-DE', { dateStyle: 'medium' }) : 'unbekannt');
  // Fehlt der Befehl (kein Mac), ist die Gruppe zu Recht weg. Jeder andere Fehler (z. B. Schlüsselbund) wird gezeigt.
  const fehltBefehl = (f) => /not found|nicht gefunden|unknown command/i.test(Netz.text(f));
  const fehlerGruppe = (id, titel, f) => el('section', { class: 'gruppe', 'aria-labelledby': id },
    el('h3', { id, text: titel }), el('div', { class: 'liste block' }, Netz.nurMac(f) ? meldung(Netz.LINUX_NOCH_NICHT, 'grau') : meldung(Netz.text(f))));

  function zeile(start, nr, hier) {
    let n = start;
    const ort = el('div', { class: 'netz-zeile', role: 'listitem' });
    const fehler = el('div', { class: 'zeilenfehler', 'aria-live': 'polite' });
    const knopf = el('button', { class: 'knopf', type: 'button', text: 'Vergessen' });
    knopf.classList.add('gefahr');
    const zeigeFehler = (e) => fehler.replaceChildren(meldung(Netz.text(e)));
    // Quiet confirmation for screen readers and eyes, gone after a few seconds.
    let weg;
    const rueckmeldung = (satz) => {
      fehler.replaceChildren(el('p', { class: 'fein rueckmeldung', text: satz }));
      clearTimeout(weg);
      weg = setTimeout(() => fehler.replaceChildren(), 4000);
    };
    const zurueck = () => { normal(); ort.querySelector('.umbenennen-knopf').focus(); };

    // Rename in place: Enter saves, Escape cancels, an error stays in the row.
    const umbenennen = () => {
      const feld = el('input', { type: 'text', class: 'umbenennen', value: n.name, 'aria-label': `Neuer Name für ${n.name}`, autocomplete: 'off', spellcheck: 'false' });
      ort.classList.add('bearbeiten');
      const sichern = el('button', { class: 'knopf haupt', type: 'button', text: 'Sichern', 'aria-label': `Neuen Namen für ${n.name} sichern` });
      const abbrechen = el('button', { class: 'knopf', type: 'button', text: 'Abbrechen', 'aria-label': `Umbenennen von ${n.name} abbrechen`, onclick: zurueck });
      const speichern = async () => {
        if (feld.disabled) return;
        if (feld.value.trim() === n.name) return zurueck();
        feld.disabled = sichern.disabled = true;
        try {
          n = await Netz.invoke('netz_umbenennen', { alt: n.name, neu: feld.value });
          zurueck();
          rueckmeldung(`Umbenannt in „${n.name}“.`);
        } catch (err) {
          zeigeFehler(err);
          feld.setAttribute('aria-invalid', 'true');
          feld.disabled = sichern.disabled = false;
          feld.focus();
        }
      };
      sichern.addEventListener('click', speichern);
      // Escape cancels from the field and from both buttons; Enter in the field saves.
      ort.onkeydown = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); zurueck(); }
        else if (e.key === 'Enter' && e.target === feld) { e.preventDefault(); speichern(); }
      };
      ort.querySelector('.name-ort').replaceChildren(feld);
      ort.querySelector('.kopf-zeile').append(sichern, abbrechen);
      fehler.replaceChildren();
      feld.focus();
      feld.select();
    };

    const schalter = () => {
      const s = el('button', { class: 'erklaeren-schalter', type: 'button', role: 'switch', 'aria-checked': String(!!n.meins), 'aria-label': `${n.name} ist meins`, 'aria-describedby': 'meins-hilfe' },
        el('span', { class: 'spur' }), el('span', { text: 'meins' }));
      s.addEventListener('click', async () => {
        s.disabled = true;
        try {
          n = await Netz.invoke('netz_markieren', { name: n.name, meins: s.getAttribute('aria-checked') !== 'true' });
          normal();
          ort.querySelector('[role="switch"]').focus();
          rueckmeldung(n.meins ? `„${n.name}“ ist jetzt dein Netz.` : `„${n.name}“ ist nicht mehr dein Netz.`);
        } catch (err) {
          zeigeFehler(err);
          s.disabled = false;
          s.focus();
        }
      });
      return s;
    };

    // Label über Wert, in einem Raster: bricht nie mitten im Satz, sondern nur als ganzes Feld um.
    // Für VoiceOver eine Beschreibungsliste: „DoT: ja“. Der Punkt ist nur Zierde, das Wort steht daneben.
    const feld = (label, wert, farbe, leer) => el('div', { class: 'feld' }, el('dt', { class: 'fl', text: label }),
      el('dd', { class: `fw wert${leer ? ' leer' : ''}` }, farbe && el('span', { class: `punkt ${farbe}`, 'aria-hidden': 'true' }), wert));
    // Letzte Messung des verschlüsselten DNS (#88), ohne zu senden. Fehlt sie, steht ein Feld mit „noch nicht geprüft“.
    const ja = { Erreichbar: ['ja', 'gruen'], Blockiert: ['nein', 'orange'], Abgefangen: ['abgefangen', 'rot'] };
    const dns = el('dl', { class: 'felder' }, feld('Verschlüsseltes DNS', 'noch nicht geprüft', null, true));
    Netz.invoke('dns_gespeichert', { name: n.name }).then((g) => {
      if (!g) return;
      const m = g.messung;
      const [dot, doh] = [m.dot, m.doh].map((x) => ja[x] ?? ['unbekannt', 'grau']);
      dns.replaceChildren(feld('DoT', dot[0], dot[1]), feld('DoH', doh[0], doh[1]),
        feld('DDR', m.ddr ? 'ja' : 'nein', m.ddr ? 'gruen' : 'grau'), feld('DNS geprüft am', tag(m.zeit)));
    }).catch(() => {
      // Lesefehler heißt nicht „nie geprüft“: Das Feld sagt es, statt „noch nicht geprüft“ stehen zu lassen.
      dns.replaceChildren(feld('Verschlüsseltes DNS', 'nicht lesbar', null, true));
    });

    // Verbunden: Der Status steht schon oben, der Platz bleibt leer, damit die Felder in allen Zeilen untereinander stehen.
    const fein = () => [feld('Zuletzt hier', hier ? 'jetzt' : zeit(n.last_seen)), feld('Gemerkt seit', tag(n.first_seen)),
      feld('Router', n.fingerprint?.router || 'unbekannt', null, !n.fingerprint?.router), feld('Domain', n.fingerprint?.domain || 'ohne Domain', null, !n.fingerprint?.domain)];
    const normal = () => {
      ort.classList.remove('bearbeiten');
      ort.onkeydown = null;
      knopf.setAttribute('aria-label', `${n.name} vergessen`);
      fehler.replaceChildren();
      ort.replaceChildren(
        el('div', { class: 'kopf-zeile' },
          el('div', { class: 'name-ort' }, el('h3', { class: 'netz-name', text: n.name, ondblclick: umbenennen }),
            hier && el('span', { class: 'hier' }, el('span', { class: 'punkt gruen', 'aria-hidden': 'true' }), 'Verbunden')),
          el('button', { class: 'knopf umbenennen-knopf', type: 'button', text: 'Umbenennen', 'aria-label': `${n.name} umbenennen`, onclick: umbenennen }),
          knopf),
        el('dl', { class: 'felder' }, fein()), dns,
        el('div', { class: 'meins-zeile' }, schalter()),
        fehler);
    };
    knopf.addEventListener('click', () => {
      fehler.replaceChildren();
      ort.replaceChildren(
        el('div', { class: 'kopf-zeile' }, el('div', { class: 'name-ort' }, el('h3', { class: 'netz-name', text: n.name }))),
        Netz.bestaetigung({
          frage: `„${n.name}“ vergessen? Beim nächsten Besuch gilt das Netz wieder als neu, und die Markierung „meins“ ist weg.${hier ? ' Die Verbindung bleibt, nur Netzinfo vergisst das Netz.' : ''}`,
          label: `${n.name} vergessen?`,
          aria: `${n.name} endgültig vergessen`,
          knopf: 'Vergessen',
          abbrechen: () => { normal(); knopf.focus(); },
          aktion: async () => {
            await Netz.invoke('netz_vergessen', { name: n.name });
            await Netz.neuLaden();
            // The row is gone: focus the one that moved up, not the page.
            const rest = document.querySelectorAll('[data-ansicht="gemerkte-netze"] .umbenennen-knopf');
            if (rest.length) return rest[Math.min(nr, rest.length - 1)].focus();
            // Last one gone: the empty state takes the focus, not the page.
            const leer = document.querySelector('[data-ansicht="gemerkte-netze"] .leer-zustand p');
            leer?.setAttribute('tabindex', '-1');
            leer?.focus();
          },
          fehler: zeigeFehler,
        }),
        fehler);
    });
    normal();
    return ort;
  }

  // Start mit der Anmeldung (#9). Fehlt der Befehl oder scheitert er beim Lesen, bleibt die Gruppe weg.
  async function autostart() {
    let an;
    try { an = await Netz.invoke('autostart_lesen'); } catch (f) {
      return fehltBefehl(f) ? null : fehlerGruppe('g-allgemein', 'Allgemein', f);
    }
    if (an === null || an === undefined) return null;
    // Dev build: the login item would point into target/, the core says so (#142).
    // Nur ein Zusatzhinweis: Scheitert er, bleibt der Schalter ohne ihn bedienbar.
    const hinweis = await Netz.invoke('autostart_hinweis').catch(() => null);
    const s = el('button', { class: 'erklaeren-schalter', type: 'button', role: 'switch', 'aria-checked': an, 'aria-describedby': 'autostart-hilfe' },
      el('span', { class: 'spur' }), el('span', { text: 'Mit der Anmeldung starten' }));
    const fehler = el('div', { 'aria-live': 'polite' });
    s.addEventListener('click', async () => {
      s.disabled = true;
      try {
        s.setAttribute('aria-checked', await Netz.invoke('autostart_setzen', { an: s.getAttribute('aria-checked') !== 'true' }));
        fehler.replaceChildren();
      } catch (err) {
        fehler.replaceChildren(meldung(Netz.text(err)));
      }
      s.disabled = false;
      s.focus();
    });
    return el('section', { class: 'gruppe', 'aria-labelledby': 'g-allgemein' },
      el('h3', { id: 'g-allgemein', text: 'Allgemein' }),
      el('div', { class: 'liste block' }, s,
        el('p', { class: 'fein', id: 'autostart-hilfe', text: 'Netzinfo läuft dann in der Menüleiste und meldet sich, wenn ein Netz auffällig ist. macOS fragt dann einmal, ob Netzinfo Mitteilungen senden darf. Das Fenster zu schließen beendet die Wache nicht.' }),
        hinweis && el('p', { class: 'fein', text: hinweis }), fehler));
  }

  // Fritz!Box-Zugang (Rust: fritzbox): Die Oberfläche kennt nur den Benutzernamen, das Passwort liegt im Schlüsselbund.
  // Fehlt der Befehl (kein Mac), bleibt die Gruppe weg.
  let feldNr = 0;
  async function fritzbox() {
    let benutzer;
    try { benutzer = await Netz.invoke('fritzbox_zugang'); } catch (f) {
      return fehltBefehl(f) ? null : fehlerGruppe('g-fritz', 'Fritz!Box', f);
    }
    if (benutzer === undefined) return null;
    const ort = el('div', { class: 'liste block' });
    const gruppe = el('section', { class: 'gruppe fritz', 'aria-labelledby': 'g-fritz' }, el('h3', { id: 'g-fritz', text: 'Fritz!Box' }), ort);
    const ansage = el('p', { class: 'nur-vorlesen', role: 'status' });
    const hilfe = el('p', { class: 'fein', text: 'Mit dem Zugang liest Netzinfo die Geräteliste der Fritz!Box, auch die Geräte, die auf keinen Scan antworten. Das Passwort speichert Netzinfo nur im macOS-Schlüsselbund.' });

    const formular = () => {
      const bid = `fritz-benutzer-${++feldNr}`;
      const pid = `fritz-passwort-${feldNr}`;
      const fid = `fritz-fehler-${feldNr}`;
      const b = el('input', { id: bid, type: 'text', value: benutzer ?? '', placeholder: 'Benutzer', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', maxlength: '60' });
      const pw = el('input', { id: pid, type: 'password', placeholder: 'Passwort', autocomplete: 'current-password', maxlength: '200' });
      const fehler = el('div', { id: fid, 'aria-live': 'polite' });
      const speichern = el('button', { class: 'knopf haupt', type: 'submit', text: 'Speichern' });
      const zurueck = (ziel) => { zeichne(); ort.querySelector(ziel)?.focus(); };
      const form = el('form', {
        class: 'fritz-formular', 'aria-label': 'Zugang zur Fritz!Box',
        onsubmit: async (e) => {
          e.preventDefault();
          speichern.disabled = true;
          for (const f of [b, pw]) { f.removeAttribute('aria-invalid'); f.removeAttribute('aria-describedby'); }
          try {
            await Netz.invoke('fritzbox_speichern', { benutzer: b.value, passwort: pw.value });
            pw.value = '';
            benutzer = b.value.trim();
            zeichne();
            ansage.textContent = `Zugang „${benutzer}“ gespeichert.`;
            ort.querySelector('.fritz-aendern')?.focus();
          } catch (f) {
            fehler.replaceChildren(meldung(Netz.text(f), 'rot'));
            for (const x of [b, pw]) { x.setAttribute('aria-invalid', 'true'); x.setAttribute('aria-describedby', fid); }
            speichern.disabled = false;
            pw.focus();
          }
        },
        onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); zurueck('.fritz-aendern, .fritz-einrichten'); } },
      }, el('label', { class: 'nur-vorlesen', for: bid, text: 'Benutzer der Fritz!Box' }), b,
      el('label', { class: 'nur-vorlesen', for: pid, text: 'Passwort der Fritz!Box' }), pw,
      el('p', { class: 'fein', text: 'Lege in der Fritz!Box unter System, Fritz!Box-Benutzer einen eigenen Benutzer an und gib ihm das Recht „FRITZ!Box Einstellungen“.' }),
      el('div', { class: 'knoepfe' }, el('button', { class: 'knopf', type: 'button', text: 'Abbrechen', onclick: () => zurueck('.fritz-aendern, .fritz-einrichten') }), speichern),
      fehler);
      ort.replaceChildren(form);
      b.focus();
    };

    const entfernen = (zeile) => zeile.replaceChildren(Netz.bestaetigung({
      frage: 'Zugang aus dem Schlüsselbund entfernen? Die Geräte aus der Router-Liste bleiben in deiner Liste.',
      label: 'Fritz!Box-Zugang entfernen?',
      aria: 'Fritz!Box-Zugang endgültig entfernen',
      knopf: 'Entfernen',
      abbrechen: () => { zeichne(); ort.querySelector('.fritz-entfernen')?.focus(); },
      aktion: async () => {
        await Netz.invoke('fritzbox_entfernen');
        benutzer = null;
        zeichne();
        ansage.textContent = 'Zugang entfernt.';
        ort.querySelector('.fritz-einrichten')?.focus();
      },
      fehler: (f) => { zeile.querySelector('.meldung')?.remove(); zeile.append(meldung(Netz.text(f), 'rot')); },
    }));

    function zeichne() {
      if (!benutzer) {
        ort.replaceChildren(hilfe, el('div', { class: 'aktionen' }, el('button', { class: 'knopf fritz-einrichten', type: 'button', text: 'Zugang einrichten', onclick: formular })));
        return;
      }
      const zeile = el('div', { class: 'aktionen' },
        el('button', { class: 'knopf fritz-aendern', type: 'button', text: 'Zugang ändern', onclick: formular }),
        el('button', { class: 'knopf gefahr fritz-entfernen', type: 'button', text: 'Zugang entfernen', onclick: () => entfernen(zeile) }));
      ort.replaceChildren(el('p', { class: 'fritz-benutzer', text: `Zugang „${benutzer}“ im Schlüsselbund` }), hilfe, zeile);
    }
    zeichne();
    gruppe.append(ansage);
    return gruppe;
  }

  Netz.registriere({
    id: 'gemerkte-netze',
    teil: true,
    titel: 'Einstellungen',
    icon: Netz.icons.zahnrad,
    async render(wurzel) {
      const liste = await Netz.invoke('gemerkte_netze');
      // Which saved network is the Mac in right now? Unknown or not saved: no row is marked.
      // Nur Zierde (Zeile „Verbunden“): Scheitert die Erkennung, bleibt keine Zeile markiert, die Liste steht trotzdem.
      const jetzt = (await Netz.invoke('dieses_netz').catch(() => null))?.netz?.name;
      const [start, fritz] = await Promise.all([autostart(), fritzbox()]);
      const titel = liste.length ? `Gemerkte Netze (${liste.length})` : 'Gemerkte Netze';
      wurzel.append(el('div', { class: 'kopf' }, el('h2', { text: 'Einstellungen' })),
        el('section', { class: 'gruppe', 'aria-labelledby': 'g-netze' },
          el('h3', { id: 'g-netze', text: titel }),
          liste.length
            ? [el('div', { class: 'liste', role: 'list' }, liste.map((n, i) => zeile(n, i, n.name === jetzt))),
              el('p', { class: 'fuss', id: 'meins-hilfe', text: '„meins“ erlaubt Gerätesuche und Portscans in diesem Netz. Schalte es nur für Netze ein, die dir gehören.' }),
              el('p', { class: 'fuss erklaer-gruppe', text: 'DoT und DoH verschlüsseln deine DNS-Anfragen (die Frage nach der Adresse zu einem Namen). DDR heißt: Der Router verrät selbst, welchen verschlüsselten Server er anbietet. „nein“ heißt: Bei der letzten Prüfung ging das in diesem Netz nicht.' })]
            : el('div', { class: 'liste' }, Netz.leerZustand(Netz.icons.merken, 'Noch kein Netz gemerkt. In der Übersicht merkst du das aktuelle.', 'gemerkte-netze'))),
        start, fritz);
    },
  });

  // „Zugang eintragen“ aus Geräte und Tempo: Einstellungen zeigen und das Fritz!Box-Formular gleich öffnen.
  Netz.fritzEintragen = async () => {
    await Netz.zeige('gemerkte-netze');
    document.querySelector("[data-ansicht='gemerkte-netze'] .fritz-einrichten")?.click();
  };
})();
