/**
 * manual.js
 *
 * Manuelle Buchungen für Bar-/Spontankäufe (analog zum Schwesterprojekt
 * CashControl). Diese wirken sich sofort auf den getrackten Kontostand
 * aus; sobald ein neuer Kontoauszug importiert wird, setzt dessen
 * Schlusssaldo den Kontostand ohnehin wieder auf den bankseitig
 * verbindlichen Wert zurück (siehe app.js/importStatement).
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

  root.Manual = { addManualTransaction, deleteManualTransaction, updateManualTransaction };
})(typeof window !== 'undefined' ? window : this);
