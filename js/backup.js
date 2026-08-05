/**
 * backup.js — Vollbackup und Wiederherstellung aller lokalen Daten.
 *
 * Die IndexedDB ist der einzige Speicherort aller Finanzdaten. Dieses Modul
 * exportiert die kompletten Daten und erlaubt die Wiederherstellung nach
 * Datenverlust oder bei Gerätewechsel.
 */
(function (root) {
  'use strict';

  const BACKUP_STORES = [
    'transactions',
    'fixkosten',
    'geplanteAusgaben',
    'kategorieRegeln',
    'importierteAuszuege',
    'meta',
    'kategorieBudgets'
  ];

  const SCHEMA_VERSION = 1;

  /**
   * Exportiert alle Daten aus der Datenbank.
   * @param {object} DB Datenbank-API
   * @returns {Promise<object>} Backup-Payload
   */
  async function exportAll(DB) {
    const stores = {};
    for (const storeName of BACKUP_STORES) {
      stores[storeName] = await DB.getAll(storeName);
    }

    return {
      app: 'haushaltsbudget',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      stores: stores
    };
  }

  /**
   * Validiert ein Backup-Payload ohne Schreibzugriff.
   * @param {object} payload Das zu validierende Backup
   * @returns {object} { ok: boolean, fehler: string|null }
   */
  function validateBackup(payload) {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, fehler: 'Backup-Datei ist beschädigt.' };
    }

    if (payload.app !== 'haushaltsbudget') {
      return { ok: false, fehler: 'Keine Backup-Datei dieser App.' };
    }

    if (typeof payload.schemaVersion !== 'number' || payload.schemaVersion > SCHEMA_VERSION) {
      return { ok: false, fehler: 'Backup stammt aus einer neueren App-Version.' };
    }

    if (!payload.stores || typeof payload.stores !== 'object') {
      return { ok: false, fehler: 'Backup-Datei ist beschädigt.' };
    }

    // Prüfe, dass alle Stores, die vorhanden sind, Arrays sind.
    for (const [storeName, data] of Object.entries(payload.stores)) {
      if (!Array.isArray(data)) {
        return { ok: false, fehler: 'Backup-Datei ist beschädigt.' };
      }
    }

    return { ok: true, fehler: null };
  }

  /**
   * Importiert ein Backup-Payload in die Datenbank.
   * Alle vorhandenen Daten werden vollständig ersetzt.
   * @param {object} DB Datenbank-API
   * @param {object} payload Das zu importierende Backup
   * @returns {Promise<object>} { ok: boolean, importiert: {store: anzahl}, fehler: string|null }
   */
  async function importBackup(DB, payload) {
    const validation = validateBackup(payload);
    if (!validation.ok) {
      return { ok: false, importiert: {}, fehler: validation.fehler };
    }

    const imported = {};

    try {
      for (const storeName of BACKUP_STORES) {
        await DB.clear(storeName);
        const data = payload.stores[storeName] || [];
        for (const record of data) {
          await DB.put(storeName, record);
        }
        imported[storeName] = data.length;
      }
      return { ok: true, importiert: imported, fehler: null };
    } catch (err) {
      return { ok: false, importiert: imported, fehler: err.message };
    }
  }

  /**
   * Exportiert die Datenbank und startet den Download.
   * Browser-Funktion, nur im Frontend verfügbar.
   * @param {object} DB Datenbank-API
   * @returns {Promise<object>} Backup-Payload
   */
  async function downloadBackup(DB) {
    const payload = await exportAll(DB);
    const filename = `haushaltsbudget-backup-${new Date().toISOString().slice(0, 10)}.json`;
    ExportData.downloadJSON(payload, filename);
    return payload;
  }

  /**
   * Liest eine Backup-Datei und gibt das geparstes JSON zurück.
   * @param {File} file Die zu lesende Datei
   * @returns {Promise<object>} Das geparstes Backup-Payload
   * @throws {Error} Bei JSON-Parse-Fehler
   */
  async function readBackupFile(file) {
    const text = await file.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error('Datei ist kein gültiges JSON.');
    }
  }

  root.Backup = {
    BACKUP_STORES,
    SCHEMA_VERSION,
    exportAll,
    validateBackup,
    importBackup,
    downloadBackup,
    readBackupFile
  };
})(typeof window !== 'undefined' ? window : this);
