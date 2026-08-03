/**
 * planned.js
 *
 * Geplante (zukünftige) Ausgaben: der Nutzer trägt Ausgaben ein, die noch
 * nicht gebucht sind, aber absehbar anstehen. Diese fließen sofort als
 * Rücklage in die Budgetberechnung ein (siehe budget.js).
 *
 * Abgleich-Logik: Taucht später beim PDF-Import eine passende reale
 * Buchung auf (ähnlicher Betrag, zeitlich passend), wird sie mit dem
 * geplanten Posten verknüpft und dieser als erledigt markiert — sonst
 * würde der Betrag doppelt vom Budget abgezogen.
 */
(function (root) {
  'use strict';

  const MATCH_DAYS_WINDOW = 14; // Buchung darf bis zu 14 Tage vor/nach Fälligkeit liegen
  const MATCH_AMOUNT_TOLERANCE_RATIO = 0.15; // 15% Toleranz beim Betrag

  function amountMatches(plannedCents, txCents) {
    const diff = Math.abs(Math.abs(plannedCents) - Math.abs(txCents));
    const tolerance = Math.max(200, Math.abs(plannedCents) * MATCH_AMOUNT_TOLERANCE_RATIO);
    return diff <= tolerance;
  }

  function dateWithinWindow(faelligkeitsdatum, txDate) {
    const d1 = new Date(faelligkeitsdatum + 'T00:00:00');
    const d2 = new Date(txDate + 'T00:00:00');
    const diffDays = Math.abs((d2 - d1) / (1000 * 60 * 60 * 24));
    return diffDays <= MATCH_DAYS_WINDOW;
  }

  /**
   * Versucht, offene geplante Ausgaben mit neu importierten Buchungen zu
   * verknüpfen. Gibt die Liste der Matches zurück (ohne sie zu speichern —
   * das übernimmt der Aufrufer via DB, damit dies testbar bleibt).
   */
  function matchPlannedToTransactions(openPlanned, newTransactions, alreadyLinkedTxIds) {
    const linked = new Set(alreadyLinkedTxIds || []);
    const matches = [];
    const candidates = newTransactions.filter((t) => t.amountCents < 0 && !linked.has(t.id) && !t.plannedId);

    for (const planned of openPlanned) {
      if (planned.status !== 'offen') continue;
      let best = null;
      let bestDiff = Infinity;
      for (const tx of candidates) {
        if (linked.has(tx.id)) continue;
        if (!dateWithinWindow(planned.faelligkeitsdatum, tx.date)) continue;
        if (!amountMatches(planned.betragCents, tx.amountCents)) continue;
        const diff = Math.abs(Math.abs(planned.betragCents) - Math.abs(tx.amountCents));
        if (diff < bestDiff) {
          bestDiff = diff;
          best = tx;
        }
      }
      if (best) {
        linked.add(best.id);
        matches.push({ plannedId: planned.id, transactionId: best.id });
      }
    }
    return matches;
  }

  async function createPlanned(DB, { name, betragCents, faelligkeitsdatum, category }) {
    const planned = {
      name,
      betragCents: -Math.abs(betragCents),
      faelligkeitsdatum,
      category: category || Categorization.DEFAULT_CATEGORY_ID,
      status: 'offen',
      verknuepfteTransaktionId: null,
      createdAt: new Date().toISOString(),
    };
    const id = await DB.add('geplanteAusgaben', planned);
    return { ...planned, id };
  }

  async function applyMatches(DB, matches) {
    for (const m of matches) {
      const planned = await DB.get('geplanteAusgaben', m.plannedId);
      const tx = await DB.get('transactions', m.transactionId);
      if (!planned || !tx) continue;
      planned.status = 'erledigt';
      planned.verknuepfteTransaktionId = tx.id;
      tx.plannedId = planned.id;
      await DB.put('geplanteAusgaben', planned);
      await DB.put('transactions', tx);
    }
  }

  root.Planned = {
    matchPlannedToTransactions,
    createPlanned,
    applyMatches,
    amountMatches,
    dateWithinWindow,
  };
})(typeof window !== 'undefined' ? window : this);
