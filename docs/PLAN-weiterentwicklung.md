# Implementierungsplan — Haushaltsbudget & Fixkosten-Tracker

Stand: Ausbaustufe 2. Die App (Vanilla-JS-PWA, IndexedDB, kein Backend)
läuft bereits: PDF-Import von Sparkassen-Kontoauszügen, lernfähige
Kategorisierung, Fixkosten-/Einnahmen-Erkennung, Wochen-/Monatsbudget,
Sparquote, Monats-Export.

Dieser Plan beschreibt vier Arbeitspakete, die genau in dieser Reihenfolge
umzusetzen sind. Jedes Paket ist einzeln lauffähig, testbar und wird
einzeln committet.

---

## Leitplanken (gelten für alle Pakete)

- **Kein Framework, kein Build-Schritt, keine Laufzeit-Abhängigkeit.** Neue
  JS-Dateien folgen exakt dem vorhandenen IIFE-Muster:
  ```js
  (function (root) {
    'use strict';
    // ...
    root.ModulName = { /* öffentliche Funktionen */ };
  })(typeof window !== 'undefined' ? window : this);
  ```
  Dadurch sind die Module sowohl im Browser (`window.ModulName`) als auch
  im Node-Test (`global.ModulName` nach `require`) verfügbar.
- **Beträge immer als ganzzahlige Cent** (`amountCents`, `limitCents`).
  Nie mit Euro-Floats rechnen. Umrechnung nur an der UI-Grenze:
  `Math.round(parseFloat(eingabe.replace(',', '.')) * 100)`.
- **Alle UI-Texte, Kommentare und Commit-Messages auf Deutsch.**
- **Keine echten Kontodaten** (Namen, IBANs, reale Beträge) in Code, Tests
  oder Commits. Nur generische Beispiele.
- **Kein Netzwerkzugriff.** Kein `fetch`, kein CDN, kein Analytics.
- **Nutzerdaten dürfen nie verlorengehen.** Schema-Änderungen migrieren
  bestehende Installationen, sie löschen nichts.
- **XSS-Schutz beibehalten:** Jeder nutzergelieferte String, der per
  `innerHTML` in die Seite kommt, läuft durch das vorhandene
  `escapeHTML()` bzw. `escapeAttr()` in `js/app.js`.
- **Neue JS-Datei = drei Stellen pflegen:** `index.html` (Script-Tag vor
  `js/app.js`), `service-worker.js` (`CORE_ASSETS`), `README.md`
  (Architektur-Abschnitt).

---

## Arbeitspaket 1 — Vollbackup: Export & Wiederherstellung

**Warum zuerst:** Alle Finanzdaten liegen ausschließlich in der IndexedDB
eines einzigen Geräts. Browser-Daten gelöscht, Handy verloren oder App
deinstalliert bedeutet heute: alles weg, unwiederbringlich. Der vorhandene
Monats-Export (`js/exportData.js`) ist ein Analyse-Auszug, kein Backup — er
enthält weder Fixkosten noch Regeln noch geplante Posten und lässt sich
nicht zurückspielen. Das ist die größte Lücke der App.

### 1.1 Neues Modul `js/backup.js`

Öffentliche API (Signaturen exakt so umsetzen):

```js
root.Backup = {
  BACKUP_STORES,        // Array<string>
  SCHEMA_VERSION,       // Number, Wert: 1
  exportAll,            // async (DB) -> payload
  validateBackup,       // (payload) -> { ok: boolean, fehler: string|null }
  importBackup,         // async (DB, payload) -> { ok, importiert: {store: anzahl}, fehler }
  downloadBackup,       // async (DB) -> payload   (löst den Datei-Download aus)
  readBackupFile,       // async (file) -> payload (File -> geparstes JSON)
};
```

**`BACKUP_STORES`** — genau diese Reihenfolge:
`['transactions', 'fixkosten', 'geplanteAusgaben', 'kategorieRegeln', 'importierteAuszuege', 'meta']`

**`exportAll(DB)`** liest jeden Store mit `DB.getAll(store)` und liefert:

```js
{
  app: 'haushaltsbudget',
  schemaVersion: 1,
  exportedAt: new Date().toISOString(),
  stores: { transactions: [...], fixkosten: [...], /* ... */ }
}
```

Die Datensätze werden **unverändert übernommen, inklusive ihrer `id`**.
Das ist zwingend: `transactions.fixkostenId` und `transactions.plannedId`
verweisen auf diese IDs. Würden beim Wiedereinspielen neue IDs vergeben,
wären alle Verknüpfungen kaputt.

**`validateBackup(payload)`** prüft ohne Schreibzugriff:
- `payload` ist ein Objekt, `payload.app === 'haushaltsbudget'`
  → sonst `{ ok: false, fehler: 'Keine Backup-Datei dieser App.' }`
- `payload.schemaVersion <= SCHEMA_VERSION`
  → sonst `{ ok: false, fehler: 'Backup stammt aus einer neueren App-Version.' }`
- `payload.stores` ist ein Objekt und jeder darin enthaltene Schlüssel aus
  `BACKUP_STORES` trägt ein Array
  → sonst `{ ok: false, fehler: 'Backup-Datei ist beschädigt.' }`
- Fehlende Stores sind **kein** Fehler (Vorwärtskompatibilität): sie
  werden beim Import als leer behandelt.
- Erfolg: `{ ok: true, fehler: null }`

**`importBackup(DB, payload)`** — Modus ist immer **vollständiges
Ersetzen**, kein Zusammenführen. Zusammenführen würde bei
autoIncrement-IDs zu Kollisionen und doppelten Buchungen führen.
1. `validateBackup` aufrufen; bei `ok: false` sofort
   `{ ok: false, importiert: {}, fehler }` zurückgeben, **ohne** irgendetwas
   zu schreiben.
2. Für jeden Store aus `BACKUP_STORES`: `await DB.clear(store)`, dann die
   Datensätze einzeln per `await DB.put(store, datensatz)` schreiben.
   `put` statt `add` verwenden, damit explizit mitgelieferte IDs
   akzeptiert werden.
3. Zurückgeben: `{ ok: true, importiert: { transactions: 42, ... }, fehler: null }`

**`downloadBackup(DB)`** ruft `exportAll` auf und lädt das Ergebnis über
das bereits vorhandene `ExportData.downloadJSON(payload, dateiname)`
herunter. Dateiname:
`` `haushaltsbudget-backup-${new Date().toISOString().slice(0, 10)}.json` ``

**`readBackupFile(file)`** liest ein `File`-Objekt per `await file.text()`
und gibt `JSON.parse(text)` zurück. Wirft die Datei einen Parse-Fehler,
wird er als `Error` mit der Nachricht `'Datei ist kein gültiges JSON.'`
weitergereicht.

`downloadBackup` und `readBackupFile` sind die einzigen Funktionen mit
Browser-Abhängigkeit (DOM bzw. File-API). `exportAll`, `validateBackup`
und `importBackup` müssen frei von DOM-Zugriffen bleiben — nur so sind sie
im Node-Test lauffähig.

### 1.2 UI in `index.html` (View "Einstellungen")

Neuer Abschnitt **direkt vor** `<div class="section-header"><h2>Ignorierte
Fixkosten-Vorschläge</h2></div>` in `<section id="view-einstellungen">`:

```html
<div class="section-header">
  <h2>Datensicherung</h2>
</div>
<p class="hint-text">Alle Daten dieser App liegen ausschließlich auf diesem Gerät. Ohne Backup sind sie verloren, wenn du den Browser-Speicher löschst oder das Gerät wechselst. Die Backup-Datei enthält deine kompletten Finanzdaten — bewahre sie sicher auf.</p>
<div class="card">
  <div class="form-row">
    <button id="btnBackupExport" class="btn btn-secondary btn-sm" type="button">Backup speichern</button>
    <button id="btnBackupImport" class="btn btn-secondary btn-sm" type="button">Backup wiederherstellen</button>
  </div>
  <p id="backupInfo" class="hint-text" style="margin-top:10px"></p>
</div>
```

Zusätzlich neben dem vorhandenen `<input type="file" id="fileInput" ...>`
am Dateiende:

```html
<input type="file" id="backupFileInput" accept="application/json" hidden>
```

Script-Tag `<script src="js/backup.js"></script>` einfügen — **nach**
`js/exportData.js` (Backup nutzt `ExportData.downloadJSON`) und **vor**
`js/app.js`.

### 1.3 Verdrahtung in `js/app.js`

In `wireEvents()` ergänzen:

- Klick auf `#btnBackupExport`:
  `await Backup.downloadBackup(DB);` dann `toast('Backup gespeichert');`
- Klick auf `#btnBackupImport`: öffnet `#backupFileInput` per `.click()`.
- `change` auf `#backupFileInput`:
  1. Datei lesen (`Backup.readBackupFile`), bei Fehler
     `toast('Datei ist kein gültiges JSON.')` und abbrechen.
  2. `Backup.validateBackup(payload)`; bei `ok: false` den Fehlertext als
     Toast zeigen und abbrechen.
  3. **Bestätigung einholen** über ein Modal (Muster:
     `openKontostandModal`), das die Anzahl der enthaltenen Buchungen
     nennt und klar warnt, dass alle aktuellen Daten dieses Geräts ersetzt
     werden. Buttons "Abbrechen" und "Ersetzen". Erst bei "Ersetzen"
     `Backup.importBackup` aufrufen.
  4. Danach `closeModal(); await loadAll(); render();` und
     `toast('Backup wiederhergestellt')`.
  5. In jedem Fall am Ende `e.target.value = ''` setzen, damit dieselbe
     Datei erneut auswählbar bleibt.

In `renderEinstellungen()` am Anfang `#backupInfo` füllen:
`` `${state.transactions.length} Buchungen, ${state.fixkosten.length} Fixkosten, ${state.geplant.length} geplante Posten und ${state.rules.length} Kategorisierungsregeln auf diesem Gerät.` ``

**Ohne Bestätigungsschritt darf der Import nicht auslösbar sein** — er
löscht unwiederbringlich die Daten des Geräts.

### 1.4 Akzeptanzkriterien AP1

- Export erzeugt eine JSON-Datei mit allen sechs Stores.
- Ein Export, der in eine leergeräumte Datenbank zurückgespielt wird,
  stellt Buchungen, Fixkosten, geplante Posten, Regeln, Import-Fingerprints
  und Kontostand **identisch inklusive IDs** wieder her.
- Eine fremde oder beschädigte JSON-Datei wird abgewiesen, **ohne** dass
  vorhandene Daten angetastet werden.
- Der Restore läuft nie ohne ausdrückliche Bestätigung.

---

## Arbeitspaket 2 — Monatliche Kategorie-Budgets

**Warum:** Die App zeigt heute, wohin das Geld geflossen *ist*. Ein Limit
je Kategorie macht daraus Steuerung: sichtbar wird, wie viel im laufenden
Monat noch übrig ist, bevor das Konto es verrät.

### 2.1 Schema-Erweiterung in `js/db.js`

- `DB_VERSION` von `1` auf `2` erhöhen.
- In `onupgradeneeded` einen weiteren Block **nach** dem `meta`-Block
  ergänzen:
  ```js
  if (!db.objectStoreNames.contains('kategorieBudgets')) {
    db.createObjectStore('kategorieBudgets', { keyPath: 'categoryId' });
  }
  ```
  Das vorhandene `if (!db.objectStoreNames.contains(...))`-Muster ist
  bereits versionsübergreifend korrekt: Bestandsnutzer mit Version 1
  bekommen ausschließlich den neuen Store, alle übrigen Daten bleiben
  unangetastet. **Keine bestehende `createObjectStore`-Zeile ändern oder
  entfernen.**
- Datensatzform: `{ categoryId: 'lebensmittel', limitCents: 40000 }`.
  Kein Limit = kein Datensatz (nicht `limitCents: 0` — null wäre ein
  Limit von null Euro).
- `'kategorieBudgets'` in `js/backup.js` zu `BACKUP_STORES` hinzufügen
  (ans Ende), damit Limits mitgesichert werden. `SCHEMA_VERSION` bleibt
  `1`, da `validateBackup` fehlende Stores toleriert und ältere Backups
  damit weiterhin einspielbar sind.

### 2.2 Berechnung in `js/budget.js`

Neue Funktion, exportiert über `root.Budget`:

```js
/**
 * Status der Kategorie-Limits für einen Monat.
 * @param {object} monthSummary Ergebnis von computeMonthSummary
 * @param {Array<{categoryId:string, limitCents:number}>} limits
 * @returns {Array<{categoryId, limitCents, spentCents, restCents, pct, status}>}
 */
function computeCategoryBudgetStatus(monthSummary, limits)
```

Regeln:
- Nur Kategorien mit gesetztem Limit (`limitCents > 0`) erscheinen im
  Ergebnis.
- `spentCents` = `monthSummary.byCategory[categoryId] || 0`. Dieses Feld
  enthält bereits ausschließlich Ausgaben, als **positiver** Betrag —
  siehe `computeMonthSummary`. Nicht erneut das Vorzeichen drehen.
- `restCents = limitCents - spentCents` (darf negativ werden).
- `pct = Math.round((spentCents / limitCents) * 100)`, nicht gedeckelt.
- `status`: `'ok'` bei `pct < 80`, `'warn'` bei `80 <= pct <= 100`,
  `'over'` bei `pct > 100`.
- Sortierung: absteigend nach `pct`.
- Leere `limits` ergeben ein leeres Array — nie `null`, nie eine Exception.

### 2.3 UI: Limits pflegen (View "Einstellungen")

Neuer Abschnitt **nach** dem Datensicherungs-Block, vor "Ignorierte
Fixkosten-Vorschläge":

```html
<div class="section-header">
  <h2>Monatslimits je Kategorie</h2>
</div>
<p class="hint-text">Optionales Ausgabenlimit pro Kalendermonat. Leer lassen heißt: kein Limit. Die Übersicht zeigt dann, wie viel im laufenden Monat noch übrig ist.</p>
<div id="limitsListe" class="stack"></div>
```

In `js/app.js`:
- `state.kategorieBudgets` ergänzen und in `loadAll()` per
  `await DB.getAll('kategorieBudgets')` laden.
- In `renderEinstellungen()` eine Zeile je Kategorie aus
  `Categorization.CATEGORIES` rendern (Muster: `.rule-item` wie bei den
  Kategorisierungsregeln): Farbpunkt, Kategoriename und ein
  `<input class="input" type="number" step="0.01" inputmode="decimal">`
  mit dem aktuellen Limit in Euro (leer, wenn kein Limit gesetzt).
- Beim `change`-Event des Feldes:
  - leerer oder nicht parsbarer Wert bzw. Wert `<= 0` →
    `await DB.delete('kategorieBudgets', categoryId)` (Limit entfernen),
  - sonst `await DB.put('kategorieBudgets', { categoryId, limitCents })`.
  - Danach `await loadAll(); render();` und `toast('Limit gespeichert')`
    bzw. `toast('Limit entfernt')`.

### 2.4 UI: Limits anzeigen (View "Übersicht")

In `renderCategoryChart(container, byCategory, totalExpense)` einen
vierten Parameter `limitStatus` ergänzen (Array aus
`computeCategoryBudgetStatus`); `renderUebersicht()` übergibt ihn.

Für jede Kategorie mit Limit zusätzlich unter dem Balken eine Zeile:
- `status === 'ok'`: `"noch <Rest> von <Limit> übrig"`
- `status === 'warn'`: `"nur noch <Rest> von <Limit> übrig"`
- `status === 'over'`: `"<Betrag> über dem Limit von <Limit>"`
  (Betrag = `Math.abs(restCents)`)

Die Balkenfüllung erhält bei `'warn'` die CSS-Klasse `limit-warn`, bei
`'over'` die Klasse `limit-over`. In `css/styles.css` beide Klassen
ergänzen: `limit-warn` färbt den Balken in `var(--color-warn)`,
`limit-over` in `var(--color-negative)`. Existiert `--color-warn` noch
nicht, im `:root`-Block mit `#E0973C` anlegen (bereits als
Kategoriefarbe im Projekt verwendet).

Kategorien ohne Limit werden unverändert wie bisher dargestellt.

### 2.5 Akzeptanzkriterien AP2

- Bestandsnutzer mit Datenbank-Version 1 können die App nach dem Update
  öffnen, ohne dass Buchungen, Fixkosten oder Regeln verschwinden.
- Ein gesetztes Limit erscheint sofort in der Übersicht.
- Ein geleertes Feld entfernt das Limit vollständig.
- Überschreitung wird farblich und im Text eindeutig gezeigt.

---

## Arbeitspaket 3 — Suche und Filter in den Buchungen

**Warum:** Der Buchungs-Tab listet nur nach Monat. Sobald mehrere
Kontoauszüge importiert sind, ist "Wo habe ich eigentlich bei dm gekauft?"
nicht mehr beantwortbar.

### 3.1 Neues Modul `js/search.js`

```js
/**
 * Filtert Buchungen nach Monat, Freitext und Kategorie.
 * @param {Array} transactions
 * @param {{month?: string|null, query?: string, categoryId?: string|null}} filter
 * @returns {Array} gefilterte Buchungen, Eingabereihenfolge bleibt erhalten
 */
function filterTransactions(transactions, filter)

/** Summe der Beträge (vorzeichenbehaftet). */
function sumCents(transactions)

root.Search = { filterTransactions, sumCents };
```

Regeln für `filterTransactions`:
- `month` (Format `YYYY-MM`): nur Buchungen mit
  `t.date.startsWith(month)`. `null`/leer = alle Monate.
- `query`: Freitext, ohne Beachtung von Groß-/Kleinschreibung, gesucht
  wird in `t.detail` und `t.typ`. Zur Normalisierung `Categorization.norm`
  verwenden — dieses Modul ist im Browser wie im Test bereits geladen.
  Leerer/fehlender Query = kein Textfilter.
- `categoryId`: exakter Vergleich mit `t.category`. `null`/leer = alle
  Kategorien.
- Alle gesetzten Kriterien gelten **gleichzeitig** (UND-Verknüpfung).
- Die Eingabeliste wird **nicht** verändert (kein `sort`, kein `splice`
  auf dem Originalarray).

### 3.2 UI in `index.html` (View "Buchungen")

Unter den vorhandenen `section-header` mit dem Monatsfilter:

```html
<div class="form-row" style="margin-bottom:12px">
  <input id="buchungenSuche" class="input" type="search" placeholder="Suchen (z. B. Supermarkt)" style="flex:1">
  <select id="buchungenKategorieFilter" class="select"></select>
</div>
<p id="buchungenSumme" class="hint-text"></p>
```

Script-Tag `<script src="js/search.js"></script>` vor `js/app.js`
einfügen.

### 3.3 Verdrahtung in `js/app.js`

- `state.searchQuery = ''` und `state.categoryFilter = null` ergänzen.
- In `renderBuchungen()`:
  - Das Kategoriefilter-`<select>` befüllen: erste Option
    `<option value="">Alle Kategorien</option>`, danach je Eintrag aus
    `Categorization.CATEGORIES`. Der aktuell gewählte Wert muss beim
    Neu-Rendern erhalten bleiben.
  - Die Liste über
    `Search.filterTransactions(state.transactions, { month: state.selectedMonth, query: state.searchQuery, categoryId: state.categoryFilter })`
    ermitteln statt über den bisherigen Inline-Filter.
  - `#buchungenSumme` füllen:
    `` `${rows.length} Buchungen · Saldo ${fmtMoney(Search.sumCents(rows))}` ``
    Bei `rows.length === 0` den Text leeren.
  - Der vorhandene Leer-Hinweis `#buchungenLeer` bleibt, sein Text wird
    aber kontextabhängig gesetzt: bei aktiver Suche oder aktivem
    Kategoriefilter `'Keine Buchung passt zu dieser Suche.'`, sonst der
    bisherige Text `'Noch keine Buchungen für diesen Monat.'`.
- In `wireEvents()`:
  - `input`-Event auf `#buchungenSuche` → `state.searchQuery` setzen,
    `renderBuchungen()`. **Beim Neu-Rendern darf der Fokus im Suchfeld
    nicht verlorengehen** — die Liste wird neu aufgebaut, das Suchfeld
    selbst nicht angefasst. Deshalb `#buchungenSuche` und
    `#buchungenKategorieFilter` in `renderBuchungen()` nur befüllen, wenn
    sich ihr Wert tatsächlich vom State unterscheidet.
  - `change`-Event auf `#buchungenKategorieFilter` →
    `state.categoryFilter = e.target.value || null`, `renderBuchungen()`.

### 3.4 Akzeptanzkriterien AP3

- Suche nach einem Empfängertext findet die passenden Buchungen des
  gewählten Monats, unabhängig von Groß-/Kleinschreibung.
- Kategoriefilter und Suche lassen sich kombinieren.
- Die Summenzeile passt sich der gefilterten Auswahl an.
- Beim Tippen springt der Fokus nicht aus dem Suchfeld.

---

## Arbeitspaket 4 — Tests, Cache-Version, Dokumentation

### 4.1 Neue Testdatei `tests/unit.test.js`

Der vorhandene `tests/integration.test.js` braucht echte PDFs in
`sample-data/` und wird ohne sie übersprungen. Die neue Datei muss
**ohne jede externe Datei** laufen.

Aufbau analog zum vorhandenen Test:

```js
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
```

Abzudeckende Fälle:

1. **Backup-Rundlauf:** Testdaten in `transactions`, `fixkosten`,
   `geplanteAusgaben` und `meta` schreiben → `Backup.exportAll(DB)` →
   alle Stores leeren → `Backup.importBackup(DB, payload)` → prüfen, dass
   Anzahl, Beträge **und IDs** identisch sind und
   `DB.getMeta('currentBalanceCents')` wieder stimmt.
2. **Backup-Validierung:** `validateBackup({})` und
   `validateBackup({ app: 'haushaltsbudget', schemaVersion: 99, stores: {} })`
   liefern beide `ok: false`. Anschließend prüfen, dass ein
   `importBackup` mit ungültigem Payload die vorhandenen Daten **nicht**
   verändert hat.
3. **Kategorie-Limits:** `Budget.computeCategoryBudgetStatus` mit einem
   künstlichen `monthSummary` gegen drei Limits testen — je ein Fall
   `ok`, `warn` und `over`; zusätzlich: Kategorie ohne Limit taucht nicht
   auf, leere Limit-Liste ergibt `[]`.
4. **Suche:** `Search.filterTransactions` mit Monatsfilter, Freitext
   (auch in abweichender Schreibweise), Kategoriefilter und Kombination
   aus allen dreien; `Search.sumCents` gegen eine bekannte Summe.

Erwartete Ausgabe bei Erfolg: pro Block eine Zeile `✓ <Beschreibung>` und
am Ende `Alle Unit-Tests bestanden.` Bei Fehlschlag muss der Prozess mit
Exit-Code ungleich 0 enden (`assert` reicht dafür aus).

### 4.2 `package.json`

```json
"scripts": {
  "test": "node tests/unit.test.js && node tests/integration.test.js",
  "test:unit": "node tests/unit.test.js"
}
```

Reihenfolge ist bewusst: Die Unit-Tests laufen immer, der
Integrationstest überspringt sich ohne `sample-data/` selbst.

### 4.3 `service-worker.js`

- `CACHE_NAME` von `haushaltsbudget-v4` auf `haushaltsbudget-v5` erhöhen
  (sonst liefert der Cache Bestandsnutzern weiter die alte App).
- `./js/backup.js` und `./js/search.js` in `CORE_ASSETS` ergänzen.

### 4.4 `README.md`

- Im Architektur-Abschnitt `js/backup.js` und `js/search.js` mit je einer
  Zeile ergänzen.
- Neuer Abschnitt **"Datensicherung"**: erklärt, dass alle Daten nur
  lokal liegen, wo der Backup-Knopf sitzt (Tab "Mehr" →
  "Datensicherung"), und dass die Backup-Datei die vollständigen
  Finanzdaten im Klartext enthält und entsprechend sicher aufbewahrt
  werden sollte.
- Beim Regressionstest-Abschnitt ergänzen, dass `npm test` jetzt zuerst
  die Unit-Tests ohne PDF-Abhängigkeit ausführt.

### 4.5 Akzeptanzkriterien AP4

- `npm test` läuft in einem frisch geklonten Repo **ohne** `sample-data/`
  erfolgreich durch.
- Kein Test benötigt Netzwerkzugriff.

---

## Commits

Ein Commit je Arbeitspaket, deutsche Nachrichten, zum Beispiel:

1. `Vollbackup: Export und Wiederherstellung aller lokalen Daten`
2. `Monatliche Ausgabenlimits je Kategorie`
3. `Suche und Kategoriefilter im Buchungs-Tab`
4. `Unit-Tests ohne PDF-Abhängigkeit, Cache-Version v5, Doku`

Am Ende einmal auf den Branch `claude/executor-sub-agent-haiku-szequf`
pushen (`git push -u origin claude/executor-sub-agent-haiku-szequf`).
Kein Pull Request — der wird, falls gewünscht, separat angelegt.

## Ausdrücklich nicht Teil dieses Plans

Kein Cloud-Sync, keine Verschlüsselung der Backup-Datei, keine weiteren
Kategorien (die Obergrenze von sechs ist eine bewusste
Produktentscheidung), kein Framework-Umbau, keine Änderung am
PDF-Parser und keine Änderung an der Wiederkehr-Erkennung.
