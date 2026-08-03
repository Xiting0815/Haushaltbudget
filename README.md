# Haushaltsbudget & Fixkosten-Tracker

Installierbare PWA (HTML/JS, IndexedDB) für Fixkosten, Kontostand, Wochen-/
Monatsbudget und Sparpotenzial. Kontoauszüge der Frankfurter Sparkasse (PDF)
werden clientseitig importiert und automatisch kategorisiert. Kein Backend,
kein Login, keine Cloud — alle Daten bleiben ausschließlich auf dem Gerät
(IndexedDB im Browser).

## Lokal testen

Service Worker (und damit "Installierbarkeit") funktionieren nur über
`https://` oder `http://localhost` — nicht über `file://`. Zum Testen reicht
ein einfacher lokaler Server im Projektordner:

```
python3 -m http.server 8080
# oder: npx serve .
```

Danach `http://localhost:8080` im Browser öffnen (auf dem Handy: Chrome ->
Menü -> "Zum Startbildschirm hinzufügen").

## Echte Kontoauszüge zum Entwickeln/Testen

PDF-Kontoauszüge gehören in `sample-data/` — dieser Ordner ist in
`.gitignore` eingetragen und wird **nie** committet. Lege dort eigene
Beispiel-Auszüge ab, um den Import in der App oder den Regressionstest
(`npm test`) gegen echte Daten zu prüfen.

## Regressionstest

```
npm install
npm test
```

Prüft den kompletten Ablauf (PDF-Parsing, Kategorisierung, Fixkosten-
Erkennung, Budget-Berechnung, Abgleich geplanter Ausgaben, manuelle
Buchungen) gegen die PDFs in `sample-data/`, per `fake-indexeddb` ohne
echten Browser. Ohne PDFs dort wird der Test übersprungen.

## Architektur

- `index.html` / `css/styles.css` — UI, Tab-Navigation, Modals
- `js/db.js` — IndexedDB-Datenschicht
- `js/pdfParser.js` — PDF-Parser für das feste Sparkassen-Layout (pdf.js)
- `js/categorization.js` — regelbasierte, lernfähige Kategorisierung (max. 6 Kategorien)
- `js/recurring.js` — Erkennung wiederkehrender Buchungen (Fixkosten-Vorschläge)
- `js/planned.js` — geplante Ausgaben + Abgleich mit echten Buchungen
- `js/manual.js` — manuelle Bar-/Spontankäufe
- `js/budget.js` — Wochen-/Monatsbudget, Sparquote, Monatstrend
- `js/exportData.js` — Monats-Export als JSON
- `js/app.js` — UI-Controller, verdrahtet alles miteinander
- `manifest.json` / `service-worker.js` — PWA-Grundgerüst (offline-fähig, installierbar)

## Sicherheitshinweis

Der App-Code enthält bewusst **keine** echten Kontodaten (keine Namen,
Beträge oder IBANs aus den hochgeladenen PDFs) — nur generische
Kategorisierungsregeln anhand öffentlicher Marken-/Firmennamen. Persönliche
Fixkosten (z. B. Miete, konkrete Empfänger) lernt die App beim ersten
Import lokal in der IndexedDB des jeweiligen Geräts, nie im Repository.
