/**
 * pdfParser.js
 *
 * Client-seitiger Parser für Kontoauszüge der Frankfurter Sparkasse (PDF).
 * Das Layout ist innerhalb dieser einen Sparkasse konstant über die Zeit,
 * daher deckt dieser Parser gezielt genau dieses eine feste Layout ab.
 *
 * Kein Upload an einen externen Dienst: das gesamte Parsing läuft im
 * Browser (bzw. hier zusätzlich in Node zu Testzwecken) über pdf.js.
 *
 * Modul ist bewusst in zwei Schichten aufgeteilt:
 *  - reine, leicht testbare Funktionen (Zeilen -> Buchungen)
 *  - ein dünner Wrapper, der pdf.js zur Text-Extraktion nutzt
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    root.BudgetPDFParser = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DATE_LINE_RE = /^(\d{2}\.\d{2}\.\d{4})\s*(.*)$/;
  const AMOUNT_TAIL_RE = /(-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/;
  const OPENING_BALANCE_RE = /Kontostand am ([\d.]+),\s*Auszug Nr\.\s*(\d+)\s+(-?\d{1,3}(?:\.\d{3})*,\d{2})/;
  const CLOSING_BALANCE_RE = /Kontostand am ([\d.]+) um/;
  const ACCOUNT_NO_RE = /Konto-Nr\.\s*([\d]+)/;

  // Wiederkehrende Kopf-/Fußzeilen des festen Sparkassen-Layouts.
  // Diese Zeilen enthalten keine Buchungsdaten und werden übersprungen.
  const BOILERPLATE_PREFIXES = [
    'Frankfurter Sparkasse Vorstand', 'Neue Mainzer Str', '60311 Frankfurt',
    'Postanschrift', '60255 Frankfurt', 'S Frankfurter', 'Sparkasse',
    'Frau', 'Herr', 'Ihr Ansprechpartner', 'Telefon 069', 'Digitales',
    'Kontoauszug', 'K onto-Nr', 'Konto-Nr', 'Datum Erläuterung',
    'Der Kontostand kann', 'Rechnungsabschluss', 'Abrechnungszeitraum',
    'Sollzinssätze', 'Die Anpassung', 'Entwicklung:', 'Es handelt sich',
    'Rechnungsnummer', 'Bitte beachten', 'Hinweise zum Kontoauszug',
    'Sehr geehrte', 'bitte prüfen', 'Einwendungen', 'entnehmen Sie',
    'Der angegebene Kontostand', 'Betrag nicht dem', 'Zinsen für die',
    'Rechnungsabschlüsse gelten', 'Einwendungen gegen Rechnungsabschlüsse',
    'Absendung', 'Gutschriften aus', 'Einlösung.', 'Einzugsermächtigungs',
    'wenn sie nicht', 'eingelöst, wenn', 'Bezahltmeldung', 'Bedingungen.',
    'Sparkontoauszüge', 'Dieser Kontoauszug gilt', 'Rechnung im Sinne',
    'Guthaben sind als', 'dem Informationsbogen', 'Dieser Brief wurde',
    'Unsere für den', 'wir Ihnen auf Wunsch', 'Mit freundlichen',
    'Ihre Sparkasse',
  ];

  function isBoilerplate(line) {
    const s = line.trim();
    if (!s) return true;
    return BOILERPLATE_PREFIXES.some((p) => s.startsWith(p));
  }

  /**
   * Wandelt einen Betrag im deutschen Format ("1.234,56" / "-8,99") in Cents (int) um.
   */
  function parseAmountToCents(amountStr) {
    const normalized = amountStr.replace(/\./g, '').replace(',', '.');
    return Math.round(parseFloat(normalized) * 100);
  }

  /**
   * Wandelt ein deutsches Datum "DD.MM.YYYY" in ein ISO-Datum "YYYY-MM-DD" um.
   */
  function germanDateToISO(d) {
    const m = d.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
  }

  /**
   * Extrahiert Buchungen aus einer Liste von Textzeilen (eine Seite/ein
   * gesamter Kontoauszug, Seiten in Lesereihenfolge aneinandergehängt).
   *
   * @param {string[]} lines
   * @returns {{openingBalance: object|null, closingBalance: object|null, accountNumber: string|null, transactions: object[]}}
   */
  function parseStatementLines(lines) {
    let started = false;
    let openingBalance = null;
    let closingBalance = null;
    let accountNumber = null;
    const transactions = [];

    let i = 0;
    const n = lines.length;

    while (i < n) {
      const line = lines[i];

      if (!accountNumber) {
        const am = line.match(ACCOUNT_NO_RE);
        if (am) accountNumber = am[1];
      }

      if (!started) {
        const m = line.match(OPENING_BALANCE_RE);
        if (m) {
          openingBalance = {
            date: germanDateToISO(m[1]),
            auszugNr: m[2],
            balanceCents: parseAmountToCents(m[3]),
          };
          started = true;
        }
        i += 1;
        continue;
      }

      const closeMatch = line.match(CLOSING_BALANCE_RE);
      if (closeMatch) {
        const amtMatch = line.match(AMOUNT_TAIL_RE);
        closingBalance = {
          date: germanDateToISO(closeMatch[1]),
          balanceCents: amtMatch ? parseAmountToCents(amtMatch[1]) : null,
        };
        break;
      }

      const dm = line.match(DATE_LINE_RE);
      if (dm) {
        const date = germanDateToISO(dm[1]);
        const rest = dm[2];
        const amtMatch = rest.match(AMOUNT_TAIL_RE);
        if (amtMatch) {
          const amountCents = parseAmountToCents(amtMatch[1]);
          const typ = rest.slice(0, amtMatch.index).trim();
          const detailParts = [];
          i += 1;
          while (i < n) {
            const nxt = lines[i];
            if (DATE_LINE_RE.test(nxt)) break;
            if (/^Kontostand am/.test(nxt)) break;
            if (isBoilerplate(nxt)) {
              i += 1;
              continue;
            }
            detailParts.push(nxt.trim());
            i += 1;
          }
          transactions.push({
            date,
            typ,
            amountCents,
            detail: detailParts.join(' ').replace(/\s+/g, ' ').trim(),
          });
          continue;
        }
      }
      i += 1;
    }

    return { openingBalance, closingBalance, accountNumber, transactions };
  }

  /**
   * Gruppiert pdf.js-Textitems einer Seite zu Zeilen (nach y-Position) und
   * gibt sie in Lesereihenfolge (oben -> unten, links -> rechts) zurück.
   */
  function itemsToLines(items, yTolerance) {
    yTolerance = yTolerance || 2.5;
    const points = items
      .filter((it) => it.str !== undefined && it.str.trim() !== '')
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
      }));

    points.sort((a, b) => b.y - a.y || a.x - b.x);

    const lines = [];
    let current = null;
    for (const p of points) {
      if (!current || Math.abs(current.y - p.y) > yTolerance) {
        current = { y: p.y, items: [] };
        lines.push(current);
      }
      current.items.push(p);
    }

    return lines.map((line) => {
      line.items.sort((a, b) => a.x - b.x);
      let text = '';
      let lastEndX = null;
      for (const it of line.items) {
        if (lastEndX !== null && it.x - lastEndX > 1) {
          text += ' ';
        }
        text += it.str;
        // grobe Schätzung des rechten Rands (Zeichenbreite unbekannt -> Heuristik)
        lastEndX = it.x + it.str.length * 4.5;
      }
      return text.replace(/\s+/g, ' ').trim();
    });
  }

  /**
   * Extrahiert alle Textzeilen eines gesamten PDF-Dokuments (pdf.js) in
   * Lesereihenfolge (Seite für Seite).
   */
  async function extractLinesFromPDF(pdfjsLib, arrayBuffer) {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const allLines = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const lines = itemsToLines(content.items);
      allLines.push(...lines);
    }
    return allLines;
  }

  /**
   * High-level: PDF (ArrayBuffer) -> geparste Buchungen.
   */
  async function parsePDF(pdfjsLib, arrayBuffer) {
    const lines = await extractLinesFromPDF(pdfjsLib, arrayBuffer);
    return parseStatementLines(lines);
  }

  return {
    parseStatementLines,
    itemsToLines,
    extractLinesFromPDF,
    parsePDF,
    parseAmountToCents,
    germanDateToISO,
  };
});
