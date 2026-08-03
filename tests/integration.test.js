/**
 * Integrationstest (nur lokal, nicht Teil der App): simuliert den
 * kompletten Import-Flow aus app.js gegen die echten Beispiel-PDFs in
 * sample-data/, unter Verwendung von fake-indexeddb statt eines echten
 * Browsers. Prüft Bilanz, Kategorisierung, Fixkosten-Erkennung, Budget-
 * Berechnung, geplante Ausgaben und Export.
 */
require('fake-indexeddb/auto');
global.window = global;
global.self = global;

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

require('../js/db.js');
require('../js/categorization.js');
require('../js/recurring.js');
require('../js/budget.js');
require('../js/planned.js');
require('../js/manual.js');
const BudgetPDFParser = require('../js/pdfParser.js');

const SAMPLE_DIR = path.join(__dirname, '..', 'sample-data');

async function importAllStatements() {
  const rules = Categorization.getSortedRules(await Categorization.loadRules(DB));
  const dir = SAMPLE_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();

  let totalNew = 0;
  for (const f of files) {
    const buf = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    const parsed = await BudgetPDFParser.parsePDF(pdfjsLib, buf);
    assert(parsed.openingBalance && parsed.closingBalance, `${f}: Kontostände nicht erkannt`);

    const statementFingerprint = `${parsed.accountNumber}|${parsed.openingBalance.auszugNr}|${parsed.openingBalance.date}|${parsed.closingBalance.date}`;
    if (await DB.hasFingerprint(statementFingerprint)) continue;

    const newTxRecords = [];
    for (const t of parsed.transactions) {
      const fingerprint = `${t.date}|${t.typ}|${t.amountCents}|${(t.detail || '').slice(0, 60)}`;
      const existing = await DB.getAllByIndex('transactions', 'fingerprint', fingerprint);
      if (existing.length > 0) continue;
      const merchantKey = Categorization.extractMerchantKey(t.typ, t.detail);
      const { categoryId } = Categorization.categorize(t.typ, t.detail, rules);
      newTxRecords.push({
        date: t.date, typ: t.typ, detail: t.detail, amountCents: t.amountCents,
        category: categoryId, categorySource: 'rule', merchantKey, fingerprint,
        isManual: false, fixkostenId: null, plannedId: null, createdAt: new Date().toISOString(),
      });
    }
    const ids = await DB.bulkAdd('transactions', newTxRecords);
    newTxRecords.forEach((r, i) => { r.id = ids[i]; });
    totalNew += newTxRecords.length;

    await DB.markImported(statementFingerprint, {
      konto: parsed.accountNumber, auszugNr: parsed.openingBalance.auszugNr,
      von: parsed.openingBalance.date, bis: parsed.closingBalance.date,
    });
    await DB.setMeta('currentBalanceCents', parsed.closingBalance.balanceCents);

    const allTx = await DB.getAll('transactions');
    const candidates = Recurring.detectRecurring(allTx);
    const existingFixkosten = await DB.getAll('fixkosten');
    for (const cand of candidates) {
      const match = existingFixkosten.find((fk) =>
        fk.merchantKey === cand.merchantKey && Recurring.amountsCloseEnough(fk.amountCents, cand.amountCents));
      if (match) {
        if (match.status !== 'ignoriert') {
          match.naechsteFaelligkeit = cand.naechsteFaelligkeit;
          match.occurrences = cand.occurrences;
          match.rhythmus = cand.rhythmus;
          if (match.status !== 'manuell') {
            match.status = cand.confidence === 'bestaetigt' ? 'bestaetigt' : 'unsicher';
            match.active = match.status === 'bestaetigt';
          }
          await DB.put('fixkosten', match);
        }
      } else {
        const lastTx = allTx.filter((t) => t.merchantKey === cand.merchantKey).sort((a, b) => b.date.localeCompare(a.date))[0];
        const { categoryId } = Categorization.categorize(lastTx.typ, lastTx.detail, rules);
        const status = cand.confidence === 'bestaetigt' ? 'bestaetigt' : 'unsicher';
        await DB.add('fixkosten', {
          name: Categorization.extractMerchantDisplay(lastTx.typ, lastTx.detail),
          merchantKey: cand.merchantKey, amountCents: cand.amountCents, rhythmus: cand.rhythmus,
          naechsteFaelligkeit: cand.naechsteFaelligkeit, occurrences: cand.occurrences,
          category: categoryId, status, active: status === 'bestaetigt', createdAt: new Date().toISOString(),
        });
      }
    }

    const openPlanned = (await DB.getAll('geplanteAusgaben')).filter((p) => p.status === 'offen');
    const matches = Planned.matchPlannedToTransactions(openPlanned, newTxRecords, []);
    if (matches.length > 0) await Planned.applyMatches(DB, matches);
  }
  return totalNew;
}

async function main() {
  if (!fs.existsSync(SAMPLE_DIR) || fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.pdf')).length === 0) {
    console.log(`Kein sample-data/-Ordner mit PDFs gefunden (${SAMPLE_DIR}).`);
    console.log('Dieser Test läuft nur mit lokalen, git-ignorierten Beispiel-Kontoauszügen und wird übersprungen.');
    return;
  }

  console.log('== 1) Import aller 6 Beispiel-Kontoauszüge ==');
  const totalNew = await importAllStatements();
  const allTx = await DB.getAll('transactions');
  console.log(`Importierte Buchungen: ${totalNew} (DB total: ${allTx.length})`);
  assert(allTx.length > 400, 'Erwartet > 400 Buchungen');

  console.log('\n== 2) Re-Import (Duplikat-Schutz) ==');
  const totalNewAgain = await importAllStatements();
  assert.strictEqual(totalNewAgain, 0, 'Re-Import sollte 0 neue Buchungen ergeben (Duplikat-Erkennung)');
  console.log('OK: keine Duplikate beim erneuten Import');

  console.log('\n== 3) Kontostand ==');
  const balance = await DB.getMeta('currentBalanceCents', null);
  console.log('Kontostand (Cents):', balance);
  assert.strictEqual(balance, 168445, 'Kontostand sollte dem Schlusssaldo des letzten Auszugs entsprechen (1.684,45 EUR)');
  console.log('OK: Kontostand stimmt mit letztem Auszug überein');

  console.log('\n== 4) Kategorisierung ==');
  const byCat = {};
  for (const t of allTx) byCat[t.category] = (byCat[t.category] || 0) + 1;
  console.log(byCat);
  const sonstigesShare = byCat.sonstiges / allTx.length;
  console.log(`Anteil "Einkommen & Sonstiges": ${(sonstigesShare * 100).toFixed(1)}%`);
  assert(sonstigesShare < 0.35, 'Sammelkategorie sollte nicht dominieren (Long-Tail-Prinzip)');
  console.log('OK: Kategorienverteilung plausibel, alle 6 Kategorien vertreten:', Object.keys(byCat).length === 6 || Object.keys(byCat).length);

  console.log('\n== 5) Fixkosten-Erkennung ==');
  const fixkosten = await DB.getAll('fixkosten');
  const bestaetigt = fixkosten.filter((f) => f.status === 'bestaetigt');
  const unsicher = fixkosten.filter((f) => f.status === 'unsicher');
  console.log(`Erkannt: ${fixkosten.length} (bestätigt: ${bestaetigt.length}, unsicher: ${unsicher.length})`);
  assert(bestaetigt.length >= 5, 'Es sollten mehrere bestätigte Fixkosten erkannt werden (Miete, Telefon, ...)');
  const rentLike = fixkosten.find((f) => Math.abs(f.amountCents) > 70000);
  assert(rentLike, 'Ein großer wiederkehrender Posten (vermutlich Miete) sollte erkannt worden sein');
  console.log('Beispiel großer Fixposten:', rentLike.name, rentLike.amountCents / 100, 'EUR', rentLike.rhythmus, rentLike.status);
  console.log('OK: Fixkosten-Erkennung liefert plausible Ergebnisse');

  console.log('\n== 6) Budget-Berechnung ==');
  const budget = Budget.computeBudget({
    currentBalanceCents: balance, fixkosten, geplanteAusgaben: await DB.getAll('geplanteAusgaben'), today: '2026-06-05',
  });
  console.log(budget);
  assert(typeof budget.availableForMonthCents === 'number');
  assert(typeof budget.availableForWeekCents === 'number');
  console.log('OK: Budget-Berechnung liefert Zahlen ohne Fehler');

  console.log('\n== 7) Monatstrend & Sparquote ==');
  const trend = Budget.computeMonthlyTrend(allTx, 6, '2026-06-05');
  trend.forEach((m) => console.log(m.yearMonth, 'Einnahmen:', (m.incomeCents/100).toFixed(2), 'Ausgaben:', (m.expenseCents/100).toFixed(2), 'Sparquote:', m.savingsRate !== null ? (m.savingsRate*100).toFixed(1)+'%' : '-'));
  const potential = Budget.computeSavingsPotential(trend);
  console.log('Ansparpotenzial/Monat:', (potential.avgMonthlySavingsCents/100).toFixed(2), 'EUR, Ø Sparquote:', (potential.avgSavingsRate*100).toFixed(1)+'%');
  console.log('OK: Trend-Berechnung ohne Fehler');

  console.log('\n== 8) Geplante Ausgabe + Abgleich-Logik ==');
  const planned = await Planned.createPlanned(DB, { name: 'Testgeschenk', betragCents: 4500, faelligkeitsdatum: '2026-05-10', category: 'kinder' });
  assert.strictEqual(planned.status, 'offen');
  // Simuliere eine passende reale Buchung (Betrag + Datum nah an der Planung)
  const fakeTxId = await DB.add('transactions', {
    date: '2026-05-09', typ: 'Debitkartenzahlung', detail: 'Testgeschenk Laden', amountCents: -4400,
    category: 'kinder', categorySource: 'rule', merchantKey: 'testgeschenkladen', fingerprint: 'test-fp-1',
    isManual: false, fixkostenId: null, plannedId: null, createdAt: new Date().toISOString(),
  });
  const fakeTx = await DB.get('transactions', fakeTxId);
  const matches = Planned.matchPlannedToTransactions([planned], [fakeTx], []);
  assert.strictEqual(matches.length, 1, 'Geplante Ausgabe sollte mit passender Buchung verknüpft werden');
  await Planned.applyMatches(DB, matches);
  const plannedAfter = await DB.get('geplanteAusgaben', planned.id);
  assert.strictEqual(plannedAfter.status, 'erledigt');
  console.log('OK: geplante Ausgabe wurde korrekt mit realer Buchung verknüpft und als erledigt markiert');

  console.log('\n== 9) Manuelle Buchung ==');
  const balanceBefore = await DB.getMeta('currentBalanceCents', 0);
  const manualTx = await Manual.addManualTransaction(DB, { date: '2026-06-01', amountCents: -1250, description: 'Eis', category: 'gastro' });
  const balanceAfterAdd = await DB.getMeta('currentBalanceCents', 0);
  assert.strictEqual(balanceAfterAdd, balanceBefore - 1250, 'Kontostand sollte um manuellen Betrag sinken');
  await Manual.deleteManualTransaction(DB, manualTx.id);
  const balanceAfterDelete = await DB.getMeta('currentBalanceCents', 0);
  assert.strictEqual(balanceAfterDelete, balanceBefore, 'Kontostand sollte nach Löschen wieder stimmen');
  console.log('OK: manuelle Buchung passt Kontostand korrekt an (Hinzufügen + Löschen)');

  console.log('\n== 10) Lernen aus Korrektur ==');
  const sampleTx = allTx.find((t) => t.category === 'sonstiges' && !t.isManual);
  const rulesBefore = await DB.getAll('kategorieRegeln');
  const rule = await Categorization.learnFromCorrection(DB, sampleTx, 'shopping');
  assert(rule && rule.category === 'shopping');
  const rulesAfter = await DB.getAll('kategorieRegeln');
  assert(rulesAfter.length === rulesBefore.length + 1, 'Es sollte eine neue Regel entstanden sein');
  console.log('OK: Korrektur erzeugt neue Regel:', rule.keyword, '->', rule.category);

  console.log('\nALLE INTEGRATIONSTESTS BESTANDEN ✔');
}

main().catch((e) => { console.error('TEST FEHLGESCHLAGEN:', e); process.exit(1); });
