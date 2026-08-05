/**
 * Unit-Tests ohne externe Abhängigkeiten (keine PDFs nötig).
 *
 * Prüft Backup-Funktionalität, Kategorie-Limits und Suche.
 */
require('fake-indexeddb/auto');
global.window = global;
global.self = global;

const assert = require('assert');

require('../js/db.js');
require('../js/categorization.js');
require('../js/budget.js');
require('../js/search.js');
require('../js/exportData.js');
require('../js/backup.js');

let testsPassed = 0;
let testsFailed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`✓ ${description}`);
    testsPassed++;
  } catch (err) {
    console.error(`✗ ${description}`);
    console.error(`  ${err.message}`);
    testsFailed++;
  }
}

async function runTests() {
  // ========== Backup-Tests ==========
  test('Backup.BACKUP_STORES enthält kategorieBudgets', () => {
    assert(Backup.BACKUP_STORES.includes('kategorieBudgets'));
    assert.strictEqual(Backup.BACKUP_STORES.length, 7);
  });

  test('validateBackup akzeptiert gültiges Backup', () => {
    const valid = {
      app: 'haushaltsbudget',
      schemaVersion: 1,
      stores: { transactions: [] }
    };
    const result = Backup.validateBackup(valid);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.fehler, null);
  });

  test('validateBackup lehnt ungültige App ab', () => {
    const invalid = {
      app: 'wrong',
      schemaVersion: 1,
      stores: {}
    };
    const result = Backup.validateBackup(invalid);
    assert.strictEqual(result.ok, false);
    assert(result.fehler.includes('dieser App'));
  });

  test('validateBackup lehnt zu neue Version ab', () => {
    const invalid = {
      app: 'haushaltsbudget',
      schemaVersion: 99,
      stores: {}
    };
    const result = Backup.validateBackup(invalid);
    assert.strictEqual(result.ok, false);
    assert(result.fehler.includes('neueren'));
  });

  // ========== Backup Rundlauf ==========
  test('Backup-Rundlauf: exportAll -> clear -> importBackup stellt Daten identisch wieder her', async () => {
    // Testdaten schreiben
    await DB.put('transactions', { id: 1, date: '2025-01-15', typ: 'Test', amountCents: -5000, category: 'lebensmittel' });
    await DB.put('fixkosten', { id: 1, name: 'Test', amountCents: -10000, active: true, category: 'wohnen' });
    await DB.put('geplanteAusgaben', { id: 1, name: 'Test', betragCents: -3000, status: 'offen', category: 'shopping' });
    await DB.put('meta', { key: 'currentBalanceCents', value: 50000 });

    // Export
    const backup = await Backup.exportAll(DB);
    assert.strictEqual(backup.app, 'haushaltsbudget');
    assert.strictEqual(backup.stores.transactions.length, 1);
    assert.strictEqual(backup.stores.fixkosten.length, 1);
    assert.strictEqual(backup.stores.geplanteAusgaben.length, 1);
    assert.strictEqual(backup.stores.meta.find(m => m.key === 'currentBalanceCents').value, 50000);

    // Clear & Import
    await Backup.importBackup(DB, backup);

    // Verifizierung
    const restored = await Backup.exportAll(DB);
    assert.deepStrictEqual(restored.stores.transactions, backup.stores.transactions);
    assert.deepStrictEqual(restored.stores.fixkosten, backup.stores.fixkosten);
    assert.deepStrictEqual(restored.stores.geplanteAusgaben, backup.stores.geplanteAusgaben);
    const restoredBalance = restored.stores.meta.find(m => m.key === 'currentBalanceCents');
    assert.strictEqual(restoredBalance.value, 50000);

    // Cleanup
    await DB.clear('transactions');
    await DB.clear('fixkosten');
    await DB.clear('geplanteAusgaben');
    await DB.clear('meta');
  });

  test('Backup-Import mit ungültigem Payload berührt vorhandene Daten nicht', async () => {
    // Original-Daten schreiben
    await DB.put('transactions', { id: 1, date: '2025-01-15', typ: 'Original' });

    // Import mit ungültigem Payload
    const invalid = { app: 'wrong', stores: {} };
    const result = await Backup.importBackup(DB, invalid);
    assert.strictEqual(result.ok, false);

    // Verifizierung: Originaldaten sollten noch da sein
    const remaining = await DB.getAll('transactions');
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].typ, 'Original');

    // Cleanup
    await DB.clear('transactions');
  });

  // ========== Kategorie-Limits Tests ==========
  test('computeCategoryBudgetStatus mit leeren Limits ergibt []', () => {
    const summary = { byCategory: {} };
    const result = Budget.computeCategoryBudgetStatus(summary, []);
    assert.deepStrictEqual(result, []);
  });

  test('computeCategoryBudgetStatus ignoriert Limits mit limitCents <= 0', () => {
    const summary = { byCategory: { lebensmittel: 5000 } };
    const limits = [{ categoryId: 'lebensmittel', limitCents: 0 }];
    const result = Budget.computeCategoryBudgetStatus(summary, limits);
    assert.deepStrictEqual(result, []);
  });

  test('computeCategoryBudgetStatus Status "ok" bei < 80%', () => {
    const summary = { byCategory: { lebensmittel: 6000 } };
    const limits = [{ categoryId: 'lebensmittel', limitCents: 10000 }];
    const result = Budget.computeCategoryBudgetStatus(summary, limits);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].status, 'ok');
    assert.strictEqual(result[0].pct, 60);
    assert.strictEqual(result[0].restCents, 4000);
  });

  test('computeCategoryBudgetStatus Status "warn" bei 80-100%', () => {
    const summary = { byCategory: { lebensmittel: 8000 } };
    const limits = [{ categoryId: 'lebensmittel', limitCents: 10000 }];
    const result = Budget.computeCategoryBudgetStatus(summary, limits);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].status, 'warn');
    assert.strictEqual(result[0].pct, 80);
  });

  test('computeCategoryBudgetStatus Status "over" bei > 100%', () => {
    const summary = { byCategory: { lebensmittel: 12000 } };
    const limits = [{ categoryId: 'lebensmittel', limitCents: 10000 }];
    const result = Budget.computeCategoryBudgetStatus(summary, limits);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].status, 'over');
    assert.strictEqual(result[0].pct, 120);
    assert.strictEqual(result[0].restCents, -2000);
  });

  test('computeCategoryBudgetStatus sortiert absteigend nach pct', () => {
    const summary = { byCategory: { lebensmittel: 4000, wohnen: 8000 } };
    const limits = [
      { categoryId: 'lebensmittel', limitCents: 10000 },
      { categoryId: 'wohnen', limitCents: 10000 }
    ];
    const result = Budget.computeCategoryBudgetStatus(summary, limits);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].categoryId, 'wohnen');
    assert.strictEqual(result[0].pct, 80);
    assert.strictEqual(result[1].categoryId, 'lebensmittel');
    assert.strictEqual(result[1].pct, 40);
  });

  // ========== Suche Tests ==========
  test('Search.filterTransactions mit Monatsfilter', () => {
    const transactions = [
      { id: 1, date: '2025-01-15', typ: 'Test 1', detail: 'Description', category: 'wohnen', amountCents: -5000 },
      { id: 2, date: '2025-02-10', typ: 'Test 2', detail: 'Description', category: 'wohnen', amountCents: -3000 }
    ];
    const result = Search.filterTransactions(transactions, { month: '2025-01' });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 1);
  });

  test('Search.filterTransactions mit Freitextsuche (normalisiert)', () => {
    const transactions = [
      { id: 1, date: '2025-01-15', typ: 'REWE SUPERMARKT', detail: '', category: 'lebensmittel', amountCents: -5000 },
      { id: 2, date: '2025-01-15', typ: 'SHELL TANKSTELLE', detail: '', category: 'shopping', amountCents: -6000 }
    ];
    const result = Search.filterTransactions(transactions, { query: 'rewe' });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 1);
  });

  test('Search.filterTransactions mit Kategoriefilter', () => {
    const transactions = [
      { id: 1, date: '2025-01-15', typ: 'Test', detail: '', category: 'wohnen', amountCents: -5000 },
      { id: 2, date: '2025-01-15', typ: 'Test', detail: '', category: 'lebensmittel', amountCents: -3000 }
    ];
    const result = Search.filterTransactions(transactions, { categoryId: 'lebensmittel' });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 2);
  });

  test('Search.filterTransactions kombiniert alle Filter (UND)', () => {
    const transactions = [
      { id: 1, date: '2025-01-15', typ: 'REWE', detail: '', category: 'lebensmittel', amountCents: -5000 },
      { id: 2, date: '2025-02-15', typ: 'REWE', detail: '', category: 'lebensmittel', amountCents: -3000 },
      { id: 3, date: '2025-01-15', typ: 'SHELL', detail: '', category: 'shopping', amountCents: -6000 }
    ];
    const result = Search.filterTransactions(transactions, {
      month: '2025-01',
      query: 'rewe',
      categoryId: 'lebensmittel'
    });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 1);
  });

  test('Search.sumCents addiert Beträge korrekt', () => {
    const transactions = [
      { id: 1, amountCents: 5000 },
      { id: 2, amountCents: -3000 },
      { id: 3, amountCents: 2000 }
    ];
    const sum = Search.sumCents(transactions);
    assert.strictEqual(sum, 4000);
  });

  test('Search.sumCents auf leerer Liste ist 0', () => {
    const sum = Search.sumCents([]);
    assert.strictEqual(sum, 0);
  });

  // Ergebnisse
  console.log('');
  if (testsFailed === 0) {
    console.log(`Alle Unit-Tests bestanden. (${testsPassed} Tests)`);
    process.exit(0);
  } else {
    console.log(`${testsFailed} Test(s) fehlgeschlagen, ${testsPassed} bestanden.`);
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fehler beim Ausführen der Tests:', err);
  process.exit(1);
});
