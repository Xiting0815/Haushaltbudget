/**
 * db.js — IndexedDB-Datenschicht.
 *
 * Alle echten Finanzdaten (Buchungen, Fixkosten, geplante Ausgaben,
 * gelernte Kategorisierungsregeln) leben ausschließlich hier, lokal im
 * Browser. Es gibt keinen Server, keinen Sync, keinen externen Aufruf.
 *
 * Object Stores:
 *  - transactions        Kontobewegungen (importiert oder manuell erfasst)
 *  - fixkosten            Wiederkehrende Posten (Miete, Versicherung, ...)
 *  - geplanteAusgaben     Zukünftige, noch nicht gebuchte Ausgaben
 *  - kategorieRegeln      Schlüsselwort -> Kategorie (system + gelernt)
 *  - importierteAuszuege  Fingerprints bereits importierter Kontoauszüge
 *  - meta                 Einstellungen / Key-Value
 */
(function (root) {
  'use strict';

  const DB_NAME = 'haushaltsbudget';
  const DB_VERSION = 1;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains('transactions')) {
          const store = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
          store.createIndex('date', 'date');
          store.createIndex('category', 'category');
          store.createIndex('merchantKey', 'merchantKey');
          store.createIndex('fingerprint', 'fingerprint', { unique: false });
          store.createIndex('fixkostenId', 'fixkostenId');
          store.createIndex('plannedId', 'plannedId');
        }

        if (!db.objectStoreNames.contains('fixkosten')) {
          const store = db.createObjectStore('fixkosten', { keyPath: 'id', autoIncrement: true });
          store.createIndex('active', 'active');
          store.createIndex('merchantKey', 'merchantKey');
        }

        if (!db.objectStoreNames.contains('geplanteAusgaben')) {
          const store = db.createObjectStore('geplanteAusgaben', { keyPath: 'id', autoIncrement: true });
          store.createIndex('status', 'status');
          store.createIndex('faelligkeitsdatum', 'faelligkeitsdatum');
        }

        if (!db.objectStoreNames.contains('kategorieRegeln')) {
          const store = db.createObjectStore('kategorieRegeln', { keyPath: 'id', autoIncrement: true });
          store.createIndex('keyword', 'keyword', { unique: true });
        }

        if (!db.objectStoreNames.contains('importierteAuszuege')) {
          const store = db.createObjectStore('importierteAuszuege', { keyPath: 'id', autoIncrement: true });
          store.createIndex('fingerprint', 'fingerprint', { unique: true });
        }

        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeNames, mode) {
    return openDB().then((db) => db.transaction(storeNames, mode));
  }

  function promisifyRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function promisifyTx(t) {
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const DB = {
    // ---- generisch ----
    async add(storeName, value) {
      const t = await tx([storeName], 'readwrite');
      const store = t.objectStore(storeName);
      const result = await promisifyRequest(store.add(value));
      await promisifyTx(t);
      return result;
    },

    async put(storeName, value) {
      const t = await tx([storeName], 'readwrite');
      const store = t.objectStore(storeName);
      const result = await promisifyRequest(store.put(value));
      await promisifyTx(t);
      return result;
    },

    async bulkAdd(storeName, values) {
      const t = await tx([storeName], 'readwrite');
      const store = t.objectStore(storeName);
      const ids = [];
      for (const v of values) {
        ids.push(await promisifyRequest(store.add(v)));
      }
      await promisifyTx(t);
      return ids;
    },

    async get(storeName, key) {
      const t = await tx([storeName], 'readonly');
      return promisifyRequest(t.objectStore(storeName).get(key));
    },

    async getAll(storeName) {
      const t = await tx([storeName], 'readonly');
      return promisifyRequest(t.objectStore(storeName).getAll());
    },

    async getAllByIndex(storeName, indexName, query) {
      const t = await tx([storeName], 'readonly');
      const idx = t.objectStore(storeName).index(indexName);
      return promisifyRequest(idx.getAll(query));
    },

    async delete(storeName, key) {
      const t = await tx([storeName], 'readwrite');
      t.objectStore(storeName).delete(key);
      await promisifyTx(t);
    },

    async count(storeName) {
      const t = await tx([storeName], 'readonly');
      return promisifyRequest(t.objectStore(storeName).count());
    },

    async clear(storeName) {
      const t = await tx([storeName], 'readwrite');
      t.objectStore(storeName).clear();
      await promisifyTx(t);
    },

    // ---- meta / settings ----
    async getMeta(key, fallback) {
      const row = await DB.get('meta', key);
      return row ? row.value : fallback;
    },

    async setMeta(key, value) {
      return DB.put('meta', { key, value });
    },

    // ---- Duplikat-Erkennung beim Import ----
    async hasFingerprint(fingerprint) {
      const rows = await DB.getAllByIndex('importierteAuszuege', 'fingerprint', fingerprint);
      return rows.length > 0;
    },

    async markImported(fingerprint, meta) {
      return DB.add('importierteAuszuege', { fingerprint, importedAt: new Date().toISOString(), ...meta });
    },
  };

  root.DB = DB;
})(typeof window !== 'undefined' ? window : this);
