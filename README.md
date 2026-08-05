# Haushaltsbudget & Fixkosten-Tracker

Installierbare PWA (HTML/JS, IndexedDB) für Fixkosten, wiederkehrende
Einnahmen (Kindergeld, Gehalt), Kontostand, Wochen-/Monatsbudget und
Sparpotenzial. Kontoauszüge der Frankfurter Sparkasse (PDF) werden
clientseitig importiert und automatisch kategorisiert. Kein Backend, kein
Login, keine Cloud — alle Daten bleiben ausschließlich auf dem Gerät
(IndexedDB im Browser).

Da sich Kontoauszüge realistisch erst zum Monatsende importieren lassen,
kennt die App tagesaktuelle Buchungen im laufenden Monat naturgemäß nicht.
Zwei Funktionen gleichen das aus: der Kontostand lässt sich in der
Übersicht jederzeit manuell setzen ("Bearbeiten" neben dem Kontostand),
und bekanntes, regelmäßig eintreffendes Geld (Kindergeld, Gehalt) wird —
genau wie Fixkosten — als erwartetes Guthaben erkannt bzw. lässt sich
händisch hinterlegen und fließt direkt ins Budget ein.

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

## Datensicherung

Alle Daten dieser App liegen ausschließlich auf dem Gerät (IndexedDB).
Ohne Backup gehen sie verloren, wenn der Browser-Speicher gelöscht wird oder
das Gerät wechselt. Die Backup-Funktion (Tab "Mehr" → "Datensicherung")
exportiert die kompletten Finanzdaten (Buchungen, Fixkosten, geplante Posten,
Kategorisierungsregeln) als JSON-Datei.

Die Backup-Datei enthält deine persönlichen Finanzdaten im Klartext und sollte
entsprechend sicher aufbewahrt werden (verschlüsselter Speicher, sichere Cloud
o.ä.). Sie kann später wieder in die App zurückgespielt werden, um alle Daten
vollständig wiederherzustellen.

## Regressionstest

```
npm install
npm test
```

Führt zuerst Unit-Tests (18 Tests, keine externe Abhängigkeiten) aus, dann
den Integrationstest, der den kompletten Ablauf (PDF-Parsing, Kategorisierung,
Fixkosten-Erkennung, Budget-Berechnung, Abgleich geplanter Ausgaben, manuelle
Buchungen) gegen die PDFs in `sample-data/` prüft. Ohne PDFs dort wird der
Integrationstest übersprungen — die Unit-Tests laufen aber immer.

## Architektur

- `index.html` / `css/styles.css` — UI, Tab-Navigation, Modals
- `js/db.js` — IndexedDB-Datenschicht
- `js/pdfParser.js` — PDF-Parser für das feste Sparkassen-Layout (pdf.js)
- `js/categorization.js` — regelbasierte, lernfähige Kategorisierung (max. 6 Kategorien)
- `js/recurring.js` — Erkennung wiederkehrender Buchungen, sowohl Ausgaben (Fixkosten-Vorschläge) als auch Einnahmen (z. B. Kindergeld, Gehalt)
- `js/planned.js` — geplante Ausgaben *und* Einnahmen + vorzeichensicherer Abgleich mit echten Buchungen
- `js/manual.js` — manuelle Bar-/Spontankäufe + manueller Kontostand-Reset
- `js/budget.js` — Wochen-/Monatsbudget, Sparquote, Monatstrend, Kategorie-Limits
- `js/exportData.js` — Monats-Export als JSON
- `js/backup.js` — Vollbackup und Wiederherstellung aller lokalen Daten
- `js/search.js` — Suche und Filterung in Buchungen
- `js/app.js` — UI-Controller, verdrahtet alles miteinander
- `manifest.json` / `service-worker.js` — PWA-Grundgerüst (offline-fähig, installierbar)

## Sicherheitshinweis

Der App-Code enthält bewusst **keine** echten Kontodaten (keine Namen,
Beträge oder IBANs aus den hochgeladenen PDFs) — nur generische
Kategorisierungsregeln anhand öffentlicher Marken-/Firmennamen. Persönliche
Fixkosten (z. B. Miete, konkrete Empfänger) lernt die App beim ersten
Import lokal in der IndexedDB des jeweiligen Geräts, nie im Repository.
