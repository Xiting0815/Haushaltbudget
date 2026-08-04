/**
 * recurring.js
 *
 * Erkennung wiederkehrender Buchungen (Fixkosten-Vorschläge).
 *
 * Ideen übernommen/adaptiert von der Recurring-Detection aus dem
 * quelloffenen Projekt "radiant" (prabhask5/radiant, MIT, offline-first
 * PWA mit IndexedDB — ähnliche Architektur wie hier):
 *   https://github.com/prabhask5/radiant/blob/main/src/lib/ml/recurringDetector.ts
 *
 * Übernommen daraus:
 *  - Intervall-exakter Abgleich statt Durchschnitts-Lücke: JEDES Intervall
 *    zwischen zwei Buchungen muss zu einem Vielfachen der Periode passen
 *    (mit wurzelskalierter Toleranz für übersprungene Zyklen), statt nur
 *    den Mittelwert zu klassifizieren — robuster bei einer ausgelassenen
 *    Monatsrate.
 *  - Betrags-Konsistenz über den Variationskoeffizienten (CV = Standard-
 *    abweichung / Mittelwert) statt paarweiser Tolerenz.
 *  - Aktualitäts-Check: liegt die letzte Buchung viel länger zurück als der
 *    erkannte Rhythmus erwarten lässt (>2,5× Periode), gilt der Posten als
 *    vermutlich beendet ("ausgelaufen", z. B. gekündigtes Abo) statt
 *    weiter als anstehend geführt zu werden.
 *  - Zyklen-Aufspaltung pro Empfänger (splitByCycle): ein Empfänger kann
 *    mehrere unabhängige wiederkehrende Posten mit unterschiedlichem Betrag
 *    / Rhythmus haben (zeitliche Passung als Hauptsignal, Betrag als
 *    Kappung/Tie-Breaker), statt naiv nach Betrag zu clustern.
 *  - Kontinuierlicher Konfidenz-Score statt starrem Schwellenwert.
 *
 * Sparkasse-/SEPA-spezifische Ergänzung (in der US-Vorlage nicht möglich,
 * da dort Kartentransaktionen ohne SEPA-Mandat vorliegen): Eine per
 * Gläubiger-ID erkannte Lastschrift (siehe categorization.js) ist ein
 * starkes Signal für einen echten, registrierten Lastschrift-Auftrag und
 * bekommt einen Konfidenz-Bonus. Umgekehrt verlangen von Natur aus stark
 * streuende Kategorien (Lebensmittel, Gastro, Shopping) ohne Gläubiger-ID
 * mehr Vorkommen, bevor automatisch bestätigt wird — zwei zufällig ähnlich
 * teure Supermarkt-Einkäufe sind kein Beweis für eine Fixkosten.
 *
 *  ~30 Tage  -> monatlich
 *  ~90 Tage  -> vierteljährlich
 *  ~365 Tage -> jährlich
 *
 * Erkennt seit August 2026 nicht mehr nur wiederkehrende Ausgaben, sondern
 * auch wiederkehrende Einnahmen (Kindergeld, Gehalt, ...) — Auslöser war
 * Nutzer-Feedback, dass die App zwar anstehende Fixkosten "vorhält", aber
 * bekanntes, regelmäßig eintreffendes Geld nirgends als erwartetes
 * Guthaben berücksichtigt. Die Ergebnisse tragen ein `richtung`-Feld
 * ('ausgabe' | 'einnahme'); siehe app.js (Fixkosten-Merge) und budget.js
 * (Rücklagenberechnung berücksichtigt Einnahmen als Gegenposten).
 */
(function (root) {
  'use strict';

  const MS_PER_DAY = 86400000;

  const FREQUENCY_SPECS = [
    { rhythmus: 'monatlich', period: 30, tolerance: 6 },
    { rhythmus: 'vierteljaehrlich', period: 91, tolerance: 12 },
    { rhythmus: 'jaehrlich', period: 365, tolerance: 20 },
  ];

  // Deutlich enger als vergleichbare US-Implementierungen: echte deutsche
  // Fixkosten (Miete, Versicherung, Telefon, Abos per Lastschrift) sind so
  // gut wie immer exakt gleich, während Supermarkt-/Drogerie-Einkäufe stark
  // streuen. Eine lockere Toleranz (>15-20%) lässt sonst zufällig ähnlich
  // teure Einkäufe (z. B. zwei Rewe-Besuche) fälschlich als "wiederkehrend"
  // durchgehen.
  const AMOUNT_HARD_CAP_RATIO = 0.08; // >8% Betragsabweichung -> nicht derselbe Zyklus
  const AMOUNT_CV_GATE = 0.12; // Streuung >= 12% -> kein belastbares Muster

  // "sonstiges" ist die Sammelkategorie für alles nicht eindeutig
  // Zuordenbare (siehe categorization.js) — per Definition unsicherer
  // Boden, verdient also ebenfalls die strengere 3-Vorkommen-Regel. Bei
  // detectRecurring() werden ohnehin nur Ausgaben betrachtet, Gehalt/Lohn
  // (positive Beträge, landen sonst ebenfalls in "sonstiges") ist davon
  // also nicht betroffen.
  const HIGH_VARIANCE_CATEGORIES = new Set(['lebensmittel', 'gastro', 'shopping', 'sonstiges']);

  function isoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  function addPeriod(date, rhythmus) {
    const d = new Date(date);
    if (rhythmus === 'monatlich') d.setMonth(d.getMonth() + 1);
    else if (rhythmus === 'vierteljaehrlich') d.setMonth(d.getMonth() + 3);
    else if (rhythmus === 'jaehrlich') d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  /** Variationskoeffizient (Standardabweichung / Mittelwert). 0 = perfekt konsistent. */
  function computeCV(values) {
    if (values.length === 0) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    if (mean === 0) return 0;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) / mean;
  }

  function mostCommon(items) {
    const counts = new Map();
    for (const it of items) counts.set(it, (counts.get(it) || 0) + 1);
    let best = items[0];
    let bestCount = 0;
    for (const [it, c] of counts) {
      if (c > bestCount) { best = it; bestCount = c; }
    }
    return best;
  }

  /**
   * Erkennt, ob ein merchantKey aus einer SEPA-Gläubiger-ID stammt (siehe
   * categorization.js: extractMerchantKey bevorzugt diese, wenn im
   * Verwendungszweck vorhanden — Format z. B. "de24zzz00000561652").
   */
  function looksLikeGlaeubigerId(merchantKey) {
    return /^[a-z]{2}\d{2}[a-z0-9]{3,35}$/i.test(merchantKey || '');
  }

  function amountsCloseEnough(a, b) {
    const diff = Math.abs(a - b);
    const tolerance = Math.max(50, Math.abs(a) * AMOUNT_HARD_CAP_RATIO);
    return diff <= tolerance;
  }

  function matchesFrequency(daysSince, period, baseTolerance) {
    const multiples = Math.round(daysSince / period);
    if (multiples < 1) return { fits: false, deviation: Infinity };
    const expected = multiples * period;
    const tolerance = baseTolerance * Math.sqrt(multiples);
    const deviation = Math.abs(daysSince - expected);
    return { fits: deviation <= tolerance, deviation };
  }

  /**
   * Teilt die Buchungen eines Empfängers in unabhängige Abrechnungszyklen
   * auf (z. B. zwei unterschiedliche Amazon-Abos). Hauptsignal: zeitliche
   * Passung zu einem sich etablierenden Rhythmus; der Betrag dient als
   * harte Kappung (>20% Abweichung = anderer Zyklus) und als Tie-Breaker.
   */
  function splitByCycle(items) {
    if (items.length <= 2) return [items];
    const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));

    const cycles = [];
    for (const item of sorted) {
      const itemDate = new Date(item.date + 'T00:00:00').getTime();
      const itemAmount = Math.abs(item.amountCents);

      let best = -1;
      let bestScore = Infinity;

      for (let c = 0; c < cycles.length; c += 1) {
        const cycle = cycles[c];
        const daysSince = (itemDate - cycle.lastDate) / MS_PER_DAY;
        if (daysSince < 3) continue;

        const amountDev = cycle.avgAmount > 0
          ? Math.abs(itemAmount - cycle.avgAmount) / cycle.avgAmount : 0;
        if (amountDev > AMOUNT_HARD_CAP_RATIO) continue;

        let fits = false;
        let dev = Infinity;
        if (cycle.period !== null) {
          const r = matchesFrequency(daysSince, cycle.period, 8);
          fits = r.fits;
          dev = r.deviation;
        } else {
          for (const spec of FREQUENCY_SPECS) {
            const r = matchesFrequency(daysSince, spec.period, spec.tolerance);
            if (r.fits && r.deviation < dev) { dev = r.deviation; fits = true; }
          }
        }
        if (!fits) continue;

        const nascentPenalty = cycle.period === null ? 5 : 0;
        const score = dev + amountDev * 40 + nascentPenalty;
        if (score < bestScore) { bestScore = score; best = c; }
      }

      if (best >= 0) {
        const cycle = cycles[best];
        if (cycle.period === null) cycle.period = (itemDate - cycle.lastDate) / MS_PER_DAY;
        cycle.items.push(item);
        cycle.lastDate = itemDate;
        cycle.avgAmount = cycle.items.reduce((s, i) => s + Math.abs(i.amountCents), 0) / cycle.items.length;
      } else {
        cycles.push({ items: [item], lastDate: itemDate, period: null, avgAmount: itemAmount });
      }
    }

    const result = cycles.map((c) => c.items);
    return result.length > 0 ? result : [items];
  }

  /**
   * Gruppiert Buchungen nach merchantKey und spaltet je Empfänger in
   * Abrechnungszyklen auf (siehe splitByCycle).
   */
  function groupByMerchantAndAmount(transactions) {
    const byMerchant = new Map();
    for (const t of transactions) {
      if (!t.merchantKey) continue;
      if (!byMerchant.has(t.merchantKey)) byMerchant.set(t.merchantKey, []);
      byMerchant.get(t.merchantKey).push(t);
    }

    const groups = [];
    for (const [merchantKey, items] of byMerchant) {
      for (const cycleItems of splitByCycle(items)) {
        const avgAmount = Math.round(cycleItems.reduce((s, i) => s + i.amountCents, 0) / cycleItems.length);
        groups.push({ merchantKey, amountCents: avgAmount, items: cycleItems });
      }
    }
    return groups;
  }

  /**
   * Analysiert eine Gruppe gleichartiger Buchungen: Periodizität (jedes
   * Intervall muss passen, nicht nur der Durchschnitt), Betragskonsistenz
   * (Variationskoeffizient), Aktualität und ein Konfidenz-Score daraus.
   */
  function analyzeGroup(group, today) {
    const items = [...group.items].sort((a, b) => a.date.localeCompare(b.date));
    const occurrences = items.length;

    const richtung = group.amountCents >= 0 ? 'einnahme' : 'ausgabe';

    if (occurrences < 2) {
      return { ...group, occurrences, richtung, rhythmus: null, confidence: 'zu_wenig_daten', confidenceScore: 0 };
    }

    const dates = items.map((i) => new Date(i.date + 'T00:00:00'));
    const intervals = [];
    for (let i = 1; i < dates.length; i += 1) intervals.push((dates[i] - dates[i - 1]) / MS_PER_DAY);

    let bestRhythmus = null;
    let bestMaxDev = Infinity;
    for (const spec of FREQUENCY_SPECS) {
      let ok = true;
      let maxDev = 0;
      for (const gap of intervals) {
        const r = matchesFrequency(gap, spec.period, spec.tolerance);
        if (!r.fits) { ok = false; break; }
        maxDev = Math.max(maxDev, r.deviation);
      }
      if (ok && maxDev < bestMaxDev) { bestRhythmus = spec.rhythmus; bestMaxDev = maxDev; }
    }

    const amounts = items.map((i) => Math.abs(i.amountCents));
    const amountCV = computeCV(amounts);
    const hasGlaeubigerId = looksLikeGlaeubigerId(group.merchantKey);

    const categories = items.map((i) => i.category).filter(Boolean);
    const dominantCategory = categories.length ? mostCommon(categories) : null;
    // Von Natur aus stark streuende Kategorien (Supermarkt, Gastro, Shopping)
    // ohne SEPA-Mandat: zwei zufällig ähnlich teure Einkäufe sind kein
    // Beweis für eine Fixkosten — solche Kandidaten werden ganz verworfen
    // statt als "unsicher" die Übersicht zuzumüllen. Ab drei Vorkommen ist
    // Zufall unwahrscheinlich genug, um sie zumindest zur Prüfung vorzuschlagen.
    const isHighVarianceCategory = HIGH_VARIANCE_CATEGORIES.has(dominantCategory) && !hasGlaeubigerId;

    if (!bestRhythmus || amountCV >= AMOUNT_CV_GATE || (isHighVarianceCategory && occurrences < 3)) {
      return {
        ...group, occurrences, richtung, rhythmus: null, confidence: 'kein_muster',
        confidenceScore: 0, amountCV, hasGlaeubigerId,
      };
    }

    const lastDate = dates[dates.length - 1];
    const spec = FREQUENCY_SPECS.find((s) => s.rhythmus === bestRhythmus);
    const intervalTightness = Math.max(0, 1 - bestMaxDev / spec.tolerance);
    const amountTightness = Math.max(0, 1 - amountCV / AMOUNT_CV_GATE);
    const samplePenalty = Math.min(1, 0.5 + occurrences * 0.15);
    let confidenceScore = (intervalTightness * 0.5 + amountTightness * 0.5) * samplePenalty;
    if (hasGlaeubigerId) confidenceScore = Math.min(1, confidenceScore + 0.2);
    if (isHighVarianceCategory) confidenceScore = Math.max(0, confidenceScore - 0.2);
    confidenceScore = Math.round(confidenceScore * 1000) / 1000;

    const referenceToday = today ? new Date(today + 'T00:00:00') : new Date();
    const daysSinceLast = (referenceToday - lastDate) / MS_PER_DAY;
    const stale = daysSinceLast > spec.period * 2.5;

    // Klassifizierung anhand des Scores statt starrer Kategorie-Sperre: der
    // Score enthält den Abzug für streuungsanfällige Kategorien bereits
    // (s. o.) — reicht die Gesamtevidenz trotzdem (z. B. 5× exakt derselbe
    // Betrag, perfekt monatlich), darf es dennoch "bestätigt" werden, statt
    // pauschal bei jeder unsicheren Kategorie hängen zu bleiben.
    let confidence;
    if (stale) {
      confidence = 'ausgelaufen';
    } else if (bestRhythmus === 'jaehrlich' && occurrences < 3) {
      confidence = 'unsicher'; // kurze Historie bei mutmaßlich jährlichem Posten
    } else if (confidenceScore >= 0.5) {
      confidence = 'bestaetigt';
    } else {
      confidence = 'unsicher';
    }

    const nextDue = stale ? null : addPeriod(lastDate, bestRhythmus);

    return {
      ...group,
      occurrences,
      richtung,
      avgGapDays: Math.round(intervals.reduce((s, g) => s + g, 0) / intervals.length),
      rhythmus: bestRhythmus,
      confidence,
      confidenceScore,
      amountCV: Math.round(amountCV * 1000) / 1000,
      hasGlaeubigerId,
      stale,
      lastDate: items[items.length - 1].date,
      naechsteFaelligkeit: nextDue ? isoDate(nextDue) : null,
    };
  }

  /**
   * Hauptfunktion: analysiert alle Buchungen und gibt die Kandidaten
   * zurück, die ein erkennbares Muster haben (>= 2 Vorkommen). Enthält
   * auch als "ausgelaufen" erkannte Posten, damit bereits bestätigte
   * Fixkosten beim nächsten Import korrekt deaktiviert werden können.
   *
   * Ausgaben (Fixkosten) und Einnahmen (z. B. Kindergeld, Gehalt) werden
   * getrennt gruppiert und analysiert — ein Empfänger/Absender-Schlüssel
   * soll nie eine Gutschrift und eine Lastschrift im selben Zyklus
   * vermischen. Beide Richtungen laufen durch dieselbe Erkennungslogik
   * (Intervall-/Betrags-Konsistenz, Aktualitäts-Check, Konfidenz-Score);
   * das Ergebnis trägt ein `richtung`-Feld ('ausgabe' | 'einnahme'), damit
   * wiederkehrende Einnahmen wie erwartetes Guthaben behandelt werden
   * können statt nur wiederkehrende Ausgaben als Fixkosten.
   */
  function detectRecurring(transactions, today) {
    const expenses = transactions.filter((t) => t.amountCents < 0);
    const incomes = transactions.filter((t) => t.amountCents > 0);
    const groups = [
      ...groupByMerchantAndAmount(expenses),
      ...groupByMerchantAndAmount(incomes),
    ];
    return groups
      .map((g) => analyzeGroup(g, today))
      .filter((g) => g.rhythmus && g.occurrences >= 2)
      .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
  }

  root.Recurring = {
    detectRecurring,
    analyzeGroup,
    groupByMerchantAndAmount,
    splitByCycle,
    classifyPeriod: (avgGapDays) => {
      for (const spec of FREQUENCY_SPECS) {
        const r = matchesFrequency(avgGapDays, spec.period, spec.tolerance);
        if (r.fits) return spec.rhythmus;
      }
      return null;
    },
    amountsCloseEnough,
    computeCV,
    looksLikeGlaeubigerId,
  };
})(typeof window !== 'undefined' ? window : this);
