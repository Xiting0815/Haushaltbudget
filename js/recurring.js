/**
 * recurring.js
 *
 * Erkennung wiederkehrender Buchungen: Gruppierung nach Empfänger + Betrag
 * (mit Toleranz), Ableitung der Periodizität aus den zeitlichen Abständen.
 *
 *  ~30 Tage  -> monatlich
 *  ~90 Tage  -> vierteljährlich
 *  ~365 Tage -> jährlich
 *
 * Ab der zweiten erkannten Wiederholung wird ein Posten automatisch als
 * "wiederkehrend" vorgeschlagen. Bei kurzer Historie (1–2 Vorkommen) eines
 * mutmaßlich jährlichen Postens wird er als "möglicherweise wiederkehrend,
 * unsicher" markiert statt fest eingeplant — der Nutzer bestätigt manuell.
 */
(function (root) {
  'use strict';

  const AMOUNT_TOLERANCE_RATIO = 0.03; // 3% Toleranz
  const AMOUNT_TOLERANCE_MIN_CENTS = 50; // mindestens 0,50 EUR Toleranz

  const PERIOD_RANGES = [
    { rhythmus: 'monatlich', min: 25, max: 35 },
    { rhythmus: 'vierteljaehrlich', min: 80, max: 100 },
    { rhythmus: 'jaehrlich', min: 340, max: 390 },
  ];

  function classifyPeriod(avgGapDays) {
    for (const p of PERIOD_RANGES) {
      if (avgGapDays >= p.min && avgGapDays <= p.max) return p.rhythmus;
    }
    return null;
  }

  function amountsCloseEnough(a, b) {
    const diff = Math.abs(a - b);
    const tolerance = Math.max(AMOUNT_TOLERANCE_MIN_CENTS, Math.abs(a) * AMOUNT_TOLERANCE_RATIO);
    return diff <= tolerance;
  }

  /**
   * Gruppiert Buchungen nach merchantKey + ähnlichem Betrag.
   * @param {Array} transactions  {merchantKey, amountCents, date, ...}
   * @returns {Array<{merchantKey:string, amountCents:number, items:Array}>}
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
      // innerhalb eines Empfängers nach ähnlichem Betrag clustern
      const clusters = [];
      for (const item of items.sort((a, b) => a.date.localeCompare(b.date))) {
        let cluster = clusters.find((c) => amountsCloseEnough(c.avgAmount, item.amountCents));
        if (!cluster) {
          cluster = { avgAmount: item.amountCents, items: [] };
          clusters.push(cluster);
        }
        cluster.items.push(item);
        cluster.avgAmount = Math.round(
          cluster.items.reduce((s, i) => s + i.amountCents, 0) / cluster.items.length
        );
      }
      for (const cluster of clusters) {
        groups.push({ merchantKey, amountCents: cluster.avgAmount, items: cluster.items });
      }
    }
    return groups;
  }

  /**
   * Analysiert eine Gruppe gleichartiger Buchungen und liefert eine
   * Einschätzung der Periodizität + Konfidenz.
   */
  function analyzeGroup(group) {
    const items = [...group.items].sort((a, b) => a.date.localeCompare(b.date));
    if (items.length < 2) {
      return { ...group, occurrences: items.length, rhythmus: null, confidence: 'zu_wenig_daten' };
    }
    const dates = items.map((i) => new Date(i.date + 'T00:00:00'));
    const gaps = [];
    for (let i = 1; i < dates.length; i += 1) {
      gaps.push((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24));
    }
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const rhythmus = classifyPeriod(avgGap);

    let confidence = 'unsicher';
    if (rhythmus === 'jaehrlich') {
      confidence = items.length >= 3 ? 'bestaetigt' : 'unsicher';
    } else if (rhythmus === 'monatlich' || rhythmus === 'vierteljaehrlich') {
      confidence = items.length >= 2 ? 'bestaetigt' : 'unsicher';
    } else {
      confidence = 'kein_muster';
    }

    const lastDate = dates[dates.length - 1];
    const nextDue = rhythmus ? addPeriod(lastDate, rhythmus) : null;

    return {
      ...group,
      occurrences: items.length,
      avgGapDays: Math.round(avgGap),
      rhythmus,
      confidence,
      lastDate: items[items.length - 1].date,
      naechsteFaelligkeit: nextDue ? isoDate(nextDue) : null,
    };
  }

  function addPeriod(date, rhythmus) {
    const d = new Date(date);
    if (rhythmus === 'monatlich') d.setMonth(d.getMonth() + 1);
    else if (rhythmus === 'vierteljaehrlich') d.setMonth(d.getMonth() + 3);
    else if (rhythmus === 'jaehrlich') d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  function isoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  /**
   * Hauptfunktion: analysiert alle Buchungen und gibt nur die Kandidaten
   * zurück, die als (möglicherweise) wiederkehrend gelten (>= 2 Vorkommen
   * mit erkennbarem Muster).
   */
  function detectRecurring(transactions) {
    const expenseOnly = transactions.filter((t) => t.amountCents < 0);
    const groups = groupByMerchantAndAmount(expenseOnly);
    return groups
      .map(analyzeGroup)
      .filter((g) => g.rhythmus && g.occurrences >= 2)
      .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
  }

  root.Recurring = {
    detectRecurring,
    analyzeGroup,
    groupByMerchantAndAmount,
    classifyPeriod,
    amountsCloseEnough,
  };
})(typeof window !== 'undefined' ? window : this);
