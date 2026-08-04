/**
 * categorization.js
 *
 * Lokale, regelbasierte, lernfähige Kategorisierung — bewusst ohne
 * LLM-/API-Aufruf (siehe Projekt-Brief). Maximal 6 Kategorien, davon eine
 * Sammelkategorie für alles, was sich nicht eindeutig zuordnen lässt.
 *
 * Die Regeln (Schlüsselwort -> Kategorie) sind für den Nutzer einsehbar
 * und editierbar (keine Black Box) und werden in kategorieRegeln in der
 * IndexedDB gehalten. Beim ersten Start wird dieses Standard-Set geladen.
 * Wird eine Buchung manuell umkategorisiert, entsteht daraus automatisch
 * eine neue, künftig greifende Regel (siehe learnFromCorrection).
 */
(function (root) {
  'use strict';

  const CATEGORIES = [
    { id: 'wohnen', name: 'Wohnen & Fixkosten', color: '#5B6ABF', icon: 'home' },
    { id: 'lebensmittel', name: 'Lebensmittel & Drogerie', color: '#3FA66B', icon: 'cart' },
    { id: 'kinder', name: 'Kinder & Familie', color: '#E0973C', icon: 'family' },
    { id: 'gastro', name: 'Gastronomie & Freizeit', color: '#D9647C', icon: 'cup' },
    { id: 'shopping', name: 'Shopping & Einrichtung', color: '#8C6FC9', icon: 'bag' },
    { id: 'sonstiges', name: 'Einkommen & Sonstiges', color: '#8B93A1', icon: 'dots' },
  ];

  const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  const DEFAULT_CATEGORY_ID = 'sonstiges';

  // Generisches Standard-Regelwerk, abgeleitet aus der Analyse realer
  // Kontoauszüge (nur allgemeine Marken-/Branchenbegriffe — keine
  // personenbezogenen Namen, siehe Sicherheitshinweis im Projekt-Brief).
  // Nutzerspezifische Empfänger lernt die App lokal aus Korrekturen.
  const DEFAULT_RULES = [
    // Wohnen & Fixkosten
    ['vodafone', 'wohnen'], ['telekom', 'wohnen'], ['congstar', 'wohnen'],
    ['drillisch', 'wohnen'], ['1&1', 'wohnen'], ['o2 ', 'wohnen'],
    ['generali', 'wohnen'], ['allianz', 'wohnen'], ['axa', 'wohnen'],
    ['ergo versicherung', 'wohnen'], ['huk-coburg', 'wohnen'], ['huk24', 'wohnen'],
    ['debeka', 'wohnen'], ['versicherung', 'wohnen'], ['hausverwaltung', 'wohnen'],
    ['genossenschaft', 'wohnen'], ['nebenkosten', 'wohnen'], ['hausgeld', 'wohnen'],
    ['stadtwerke', 'wohnen'], ['-werke gmbh', 'wohnen'], ['energieversorgung', 'wohnen'],
    ['sparplan', 'wohnen'], ['fondssparplan', 'wohnen'], ['bausparen', 'wohnen'],
    ['entgelt spk', 'wohnen'], ['spk.-card', 'wohnen'], ['kontoführungsgebühr', 'wohnen'],
    ['rundfunkbeitrag', 'wohnen'], ['gez ', 'wohnen'],

    // Lebensmittel & Drogerie
    ['rewe', 'lebensmittel'], ['netto marken', 'lebensmittel'], ['netto-online', 'lebensmittel'],
    ['edeka', 'lebensmittel'], ['aldi', 'lebensmittel'], ['lidl', 'lebensmittel'],
    ['kaufland', 'lebensmittel'], ['penny', 'lebensmittel'], ['real,-', 'lebensmittel'],
    ['tegut', 'lebensmittel'], ['globus', 'lebensmittel'], ['nahkauf', 'lebensmittel'],
    ['dm drogerie', 'lebensmittel'], ['dm-drogerie', 'lebensmittel'], ['rossmann', 'lebensmittel'],
    ['müller drogerie', 'lebensmittel'], ['budni', 'lebensmittel'], ['apotheke', 'lebensmittel'],
    ['bäckerei', 'lebensmittel'], ['baecker', 'lebensmittel'], ['metzgerei', 'lebensmittel'],
    ['fleischerei', 'lebensmittel'], ['e-center', 'lebensmittel'], ['norma', 'lebensmittel'],
    ['denns biomarkt', 'lebensmittel'], ['alnatura', 'lebensmittel'],

    // Kinder & Familie
    ['kindergarten', 'kinder'], ['kindertagesstätte', 'kinder'], [' kita ', 'kinder'],
    ['familienkasse', 'kinder'], ['kindergeld', 'kinder'], ['jobcenter', 'kinder'], ['unterhalt', 'kinder'],
    ['schulbedarf', 'kinder'], ['kinderbetreuung', 'kinder'], ['zoo ', 'kinder'],
    ['movie park', 'kinder'], ['europa-park', 'kinder'], ['europapark', 'kinder'],
    ['legoland', 'kinder'], ['spielplatz', 'kinder'], ['kids playland', 'kinder'],
    ['jugendamt', 'kinder'], ['nachhilfe', 'kinder'], ['lerntherapie', 'kinder'],

    // Gastronomie & Freizeit
    ['restaurant', 'gastro'], ['mcdonalds', 'gastro'], ['burger king', 'gastro'],
    ['kfc', 'gastro'], ['subway', 'gastro'], ['starbucks', 'gastro'],
    ['cafe ', 'gastro'], ['café', 'gastro'], ['kinopolis', 'gastro'],
    ['cinestar', 'gastro'], ['cinemaxx', 'gastro'], ['fitnessstudio', 'gastro'],
    ['mcfit', 'gastro'], ['clever fit', 'gastro'], ['schwimmbad', 'gastro'],
    ['therme', 'gastro'], ['freizeitpark', 'gastro'], ['imbiss', 'gastro'],
    ['pizzeria', 'gastro'], ['eiscafe', 'gastro'], ['gelato', 'gastro'],
    ['lieferando', 'gastro'], ['takeaway', 'gastro'], ['uber eats', 'gastro'],
    ['wolt ', 'gastro'],

    // Shopping & Einrichtung
    ['amazon', 'shopping'], ['zalando', 'shopping'], ['ebay', 'shopping'],
    ['ikea', 'shopping'], ['poco einrichtung', 'shopping'], ['mömax', 'shopping'],
    ['moemax', 'shopping'], ['xxxlutz', 'shopping'], ['roller möbel', 'shopping'],
    ['h&m', 'shopping'], ['hennes', 'shopping'], ['zara', 'shopping'],
    ['c&a', 'shopping'], ['primark', 'shopping'], ['tk maxx', 'shopping'],
    ['tkmaxx', 'shopping'], ['new yorker', 'shopping'], ['deichmann', 'shopping'],
    ['woolworth', 'shopping'], ['tedi', 'shopping'], [' kik ', 'shopping'],
    ['jysk', 'shopping'], ['bauhaus', 'shopping'], ['hornbach', 'shopping'],
    ['obi baumarkt', 'shopping'], ['dehner', 'shopping'], ['media markt', 'shopping'],
    ['mediamarkt', 'shopping'], ['saturn', 'shopping'], ['decathlon', 'shopping'],
    ['shein', 'shopping'], ['tiktok shop', 'shopping'], ['ernstings', 'shopping'],

    // Einkommen & Sonstiges
    ['lohn', 'sonstiges'], ['gehalt', 'sonstiges'], ['krankenkasse', 'sonstiges'],
    ['finanzamt', 'sonstiges'], ['steuererstattung', 'sonstiges'], ['rente', 'sonstiges'],
    ['arbeitsagentur', 'sonstiges'], ['bundesagentur für arbeit', 'sonstiges'],
  ];

  function norm(s) {
    return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function normNoSpace(s) {
    return (s || '').toLowerCase().replace(/\s+/g, '');
  }

  /**
   * SEPA-Gläubiger-ID aus dem Verwendungszweck extrahieren (nur bei
   * Lastschriften vorhanden). Anders als der Name vermuten lässt, steht in
   * den Kontoauszügen keine IBAN des Zahlungsempfängers — aber die
   * Gläubiger-ID ist eine feste, eindeutige SEPA-Kennung des
   * Rechnungsstellers und damit ein deutlich zuverlässigerer Schlüssel für
   * die Wiederkehr-Erkennung als der reine Text-Abgleich.
   */
  function extractGlaeubigerId(detail) {
    const m = (detail || '').match(/Gl[äa]ubiger-?ID:?\s*([A-Z]{2}\s?\d{2}[A-Z0-9]{3,35})/i);
    if (!m) return null;
    return m[1].replace(/\s+/g, '').toUpperCase();
  }

  /**
   * Best-effort-Extraktion eines "Empfänger/Absender"-Schlüssels aus
   * Erläuterung + Verwendungszweck, für Gruppierung (Wiederkehr-Erkennung)
   * und als Basis für gelernte Regeln.
   */
  function extractMerchantCandidate(typ, detail) {
    const t = norm(typ);
    const d = detail || '';
    let candidate;
    if (t.includes('debitkartenzahlung') || t.includes('barausz') || t.includes('bargeldausz')) {
      if (d.includes('/')) {
        candidate = d.split('/')[0];
      } else {
        // Älteres ELV-Kartenterminal-Format ohne "//Ort/DE"-Trenner, z. B.
        // "WOOLWORTH GMBH ELV61479844 30.01 19.12 ME2 IC-...": am
        // Terminal-Code bzw. an der Datumsangabe abschneiden.
        const stop = d.search(/\bELV\d+|\d{2}\.\d{2}\s+\d{2}[.:]\d{2}/i);
        candidate = stop >= 0 ? d.slice(0, stop) : d;
      }
    } else if (t.includes('lastschrift')) {
      const digitMatch = d.match(/\d{4,}/);
      let cut = digitMatch ? d.slice(0, digitMatch.index) : d;
      cut = cut.split(/Gläubiger-ID/i)[0];
      candidate = cut;
    } else if (t.includes('überweisung') || t.includes('gutschrift') || t.includes('dauerauftrag')) {
      const stop = d.search(/DATUM|Gläubiger-ID|Vermogens|Vermögens/i);
      candidate = stop >= 0 ? d.slice(0, stop) : d;
    } else {
      candidate = d;
    }
    candidate = (candidate || '').replace(/[,.\-\s]+$/, '').trim();
    if (!candidate) candidate = typ || '';
    return candidate;
  }

  function extractMerchantKey(typ, detail) {
    // Gläubiger-ID hat Vorrang — aber nur bei echten Lastschrift-/
    // Dauerauftrags-Mandaten. Bei Kartenzahlungen (Debitkartenzahlung)
    // steht dank des ELV-Verfahrens manchmal ebenfalls eine Gläubiger-ID im
    // Referenztext, die dann aber nur die Zahlungsabwicklung des
    // *Geschäfts* identifiziert (z. B. jeder Woolworth-Einkauf per Karte
    // trägt dieselbe ID) — kein Hinweis auf eine wiederkehrende Buchung
    // dieses einen Kaufs. Daher nur bei Lastschrift/Dauerauftrag verwenden.
    const t = norm(typ);
    if (t.includes('lastschrift') || t.includes('dauerauftrag')) {
      const glaeubigerId = extractGlaeubigerId(detail);
      if (glaeubigerId) return normNoSpace(glaeubigerId);
    }
    const candidate = extractMerchantCandidate(typ, detail);
    return normNoSpace(candidate).slice(0, 48);
  }

  /**
   * Wie extractMerchantKey, aber als lesbarer Anzeigename (Groß-/
   * Kleinschreibung und Leerzeichen bleiben erhalten), für UI-Vorschläge
   * bei neu erkannten Fixkosten.
   */
  function extractMerchantDisplay(typ, detail) {
    const candidate = extractMerchantCandidate(typ, detail);
    const cleaned = candidate.replace(/\s+/g, ' ').trim();
    return cleaned.length > 42 ? `${cleaned.slice(0, 42)}…` : cleaned;
  }

  /**
   * Ermittelt die Kategorie für eine Buchung anhand der übergebenen Regeln.
   * @param {string} typ
   * @param {string} detail
   * @param {Array<{keyword:string, category:string}>} rules
   * @returns {{categoryId: string, matchedKeyword: string|null}}
   */
  function categorize(typ, detail, rules) {
    const haystack = normNoSpace(`${typ} ${detail}`);
    // Nutzer-gelernte Regeln haben Vorrang vor den Standardregeln, damit
    // Korrekturen zuverlässig greifen (rules sind vorsortiert, siehe
    // getSortedRules).
    for (const rule of rules) {
      const kw = normNoSpace(rule.keyword);
      if (kw && haystack.includes(kw)) {
        return { categoryId: rule.category, matchedKeyword: rule.keyword };
      }
    }
    return { categoryId: DEFAULT_CATEGORY_ID, matchedKeyword: null };
  }

  async function loadRules(DB) {
    const existing = await DB.getAll('kategorieRegeln');
    if (existing.length > 0) return existing;
    // Erststart: Standard-Regelwerk in die DB laden.
    const seeded = DEFAULT_RULES.map(([keyword, category]) => ({
      keyword, category, source: 'system', createdAt: new Date().toISOString(),
    }));
    await DB.bulkAdd('kategorieRegeln', seeded);
    return DB.getAll('kategorieRegeln');
  }

  /**
   * Sortiert Regeln so, dass nutzergelernte ("user") vor System-Regeln
   * geprüft werden, und innerhalb dessen längere (spezifischere) Keywords
   * zuerst.
   */
  function getSortedRules(rules) {
    return [...rules].sort((a, b) => {
      if (a.source !== b.source) return a.source === 'user' ? -1 : 1;
      return (b.keyword || '').length - (a.keyword || '').length;
    });
  }

  /**
   * Lernen aus einer manuellen Korrektur: legt eine neue, nutzerdefinierte
   * Regel an (Empfänger/Verwendungszweck -> neue Kategorie), damit künftige
   * ähnliche Buchungen automatisch richtig zugeordnet werden.
   */
  async function learnFromCorrection(DB, transaction, newCategoryId) {
    const keyword = transaction.merchantKeyRaw || extractMerchantKey(transaction.typ, transaction.detail);
    if (!keyword) return null;
    const existing = await DB.getAllByIndex('kategorieRegeln', 'keyword', keyword);
    if (existing.length > 0) {
      const rule = existing[0];
      rule.category = newCategoryId;
      rule.source = 'user';
      rule.updatedAt = new Date().toISOString();
      await DB.put('kategorieRegeln', rule);
      return rule;
    }
    const rule = {
      keyword,
      category: newCategoryId,
      source: 'user',
      createdAt: new Date().toISOString(),
    };
    const id = await DB.add('kategorieRegeln', rule);
    return { ...rule, id };
  }

  root.Categorization = {
    CATEGORIES,
    CATEGORY_BY_ID,
    DEFAULT_CATEGORY_ID,
    DEFAULT_RULES,
    categorize,
    extractMerchantKey,
    extractMerchantDisplay,
    extractGlaeubigerId,
    loadRules,
    getSortedRules,
    learnFromCorrection,
    norm,
    normNoSpace,
  };
})(typeof window !== 'undefined' ? window : this);
