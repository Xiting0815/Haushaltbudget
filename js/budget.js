/**
 * budget.js
 *
 * Wochen-/Monatsbudget, Sparquote, Ansparpotenzial, Monatstrend.
 *
 * Grundprinzip: verfügbarer Betrag = aktueller Kontostand minus Rücklage
 * für offene Fixkosten und offene geplante Ausgaben, die vor Ende des
 * betrachteten Zeitraums fällig werden. Das verfügbare Geld wird dann auf
 * die verbleibenden Tage/Wochen verteilt.
 */
(function (root) {
  'use strict';

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function daysBetween(a, b) {
    const d1 = new Date(a + 'T00:00:00');
    const d2 = new Date(b + 'T00:00:00');
    return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  }

  function endOfMonth(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
  }

  function endOfWeek(dateStr) {
    // Woche endet Sonntag (ISO-Woche: Montag..Sonntag)
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay(); // 0 = Sonntag
    const diffToSunday = day === 0 ? 0 : 7 - day;
    d.setDate(d.getDate() + diffToSunday);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Summe der Rücklagen für offene Fixkosten und geplante Ausgaben, die
   * zwischen heute und `untilDate` (inklusive) fällig werden.
   *
   * Fixkosten und geplante Posten sind vorzeichenbehaftet: negativ = Ausgabe
   * (wird zurückgelegt, senkt den verfügbaren Betrag), positiv = erwartete
   * Einnahme (Kindergeld, Gehalt, geplante Einnahme) — die wird stattdessen
   * schon jetzt zum verfügbaren Betrag hinzugerechnet, da der Nutzer sie
   * zuverlässig erwartet, auch wenn sie im Kontostand (letzter Auszug/
   * manueller Stand) noch nicht enthalten ist. `reserve += -amountCents`
   * bildet beide Fälle einheitlich ab: Ausgabe (negativ) erhöht die
   * Rücklage, Einnahme (positiv) senkt sie (= erhöht das Verfügbare).
   */
  function computeReserveCents(fixkosten, geplanteAusgaben, fromDate, untilDate) {
    let reserve = 0;
    const details = [];

    for (const f of fixkosten) {
      if (!f.active) continue;
      if (!f.naechsteFaelligkeit) continue;
      if (f.naechsteFaelligkeit >= fromDate && f.naechsteFaelligkeit <= untilDate) {
        reserve += -f.amountCents;
        details.push({ type: 'fixkosten', id: f.id, name: f.name, amountCents: f.amountCents, faellig: f.naechsteFaelligkeit });
      }
    }

    for (const p of geplanteAusgaben) {
      if (p.status !== 'offen') continue;
      if (p.faelligkeitsdatum >= fromDate && p.faelligkeitsdatum <= untilDate) {
        reserve += -p.betragCents;
        details.push({ type: 'geplant', id: p.id, name: p.name, amountCents: p.betragCents, faellig: p.faelligkeitsdatum });
      }
    }

    return { reserveCents: reserve, details };
  }

  /**
   * Berechnet Wochen- und Monatsbudget ausgehend vom aktuellen Kontostand.
   */
  function computeBudget({ currentBalanceCents, fixkosten, geplanteAusgaben, today }) {
    today = today || todayISO();
    const monthEnd = endOfMonth(today);
    const weekEnd = endOfWeek(today);

    const { reserveCents: monthReserve, details: monthDetails } =
      computeReserveCents(fixkosten, geplanteAusgaben, today, monthEnd);
    const availableForMonth = currentBalanceCents - monthReserve;

    const daysLeftInMonth = Math.max(1, daysBetween(today, monthEnd) + 1);
    const dailyRate = availableForMonth / daysLeftInMonth;

    const daysLeftInWeek = Math.max(1, Math.min(daysBetween(today, weekEnd) + 1, daysLeftInMonth));
    const availableForWeek = Math.round(dailyRate * daysLeftInWeek);

    return {
      today,
      monthEnd,
      weekEnd,
      currentBalanceCents,
      monthReserveCents: monthReserve,
      monthReserveDetails: monthDetails,
      availableForMonthCents: Math.round(availableForMonth),
      dailyRateCents: Math.round(dailyRate),
      daysLeftInMonth,
      daysLeftInWeek,
      availableForWeekCents: availableForWeek,
    };
  }

  /**
   * Einnahmen/Ausgaben/Sparquote für einen Kalendermonat (YYYY-MM).
   */
  function computeMonthSummary(transactions, yearMonth) {
    const rows = transactions.filter((t) => t.date.startsWith(yearMonth));
    let income = 0;
    let expense = 0;
    const byCategory = {};
    for (const t of rows) {
      if (t.amountCents >= 0) income += t.amountCents;
      else {
        expense += -t.amountCents;
        byCategory[t.category] = (byCategory[t.category] || 0) + -t.amountCents;
      }
    }
    const savingsCents = income - expense;
    const savingsRate = income > 0 ? savingsCents / income : null;
    return { yearMonth, incomeCents: income, expenseCents: expense, savingsCents, savingsRate, byCategory };
  }

  /**
   * Monatstrend über die letzten `months` Monate (inkl. aktuellem Monat).
   */
  function computeMonthlyTrend(transactions, months, today) {
    months = months || 6;
    today = today || todayISO();
    const result = [];
    const d = new Date(today + 'T00:00:00');
    for (let i = months - 1; i >= 0; i -= 1) {
      const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      result.push(computeMonthSummary(transactions, ym));
    }
    return result;
  }

  /**
   * Durchschnittliche monatliche Sparquote über die letzten Monate ->
   * Ansparpotenzial-Schätzung.
   */
  function computeSavingsPotential(monthlyTrend) {
    const withIncome = monthlyTrend.filter((m) => m.incomeCents > 0);
    if (withIncome.length === 0) return { avgMonthlySavingsCents: 0, avgSavingsRate: null };
    const avgSavings = withIncome.reduce((s, m) => s + m.savingsCents, 0) / withIncome.length;
    const avgRate = withIncome.reduce((s, m) => s + (m.savingsRate || 0), 0) / withIncome.length;
    return { avgMonthlySavingsCents: Math.round(avgSavings), avgSavingsRate: avgRate };
  }

  /**
   * Status der Kategorie-Limits für einen Monat.
   * @param {object} monthSummary Ergebnis von computeMonthSummary
   * @param {Array<{categoryId:string, limitCents:number}>} limits
   * @returns {Array<{categoryId, limitCents, spentCents, restCents, pct, status}>}
   */
  function computeCategoryBudgetStatus(monthSummary, limits) {
    if (!limits || limits.length === 0) return [];

    const result = [];
    for (const limit of limits) {
      if (limit.limitCents <= 0) continue;

      const spentCents = monthSummary.byCategory[limit.categoryId] || 0;
      const restCents = limit.limitCents - spentCents;
      const pct = Math.round((spentCents / limit.limitCents) * 100);
      let status = 'ok';
      if (pct > 100) status = 'over';
      else if (pct >= 80) status = 'warn';

      result.push({
        categoryId: limit.categoryId,
        limitCents: limit.limitCents,
        spentCents: spentCents,
        restCents: restCents,
        pct: pct,
        status: status
      });
    }

    // Sortierung: absteigend nach pct
    result.sort((a, b) => b.pct - a.pct);
    return result;
  }

  root.Budget = {
    todayISO,
    endOfMonth,
    endOfWeek,
    daysBetween,
    computeReserveCents,
    computeBudget,
    computeMonthSummary,
    computeMonthlyTrend,
    computeSavingsPotential,
    computeCategoryBudgetStatus,
  };
})(typeof window !== 'undefined' ? window : this);
