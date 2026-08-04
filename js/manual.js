/**
 * manual.js
 *
 * Manuelle Buchungen für Bar-/Spontankäufe (analog zum Schwesterprojekt
 * CashControl). Diese wirken sich sofort auf den getrackten Kontostand
 * aus; sobald ein neuer Kontoauszug importiert wird, setzt dessen
 * Schlusssaldo den Kontostand ohnehin wieder auf den bankseitig
 * verbindlichen Wert zurück (siehe app.js/importStatement).
 *
 * Zusätzlich: manueller Kontostand-Reset (setBalanceManually). Kontoauszüge
 * lassen sich realistisch erst zum Monatsende importieren — bis dahin kennt
 * die App tagesaktuelle Bewegungen nicht. Damit der Nutzer den getrackten
 * Kontostand trotzdem jederzeit "bereinigen" kann (z. B. nach Blick in die
 * Banking-App), lässt sich der Stand hier direkt setzen, statt auf den
 * nächsten Import warten zu müssen.
 */
(function (root) {
  'use strict';

  async function addManualTransaction(DB, { date, amountCents, description, category }) {
    const t = {
      date,
      typ: 'Manuelle Buchung',
      detail: description || '',
      amountCents,
      category: category || Categorization.DEFAULT_CATEGORY_ID,
      categorySource: 'manual',
      merchantKey: null,
      isManual: true,
      fixkostenId: null,
      plannedId: null,
      importId: null,
      createdAt: new Date().toISOString(),
    };
    const id = await DB.add('transactions', t);
    await adjustBalance(DB, amountCents);
    return { ...t, id };
  }

  async function deleteManualTransaction(DB, id) {
    const t = await DB.get('transactions', id);
    if (!t) return;
    await DB.delete('transactions', id);
    await adjustBalance(DB, -t.amountCents);
  }

  async function updateManualTransaction(DB, id, changes) {
    const t = await DB.get('transactions', id);
    if (!t) return;
    const oldAmount = t.amountCents;
    Object.assign(t, changes);
    await DB.put('transactions', t);
    if (changes.amountCents !== undefined && changes.amountCents !== oldAmount) {
      await adjustBalance(DB, changes.amountCents - oldAmount);
    }
    return t;
  }

  async function adjustBalance(DB, deltaCents) {
    const current = await DB.getMeta('currentBalanceCents', 0);
    await DB.setMeta('currentBalanceCents', current + deltaCents);
  }

  /**
   * Setzt den getrackten Kontostand direkt auf einen vom Nutzer
   * eingegebenen Wert (z. B. abgelesen aus der Banking-App), unabhängig
   * von importierten Kontoauszügen. Markiert die Quelle als "manuell" mit
   * heutigem Datum, damit die Übersicht transparent zeigt, dass der Stand
   * nicht (mehr) aus einem Auszug stammt.
   */
  async function setBalanceManually(DB, newBalanceCents, dateISO) {
    await DB.setMeta('currentBalanceCents', newBalanceCents);
    await DB.setMeta('currentBalanceSource', 'manual');
    await DB.setMeta('currentBalanceDate', dateISO || new Date().toISOString().slice(0, 10));
  }

  root.Manual = { addManualTransaction, deleteManualTransaction, updateManualTransaction, setBalanceManually };
})(typeof window !== 'undefined' ? window : this);
