/**
 * search.js — Suche und Filterung von Buchungen.
 *
 * Filtert Buchungen nach Monat, Freitext und Kategorie. Die Eingabeliste
 * wird nicht verändert; es wird ein neues, gefiltertes Array zurückgegeben.
 */
(function (root) {
  'use strict';

  /**
   * Filtert Buchungen nach Monat, Freitext und Kategorie.
   * @param {Array} transactions
   * @param {{month?: string|null, query?: string, categoryId?: string|null}} filter
   * @returns {Array} gefilterte Buchungen, Eingabereihenfolge bleibt erhalten
   */
  function filterTransactions(transactions, filter) {
    filter = filter || {};
    const month = filter.month || null;
    const query = filter.query ? Categorization.norm(filter.query) : null;
    const categoryId = filter.categoryId || null;

    return transactions.filter((t) => {
      // Monatfilter
      if (month && !t.date.startsWith(month)) {
        return false;
      }

      // Kategoriefilter
      if (categoryId && t.category !== categoryId) {
        return false;
      }

      // Freitextfilter
      if (query) {
        const detail = Categorization.norm(t.detail || '');
        const typ = Categorization.norm(t.typ || '');
        if (!detail.includes(query) && !typ.includes(query)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Summe der Beträge (vorzeichenbehaftet).
   * @param {Array} transactions
   * @returns {number} Summe in Cent
   */
  function sumCents(transactions) {
    return transactions.reduce((sum, t) => sum + (t.amountCents || 0), 0);
  }

  root.Search = { filterTransactions, sumCents };
})(typeof window !== 'undefined' ? window : this);
