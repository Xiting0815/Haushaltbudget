/**
 * exportData.js
 *
 * Export einzelner Monate (nicht nur Vollbackup) als JSON, damit die Daten
 * z. B. später in einer separaten Analyse-Sitzung auf Muster oder
 * Auffälligkeiten geprüft werden können.
 */
(function (root) {
  'use strict';

  async function exportMonth(DB, yearMonth) {
    const all = await DB.getAll('transactions');
    const rows = all.filter((t) => t.date.startsWith(yearMonth));
    const summary = Budget.computeMonthSummary(all, yearMonth);

    const payload = {
      exportedAt: new Date().toISOString(),
      monat: yearMonth,
      zusammenfassung: {
        einnahmenCents: summary.incomeCents,
        ausgabenCents: summary.expenseCents,
        sparbetragCents: summary.savingsCents,
        sparquote: summary.savingsRate,
        nachKategorie: summary.byCategory,
      },
      buchungen: rows.map((t) => ({
        datum: t.date,
        typ: t.typ,
        beschreibung: t.detail,
        betragCents: t.amountCents,
        kategorie: t.category,
        manuell: !!t.isManual,
      })),
    };
    return payload;
  }

  function downloadJSON(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportMonthAndDownload(DB, yearMonth) {
    const payload = await exportMonth(DB, yearMonth);
    downloadJSON(payload, `budget-export-${yearMonth}.json`);
    return payload;
  }

  root.ExportData = { exportMonth, exportMonthAndDownload, downloadJSON };
})(typeof window !== 'undefined' ? window : this);
