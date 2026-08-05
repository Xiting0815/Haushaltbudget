/**
 * app.js — UI-Controller. Verdrahtet DB, Kategorisierung, Wiederkehr-
 * Erkennung, Budget-Berechnung und geplante Ausgaben mit der Oberfläche.
 */
(function () {
  'use strict';

  const state = {
    transactions: [],
    fixkosten: [],
    geplant: [],
    rules: [],
    kategorieBudgets: [],
    currentBalanceCents: 0,
    view: 'uebersicht',
    selectedMonth: null,
    searchQuery: '',
    categoryFilter: null,
  };

  const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const dateFmtLong = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });

  function fmtMoney(cents) {
    return money.format((cents || 0) / 100);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return dateFmt.format(new Date(iso + 'T00:00:00'));
  }

  function fmtDateLong(iso) {
    if (!iso) return '';
    return dateFmtLong.format(new Date(iso + 'T00:00:00'));
  }

  function todayISO() { return Budget.todayISO(); }

  function monthKey(iso) { return iso.slice(0, 7); }

  function monthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    return new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(d);
  }

  function catInfo(id) {
    return Categorization.CATEGORY_BY_ID[id] || Categorization.CATEGORY_BY_ID[Categorization.DEFAULT_CATEGORY_ID];
  }

  function rhythmusLabel(r) {
    return { monatlich: 'monatlich', vierteljaehrlich: 'vierteljährlich', jaehrlich: 'jährlich' }[r] || r;
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // ---------------------------------------------------------------
  // Datenladen
  // ---------------------------------------------------------------
  async function loadAll() {
    state.rules = Categorization.getSortedRules(await Categorization.loadRules(DB));
    state.transactions = (await DB.getAll('transactions')).sort((a, b) => b.date.localeCompare(a.date));
    state.fixkosten = await DB.getAll('fixkosten');
    state.geplant = await DB.getAll('geplanteAusgaben');
    state.kategorieBudgets = await DB.getAll('kategorieBudgets');
    state.currentBalanceCents = await DB.getMeta('currentBalanceCents', 0);
    state.currentBalanceSource = await DB.getMeta('currentBalanceSource', null);
    state.currentBalanceDate = await DB.getMeta('currentBalanceDate', null);
    if (!state.selectedMonth) state.selectedMonth = monthKey(todayISO());
  }

  function availableMonths() {
    const set = new Set(state.transactions.map((t) => monthKey(t.date)));
    set.add(monthKey(todayISO()));
    return [...set].sort().reverse();
  }

  // ---------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== `view-${view}`; });
    document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    render();
  }

  function render() {
    if (state.view === 'uebersicht') renderUebersicht();
    else if (state.view === 'buchungen') renderBuchungen();
    else if (state.view === 'fixkosten') renderFixkosten();
    else if (state.view === 'geplant') renderGeplant();
    else if (state.view === 'trends') renderTrends();
    else if (state.view === 'einstellungen') renderEinstellungen();
  }

  // ---------------------------------------------------------------
  // ÜBERSICHT
  // ---------------------------------------------------------------
  function renderUebersicht() {
    document.getElementById('kontostand').textContent = fmtMoney(state.currentBalanceCents);
    const datumEl = document.getElementById('kontostandDatum');
    if (state.currentBalanceSource === 'manual' && state.currentBalanceDate) {
      datumEl.textContent = `Manuell gesetzt am ${fmtDate(state.currentBalanceDate)}`;
    } else if (state.currentBalanceSource === 'import' && state.currentBalanceDate) {
      datumEl.textContent = `Stand aus Kontoauszug vom ${fmtDate(state.currentBalanceDate)}`;
    } else if (state.transactions.length) {
      datumEl.textContent = 'Stand aus letztem Import / letzter Buchung';
    } else {
      datumEl.textContent = 'Noch kein Kontoauszug importiert';
    }

    const budget = Budget.computeBudget({
      currentBalanceCents: state.currentBalanceCents,
      fixkosten: state.fixkosten,
      geplanteAusgaben: state.geplant,
    });

    const wEl = document.getElementById('wochenbudget');
    wEl.textContent = fmtMoney(budget.availableForWeekCents);
    wEl.classList.toggle('negative', budget.availableForWeekCents < 0);
    document.getElementById('wochenbudgetSub').textContent = `bis Sonntag, ${budget.daysLeftInWeek} Tage`;

    const mEl = document.getElementById('monatsbudget');
    mEl.textContent = fmtMoney(budget.availableForMonthCents);
    mEl.classList.toggle('negative', budget.availableForMonthCents < 0);
    document.getElementById('monatsbudgetSub').textContent = budget.monthReserveCents >= 0
      ? `${fmtMoney(budget.monthReserveCents)} für offene Fixkosten & Geplantes zurückgelegt`
      : `${fmtMoney(-budget.monthReserveCents)} an erwarteten Einnahmen bereits eingerechnet`;

    // Anstehend: offene Fixkosten (Ausgaben & Einnahmen) + geplante Posten,
    // sortiert nach Fälligkeit. Vorzeichen bleibt erhalten (Einnahmen +, s.
    // buildSimpleRow/CSS-Klasse "positive").
    const anstehend = [
      ...state.fixkosten.filter((f) => f.active && f.naechsteFaelligkeit)
        .map((f) => ({ type: 'fixkosten', name: f.name, amountCents: f.amountCents, date: f.naechsteFaelligkeit, id: f.id, category: f.category })),
      ...state.geplant.filter((p) => p.status === 'offen')
        .map((p) => ({ type: 'geplant', name: p.name, amountCents: p.betragCents, date: p.faelligkeitsdatum, id: p.id, category: p.category })),
    ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);

    const list = document.getElementById('anstehendListe');
    list.innerHTML = '';
    if (anstehend.length === 0) {
      list.innerHTML = '<p class="empty-hint">Nichts Anstehendes erfasst.</p>';
    } else {
      for (const item of anstehend) {
        const emoji = item.type === 'fixkosten' ? (item.amountCents >= 0 ? '💰' : '🔁') : '📌';
        list.appendChild(buildSimpleRow(item.name, fmtDate(item.date), item.amountCents, emoji, item.category));
      }
    }

    // Kategorie-Chart für aktuellen Monat
    const summary = Budget.computeMonthSummary(state.transactions, monthKey(todayISO()));
    const limitStatus = Budget.computeCategoryBudgetStatus(summary, state.kategorieBudgets);
    renderCategoryChart(document.getElementById('kategorieChart'), summary.byCategory, summary.expenseCents, limitStatus);
  }

  function buildSimpleRow(title, sub, amountCents, emoji, categoryId) {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.style.cursor = 'default';
    const cat = catInfo(categoryId);
    row.innerHTML = `
      <div class="list-item-icon" style="background:${cat.color}22;color:${cat.color}">${emoji}</div>
      <div class="list-item-body">
        <div class="list-item-title">${escapeHTML(title)}</div>
        <div class="list-item-sub">${escapeHTML(sub)}</div>
      </div>
      <div class="list-item-amount ${amountCents >= 0 ? 'positive' : 'negative'}">${amountCents >= 0 ? '+' : ''}${fmtMoney(amountCents)}</div>
    `;
    return row;
  }

  function renderCategoryChart(container, byCategory, totalExpense, limitStatus) {
    container.innerHTML = '';
    const rows = Categorization.CATEGORIES
      .map((c) => ({ ...c, amount: byCategory[c.id] || 0 }))
      .filter((c) => c.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    if (rows.length === 0) {
      container.innerHTML = '<p class="empty-hint">Noch keine Ausgaben diesen Monat.</p>';
      return;
    }

    limitStatus = limitStatus || [];
    const limitByCategory = {};
    for (const limit of limitStatus) {
      limitByCategory[limit.categoryId] = limit;
    }

    const max = Math.max(...rows.map((r) => r.amount));
    for (const r of rows) {
      const pct = totalExpense > 0 ? Math.round((r.amount / totalExpense) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'category-row';

      const limit = limitByCategory[r.id];
      let barHtml = `<div class="category-bar-fill" style="width:${(r.amount / max) * 100}%;background:${r.color}"></div>`;
      let limitText = '';

      if (limit) {
        let barClass = '';
        if (limit.status === 'warn') barClass = ' limit-warn';
        else if (limit.status === 'over') barClass = ' limit-over';

        barHtml = `<div class="category-bar-fill${barClass}" style="width:${(r.amount / max) * 100}%;background:${r.color}"></div>`;

        if (limit.status === 'ok') {
          limitText = `<div class="limit-info">noch ${fmtMoney(limit.restCents)} von ${fmtMoney(limit.limitCents)} übrig</div>`;
        } else if (limit.status === 'warn') {
          limitText = `<div class="limit-info">nur noch ${fmtMoney(limit.restCents)} von ${fmtMoney(limit.limitCents)} übrig</div>`;
        } else if (limit.status === 'over') {
          limitText = `<div class="limit-info">${fmtMoney(Math.abs(limit.restCents))} über dem Limit von ${fmtMoney(limit.limitCents)}</div>`;
        }
      }

      row.innerHTML = `
        <div class="category-row-top">
          <span>${escapeHTML(r.name)}</span>
          <span>${fmtMoney(r.amount)} · ${pct}%</span>
        </div>
        <div class="category-bar-track">
          ${barHtml}
        </div>
        ${limitText}
      `;
      container.appendChild(row);
    }
  }

  // ---------------------------------------------------------------
  // BUCHUNGEN
  // ---------------------------------------------------------------
  function renderBuchungen() {
    const sel = document.getElementById('monatFilter');
    const months = availableMonths();
    sel.innerHTML = months.map((m) => `<option value="${m}" ${m === state.selectedMonth ? 'selected' : ''}>${monthLabel(m)}</option>`).join('');

    // Kategoriefilter befüllen
    const catSel = document.getElementById('buchungenKategorieFilter');
    if (!catSel.value) {
      catSel.innerHTML = '<option value="">Alle Kategorien</option>';
      for (const cat of Categorization.CATEGORIES) {
        catSel.innerHTML += `<option value="${cat.id}">${escapeHTML(cat.name)}</option>`;
      }
    } else {
      const currentVal = catSel.value;
      catSel.innerHTML = '<option value="">Alle Kategorien</option>';
      for (const cat of Categorization.CATEGORIES) {
        const selected = cat.id === currentVal ? ' selected' : '';
        catSel.innerHTML += `<option value="${cat.id}"${selected}>${escapeHTML(cat.name)}</option>`;
      }
    }

    // Suchfeld: nur befüllen, wenn Wert unterschiedlich ist (Fokus-Schutz)
    const searchInput = document.getElementById('buchungenSuche');
    if (searchInput.value !== state.searchQuery) {
      searchInput.value = state.searchQuery;
    }

    // Filterung durchführen
    const filteredRows = Search.filterTransactions(state.transactions, {
      month: state.selectedMonth,
      query: state.searchQuery,
      categoryId: state.categoryFilter
    });

    const list = document.getElementById('buchungenListe');
    list.innerHTML = '';
    document.getElementById('buchungenLeer').hidden = filteredRows.length !== 0;

    // Leer-Hinweis anpassen basierend auf aktiven Filtern
    const emptyHint = document.getElementById('buchungenLeer');
    if (state.searchQuery || state.categoryFilter) {
      emptyHint.textContent = 'Keine Buchung passt zu dieser Suche.';
    } else {
      emptyHint.textContent = 'Noch keine Buchungen für diesen Monat.';
    }

    // Buchungen rendern
    for (const t of filteredRows) {
      const cat = catInfo(t.category);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'list-item';
      row.innerHTML = `
        <span class="cat-dot" style="background:${cat.color}"></span>
        <div class="list-item-body">
          <div class="list-item-title">${escapeHTML(displayTitle(t))}</div>
          <div class="list-item-sub">${fmtDate(t.date)} · ${escapeHTML(cat.name)}${t.isManual ? ' · manuell' : ''}</div>
        </div>
        <div class="list-item-amount ${t.amountCents >= 0 ? 'positive' : 'negative'}">${t.amountCents >= 0 ? '+' : ''}${fmtMoney(t.amountCents)}</div>
      `;
      row.addEventListener('click', () => openTransactionModal(t));
      list.appendChild(row);
    }

    // Summenzeile
    if (filteredRows.length > 0) {
      const sum = Search.sumCents(filteredRows);
      document.getElementById('buchungenSumme').textContent = `${filteredRows.length} Buchungen · Saldo ${fmtMoney(sum)}`;
    } else {
      document.getElementById('buchungenSumme').textContent = '';
    }
  }

  function displayTitle(t) {
    if (t.isManual) return t.detail || t.typ;
    const display = Categorization.extractMerchantDisplay(t.typ, t.detail);
    return display || t.typ;
  }

  function openTransactionModal(t) {
    const cat = catInfo(t.category);
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="modal-title">${escapeHTML(displayTitle(t))}</div>
      <p class="hint-text" style="margin-bottom:14px">${fmtDateLong(t.date)} · ${t.typ}</p>
      <div class="budget-card" style="margin-bottom:16px">
        <div class="budget-card-label">Betrag</div>
        <div class="budget-card-amount ${t.amountCents < 0 ? 'negative' : ''}">${t.amountCents >= 0 ? '+' : ''}${fmtMoney(t.amountCents)}</div>
      </div>
      <div class="field">
        <label>Kategorie</label>
        <div class="category-select" id="catSelect"></div>
      </div>
      ${t.isManual ? '<div class="modal-actions"><button class="btn btn-danger btn-block" id="btnDeleteManual">Löschen</button></div>' : ''}
    `;
    const catSelect = body.querySelector('#catSelect');
    for (const c of Categorization.CATEGORIES) {
      const chip = document.createElement('div');
      chip.className = 'category-chip' + (c.id === t.category ? ' selected' : '');
      chip.style.color = c.id === t.category ? c.color : '';
      chip.textContent = c.name;
      chip.addEventListener('click', async () => {
        if (c.id === t.category) return;
        t.category = c.id;
        t.categorySource = 'manual';
        await DB.put('transactions', t);
        if (!t.isManual) {
          await Categorization.learnFromCorrection(DB, t, c.id);
          toast('Kategorie gespeichert — neue Regel gelernt');
        } else {
          toast('Kategorie aktualisiert');
        }
        closeModal();
        await loadAll();
        render();
      });
      catSelect.appendChild(chip);
    }

    if (t.isManual) {
      body.querySelector('#btnDeleteManual').addEventListener('click', async () => {
        await Manual.deleteManualTransaction(DB, t.id);
        toast('Buchung gelöscht');
        closeModal();
        await loadAll();
        render();
      });
    }

    openModal(body);
  }

  // ---------------------------------------------------------------
  // FIXKOSTEN
  // ---------------------------------------------------------------
  function richtungOf(f) {
    return f.amountCents >= 0 ? 'einnahme' : 'ausgabe';
  }

  function renderFixkosten() {
    const unsicherContainer = document.getElementById('unsichereFixkosten');
    const unsicher = state.fixkosten.filter((f) => f.status === 'unsicher');
    unsicherContainer.innerHTML = '';
    if (unsicher.length > 0) {
      const heading = document.createElement('p');
      heading.className = 'hint-text';
      heading.textContent = 'Möglicherweise wiederkehrend — bitte bestätigen:';
      unsicherContainer.appendChild(heading);
      for (const f of unsicher) {
        const isIncome = richtungOf(f) === 'einnahme';
        const card = document.createElement('div');
        card.className = 'card';
        card.style.marginBottom = '10px';
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div>
              <div class="list-item-title">${escapeHTML(f.name)}</div>
              <div class="list-item-sub">${fmtMoney(f.amountCents)} · vermutlich ${rhythmusLabel(f.rhythmus)}${isIncome ? ' Einnahme' : ''} · ${f.occurrences}× erkannt</div>
            </div>
          </div>
          <div class="modal-actions" style="margin-top:0">
            <button class="btn btn-secondary" data-action="confirm">Ja, ${isIncome ? 'erwartete Einnahme' : 'wiederkehrend'}</button>
            <button class="btn btn-danger" data-action="ignore">Nein, einmalig</button>
          </div>
        `;
        card.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
          f.status = 'bestaetigt';
          f.active = true;
          await DB.put('fixkosten', f);
          toast(isIncome ? 'Als erwartete Einnahme bestätigt' : 'Als Fixkosten bestätigt');
          await loadAll();
          render();
        });
        card.querySelector('[data-action="ignore"]').addEventListener('click', async () => {
          f.status = 'ignoriert';
          f.active = false;
          await DB.put('fixkosten', f);
          toast('Wird nicht mehr vorgeschlagen');
          await loadAll();
          render();
        });
        unsicherContainer.appendChild(card);
      }
    }

    const ausgelaufen = state.fixkosten.filter((f) => f.status === 'ausgelaufen');
    if (ausgelaufen.length > 0) {
      const heading = document.createElement('p');
      heading.className = 'hint-text';
      heading.textContent = 'Vermutlich beendet (lange nicht mehr gebucht):';
      unsicherContainer.appendChild(heading);
      for (const f of ausgelaufen) {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.marginBottom = '10px';
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div>
              <div class="list-item-title">${escapeHTML(f.name)}</div>
              <div class="list-item-sub">${fmtMoney(f.amountCents)} · war ${rhythmusLabel(f.rhythmus)} · zuletzt ${fmtDate(f.naechsteFaelligkeit)}</div>
            </div>
          </div>
          <div class="modal-actions" style="margin-top:0">
            <button class="btn btn-secondary" data-action="reactivate">Läuft noch, reaktivieren</button>
            <button class="btn btn-danger" data-action="remove">Löschen</button>
          </div>
        `;
        card.querySelector('[data-action="reactivate"]').addEventListener('click', async () => {
          f.status = 'bestaetigt';
          f.active = true;
          await DB.put('fixkosten', f);
          toast('Reaktiviert');
          await loadAll();
          render();
        });
        card.querySelector('[data-action="remove"]').addEventListener('click', async () => {
          await DB.delete('fixkosten', f.id);
          await loadAll();
          render();
        });
        unsicherContainer.appendChild(card);
      }
    }

    // Bestätigte/manuelle Fixkosten: Ausgaben und Einnahmen getrennt
    // dargestellt, damit die Summe "pro Monat" nicht Äpfel mit Birnen
    // mischt (eine Ausgabe von 50€ + eine Einnahme von 250€ wären sonst
    // fälschlich "200€/Monat Fixkosten").
    const confirmedAll = state.fixkosten.filter((f) => f.status === 'bestaetigt' || f.status === 'manuell')
      .sort((a, b) => (a.naechsteFaelligkeit || '9999').localeCompare(b.naechsteFaelligkeit || '9999'));
    const confirmedExpense = confirmedAll.filter((f) => richtungOf(f) === 'ausgabe');
    const confirmedIncome = confirmedAll.filter((f) => richtungOf(f) === 'einnahme');

    renderFixkostenList(document.getElementById('fixkostenListe'), document.getElementById('fixkostenLeer'), confirmedExpense);
    renderFixkostenList(document.getElementById('einnahmenListe'), document.getElementById('einnahmenLeer'), confirmedIncome);
  }

  function renderFixkostenList(list, emptyEl, items) {
    list.innerHTML = '';
    emptyEl.hidden = items.length !== 0;

    let monthlyTotal = 0;
    for (const f of items) {
      monthlyTotal += toMonthlyEquivalent(f);
      const cat = catInfo(f.category);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'list-item';
      row.innerHTML = `
        <span class="cat-dot" style="background:${cat.color}"></span>
        <div class="list-item-body">
          <div class="list-item-title">${escapeHTML(f.name)}</div>
          <div class="list-item-sub">${rhythmusLabel(f.rhythmus)} · nächste Fälligkeit ${fmtDate(f.naechsteFaelligkeit)}</div>
        </div>
        <div class="list-item-amount ${f.amountCents >= 0 ? 'positive' : 'negative'}">${f.amountCents >= 0 ? '+' : ''}${fmtMoney(f.amountCents)}</div>
      `;
      row.addEventListener('click', () => openFixkostenModal(f));
      list.appendChild(row);
    }

    if (items.length > 0) {
      const summary = document.createElement('p');
      summary.className = 'hint-text';
      summary.textContent = `Entspricht ca. ${fmtMoney(monthlyTotal)} pro Monat.`;
      list.appendChild(summary);
    }
  }

  function toMonthlyEquivalent(f) {
    const amt = Math.abs(f.amountCents);
    if (f.rhythmus === 'monatlich') return amt;
    if (f.rhythmus === 'vierteljaehrlich') return Math.round(amt / 3);
    if (f.rhythmus === 'jaehrlich') return Math.round(amt / 12);
    return amt;
  }

  function openFixkostenModal(f) {
    const isNew = !f.id;
    let richtung = isNew ? 'ausgabe' : richtungOf(f);
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="modal-title">${isNew ? 'Neue Fixkosten' : 'Fixkosten bearbeiten'}</div>
      <div class="field">
        <label>Art</label>
        <div class="category-select" id="fkRichtung">
          <div class="category-chip" data-val="ausgabe">Ausgabe</div>
          <div class="category-chip" data-val="einnahme">Einnahme</div>
        </div>
      </div>
      <div class="field"><label>Name</label><input class="input" id="fkName" value="${escapeAttr(f.name || '')}" placeholder="z. B. Miete"></div>
      <div class="field"><label>Betrag (€)</label><input class="input" id="fkAmount" type="number" step="0.01" value="${f.amountCents ? Math.abs(f.amountCents / 100) : ''}"></div>
      <div class="field"><label>Rhythmus</label>
        <select class="select" id="fkRhythmus">
          <option value="monatlich" ${f.rhythmus === 'monatlich' ? 'selected' : ''}>Monatlich</option>
          <option value="vierteljaehrlich" ${f.rhythmus === 'vierteljaehrlich' ? 'selected' : ''}>Vierteljährlich</option>
          <option value="jaehrlich" ${f.rhythmus === 'jaehrlich' ? 'selected' : ''}>Jährlich</option>
        </select>
      </div>
      <div class="field"><label>Nächste Fälligkeit</label><input class="input" id="fkDate" type="date" value="${f.naechsteFaelligkeit || todayISO()}"></div>
      <div class="field"><label>Kategorie</label><div class="category-select" id="fkCat"></div></div>
      <div class="modal-actions">
        <button class="btn btn-primary btn-block" id="fkSave">Speichern</button>
      </div>
      ${!isNew ? `<div class="modal-actions">${f.merchantKey
        ? '<button class="btn btn-danger btn-block" id="fkIgnore">Das ist keine Fixkosten — nicht mehr vorschlagen</button>'
        : '<button class="btn btn-danger btn-block" id="fkDelete">Löschen</button>'}</div>` : ''}
    `;

    const richtungWrap = body.querySelector('#fkRichtung');
    function paintRichtung() {
      richtungWrap.querySelectorAll('.category-chip').forEach((el) => el.classList.toggle('selected', el.dataset.val === richtung));
    }
    richtungWrap.querySelectorAll('.category-chip').forEach((chip) => {
      chip.addEventListener('click', () => { richtung = chip.dataset.val; paintRichtung(); });
    });
    paintRichtung();

    let selectedCat = f.category || Categorization.DEFAULT_CATEGORY_ID;
    const catWrap = body.querySelector('#fkCat');
    for (const c of Categorization.CATEGORIES) {
      const chip = document.createElement('div');
      chip.className = 'category-chip' + (c.id === selectedCat ? ' selected' : '');
      chip.textContent = c.name;
      chip.addEventListener('click', () => {
        selectedCat = c.id;
        catWrap.querySelectorAll('.category-chip').forEach((el) => el.classList.remove('selected'));
        chip.classList.add('selected');
      });
      catWrap.appendChild(chip);
    }

    body.querySelector('#fkSave').addEventListener('click', async () => {
      const name = body.querySelector('#fkName').value.trim();
      const amountEur = parseFloat(body.querySelector('#fkAmount').value.replace(',', '.'));
      if (!name || !amountEur || amountEur <= 0) { toast('Bitte Name und Betrag angeben'); return; }
      f.name = name;
      f.amountCents = richtung === 'einnahme' ? Math.round(amountEur * 100) : -Math.round(amountEur * 100);
      f.rhythmus = body.querySelector('#fkRhythmus').value;
      f.naechsteFaelligkeit = body.querySelector('#fkDate').value;
      f.category = selectedCat;
      f.status = f.status || 'manuell';
      f.active = true;
      if (isNew) await DB.add('fixkosten', f);
      else await DB.put('fixkosten', f);
      toast('Gespeichert');
      closeModal();
      await loadAll();
      render();
    });

    if (!isNew && f.merchantKey) {
      // Automatisch erkannte Posten: nie hart löschen (sonst würde der
      // nächste Import dieselbe Buchung wieder als Kandidat vorschlagen,
      // s. importFiles) — stattdessen dauerhaft als "ignoriert" markieren.
      // Das behält den Eintrag (Rückholung möglich über Einstellungen) und
      // wird beim Merge in importFiles respektiert.
      body.querySelector('#fkIgnore').addEventListener('click', async () => {
        f.status = 'ignoriert';
        f.active = false;
        await DB.put('fixkosten', f);
        toast('Wird nicht mehr vorgeschlagen');
        closeModal();
        await loadAll();
        render();
      });
    } else if (!isNew) {
      body.querySelector('#fkDelete').addEventListener('click', async () => {
        await DB.delete('fixkosten', f.id);
        toast('Gelöscht');
        closeModal();
        await loadAll();
        render();
      });
    }

    openModal(body);
  }

  // ---------------------------------------------------------------
  // GEPLANTE AUSGABEN
  // ---------------------------------------------------------------
  function renderGeplant() {
    const list = document.getElementById('geplantListe');
    const rows = [...state.geplant].sort((a, b) => a.faelligkeitsdatum.localeCompare(b.faelligkeitsdatum));
    list.innerHTML = '';
    document.getElementById('geplantLeer').hidden = rows.length !== 0;

    for (const p of rows) {
      const cat = catInfo(p.category);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'list-item';
      row.innerHTML = `
        <span class="cat-dot" style="background:${cat.color}"></span>
        <div class="list-item-body">
          <div class="list-item-title">${escapeHTML(p.name)}</div>
          <div class="list-item-sub">fällig ${fmtDate(p.faelligkeitsdatum)} ${p.status === 'erledigt' ? '· erledigt ✓' : ''}</div>
        </div>
        <div class="list-item-amount ${p.betragCents >= 0 ? 'positive' : 'negative'}">${p.betragCents >= 0 ? '+' : ''}${fmtMoney(p.betragCents)}</div>
      `;
      row.addEventListener('click', () => openGeplantModal(p));
      list.appendChild(row);
    }
  }

  function openGeplantModal(p) {
    const isNew = !p.id;
    let richtung = isNew ? 'ausgabe' : (p.betragCents >= 0 ? 'einnahme' : 'ausgabe');
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="modal-title">${isNew ? 'Geplanter Posten' : 'Bearbeiten'}</div>
      <div class="field">
        <label>Art</label>
        <div class="category-select" id="gpRichtung">
          <div class="category-chip" data-val="ausgabe">Ausgabe</div>
          <div class="category-chip" data-val="einnahme">Einnahme</div>
        </div>
      </div>
      <div class="field"><label>Bezeichnung</label><input class="input" id="gpName" value="${escapeAttr(p.name || '')}" placeholder="z. B. Geburtstagsgeschenk"></div>
      <div class="field"><label>Betrag (€)</label><input class="input" id="gpAmount" type="number" step="0.01" value="${p.betragCents ? Math.abs(p.betragCents / 100) : ''}"></div>
      <div class="field"><label>Fällig am</label><input class="input" id="gpDate" type="date" value="${p.faelligkeitsdatum || todayISO()}"></div>
      <div class="field"><label>Kategorie</label><div class="category-select" id="gpCat"></div></div>
      <div class="modal-actions"><button class="btn btn-primary btn-block" id="gpSave">Speichern</button></div>
      ${!isNew && p.status === 'offen' ? '<div class="modal-actions"><button class="btn btn-secondary btn-block" id="gpDone">Als erledigt markieren</button></div>' : ''}
      ${!isNew ? '<div class="modal-actions"><button class="btn btn-danger btn-block" id="gpDelete">Löschen</button></div>' : ''}
    `;

    const richtungWrap = body.querySelector('#gpRichtung');
    function paintRichtung() {
      richtungWrap.querySelectorAll('.category-chip').forEach((el) => el.classList.toggle('selected', el.dataset.val === richtung));
    }
    richtungWrap.querySelectorAll('.category-chip').forEach((chip) => {
      chip.addEventListener('click', () => { richtung = chip.dataset.val; paintRichtung(); });
    });
    paintRichtung();

    let selectedCat = p.category || Categorization.DEFAULT_CATEGORY_ID;
    const catWrap = body.querySelector('#gpCat');
    for (const c of Categorization.CATEGORIES) {
      const chip = document.createElement('div');
      chip.className = 'category-chip' + (c.id === selectedCat ? ' selected' : '');
      chip.textContent = c.name;
      chip.addEventListener('click', () => {
        selectedCat = c.id;
        catWrap.querySelectorAll('.category-chip').forEach((el) => el.classList.remove('selected'));
        chip.classList.add('selected');
      });
      catWrap.appendChild(chip);
    }

    body.querySelector('#gpSave').addEventListener('click', async () => {
      const name = body.querySelector('#gpName').value.trim();
      const amountEur = parseFloat(body.querySelector('#gpAmount').value.replace(',', '.'));
      if (!name || !amountEur || amountEur <= 0) { toast('Bitte Bezeichnung und Betrag angeben'); return; }
      p.name = name;
      p.betragCents = richtung === 'einnahme' ? Math.round(amountEur * 100) : -Math.round(amountEur * 100);
      p.faelligkeitsdatum = body.querySelector('#gpDate').value;
      p.category = selectedCat;
      p.status = p.status || 'offen';
      if (isNew) await DB.add('geplanteAusgaben', p);
      else await DB.put('geplanteAusgaben', p);
      toast('Gespeichert');
      closeModal();
      await loadAll();
      render();
    });

    if (!isNew && p.status === 'offen') {
      body.querySelector('#gpDone').addEventListener('click', async () => {
        p.status = 'erledigt';
        await DB.put('geplanteAusgaben', p);
        closeModal();
        await loadAll();
        render();
      });
    }
    if (!isNew) {
      body.querySelector('#gpDelete').addEventListener('click', async () => {
        await DB.delete('geplanteAusgaben', p.id);
        closeModal();
        await loadAll();
        render();
      });
    }

    openModal(body);
  }

  // ---------------------------------------------------------------
  // TRENDS
  // ---------------------------------------------------------------
  function renderTrends() {
    const trend = Budget.computeMonthlyTrend(state.transactions, 6);
    const potential = Budget.computeSavingsPotential(trend);

    document.getElementById('sparquote').textContent = potential.avgSavingsRate !== null
      ? `${Math.round(potential.avgSavingsRate * 100)}%` : '–';
    document.getElementById('ansparpotenzial').textContent = fmtMoney(potential.avgMonthlySavingsCents);

    renderTrendChart(document.getElementById('trendChart'), trend);

    const sel = document.getElementById('exportMonatSelect');
    const months = availableMonths();
    sel.innerHTML = months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
  }

  function renderTrendChart(container, trend) {
    container.innerHTML = '';
    const w = 480;
    const h = 200;
    const padding = { top: 10, right: 10, bottom: 26, left: 10 };
    const barW = (w - padding.left - padding.right) / trend.length;
    const maxVal = Math.max(1, ...trend.map((m) => Math.max(m.incomeCents, m.expenseCents)));

    let svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" style="overflow:visible">`;
    trend.forEach((m, i) => {
      const x = padding.left + i * barW;
      const innerW = barW * 0.68;
      const incomeH = (m.incomeCents / maxVal) * (h - padding.top - padding.bottom);
      const expenseH = (m.expenseCents / maxVal) * (h - padding.top - padding.bottom);
      const baseY = h - padding.bottom;
      const gap = 3;
      const singleW = (innerW - gap) / 2;

      svg += `<rect x="${x + (barW - innerW) / 2}" y="${baseY - incomeH}" width="${singleW}" height="${incomeH}" rx="3" fill="var(--color-positive)"></rect>`;
      svg += `<rect x="${x + (barW - innerW) / 2 + singleW + gap}" y="${baseY - expenseH}" width="${singleW}" height="${expenseH}" rx="3" fill="var(--color-negative)"></rect>`;
      svg += `<text x="${x + barW / 2}" y="${h - 8}" font-size="9.5" text-anchor="middle" fill="var(--color-text-faint)">${m.yearMonth.slice(5)}</text>`;
    });
    svg += '</svg>';

    const legend = `<div style="display:flex;gap:16px;justify-content:center;margin-top:8px;font-size:12px;color:var(--color-text-muted)">
      <span><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:var(--color-positive);margin-right:5px"></span>Einnahmen</span>
      <span><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:var(--color-negative);margin-right:5px"></span>Ausgaben</span>
    </div>`;

    container.innerHTML = svg + legend;
  }

  // ---------------------------------------------------------------
  // EINSTELLUNGEN
  // ---------------------------------------------------------------
  function renderEinstellungen() {
    // Datensicherungs-Info
    document.getElementById('backupInfo').textContent =
      `${state.transactions.length} Buchungen, ${state.fixkosten.length} Fixkosten, ${state.geplant.length} geplante Posten und ${state.rules.length} Kategorisierungsregeln auf diesem Gerät.`;

    // Kategorie-Limits
    const limitsListe = document.getElementById('limitsListe');
    limitsListe.innerHTML = '';
    const limitByCategory = {};
    for (const limit of state.kategorieBudgets) {
      limitByCategory[limit.categoryId] = limit;
    }

    for (const cat of Categorization.CATEGORIES) {
      const limit = limitByCategory[cat.id];
      const currentValue = limit ? (limit.limitCents / 100).toFixed(2).replace('.', ',') : '';
      const row = document.createElement('div');
      row.className = 'rule-item';
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:9px;min-width:0">
          <span class="cat-dot" style="background:${cat.color}"></span>
          <span class="rule-keyword" style="flex:1">${escapeHTML(cat.name)}</span>
        </div>
        <div style="flex-shrink:0">
          <input class="input" type="number" step="0.01" inputmode="decimal" data-categoryId="${cat.id}" value="${currentValue}" style="width:120px" placeholder="kein Limit">
        </div>
      `;
      const input = row.querySelector('input');
      input.addEventListener('change', async () => {
        const val = input.value.trim();
        if (!val || isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
          // Limit entfernen
          await DB.delete('kategorieBudgets', cat.id);
          toast('Limit entfernt');
        } else {
          // Limit speichern
          const euros = parseFloat(val.replace(',', '.'));
          const limitCents = Math.round(euros * 100);
          await DB.put('kategorieBudgets', { categoryId: cat.id, limitCents });
          toast('Limit gespeichert');
        }
        await loadAll();
        render();
      });
      limitsListe.appendChild(row);
    }

    const ignoriert = state.fixkosten.filter((f) => f.status === 'ignoriert');
    const ignorierteList = document.getElementById('ignorierteListe');
    ignorierteList.innerHTML = '';
    document.getElementById('ignorierteLeer').hidden = ignoriert.length !== 0;
    for (const f of ignoriert) {
      const cat = catInfo(f.category);
      const row = document.createElement('div');
      row.className = 'rule-item';
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:9px;min-width:0">
          <span class="cat-dot" style="background:${cat.color}"></span>
          <span class="rule-keyword">${escapeHTML(f.name)} · ${fmtMoney(f.amountCents)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <button class="btn btn-secondary btn-sm" data-action="undo" type="button">Doch Fixkosten</button>
        </div>
      `;
      row.querySelector('[data-action="undo"]').addEventListener('click', async () => {
        f.status = 'unsicher';
        await DB.put('fixkosten', f);
        toast('Wird wieder zur Prüfung vorgeschlagen');
        await loadAll();
        render();
      });
      ignorierteList.appendChild(row);
    }

    const list = document.getElementById('regelnListe');
    const rows = [...state.rules].sort((a, b) => (a.category).localeCompare(b.category));
    list.innerHTML = '';
    for (const r of rows) {
      const cat = catInfo(r.category);
      const row = document.createElement('div');
      row.className = 'rule-item';
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:9px;min-width:0">
          <span class="cat-dot" style="background:${cat.color}"></span>
          <span class="rule-keyword">${escapeHTML(r.keyword)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <span class="badge">${escapeHTML(cat.name)}</span>
          ${r.source === 'user' ? `<button class="icon-btn" data-id="${r.id}" aria-label="Regel löschen"><svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>` : ''}
        </div>
      `;
      if (r.source === 'user') {
        row.querySelector('.icon-btn').addEventListener('click', async () => {
          await DB.delete('kategorieRegeln', r.id);
          toast('Regel gelöscht');
          await loadAll();
          render();
        });
      }
      list.appendChild(row);
    }
  }

  // ---------------------------------------------------------------
  // Modal-Helfer
  // ---------------------------------------------------------------
  function openModal(contentEl) {
    const overlay = document.getElementById('modalOverlay');
    const content = document.getElementById('modalContent');
    content.innerHTML = '';
    content.appendChild(contentEl);
    overlay.hidden = false;
  }

  function closeModal() {
    document.getElementById('modalOverlay').hidden = true;
  }

  function escapeHTML(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function escapeAttr(s) {
    return escapeHTML(s).replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------
  // PDF-Import
  // ---------------------------------------------------------------
  async function importFiles(files) {
    if (!files || files.length === 0) return;
    let totalNew = 0;
    let skippedStatements = 0;

    for (const file of files) {
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const parsed = await BudgetPDFParser.parsePDF(pdfjsLib, buf);
        if (!parsed.openingBalance || !parsed.closingBalance) {
          toast(`${file.name}: Layout nicht erkannt`);
          continue;
        }
        const statementFingerprint = `${parsed.accountNumber}|${parsed.openingBalance.auszugNr}|${parsed.openingBalance.date}|${parsed.closingBalance.date}`;
        if (await DB.hasFingerprint(statementFingerprint)) {
          skippedStatements += 1;
          continue;
        }

        const rules = state.rules;
        const newTxRecords = [];
        for (const t of parsed.transactions) {
          const fingerprint = `${t.date}|${t.typ}|${t.amountCents}|${(t.detail || '').slice(0, 60)}`;
          const existing = await DB.getAllByIndex('transactions', 'fingerprint', fingerprint);
          if (existing.length > 0) continue;
          const merchantKey = Categorization.extractMerchantKey(t.typ, t.detail);
          const { categoryId } = Categorization.categorize(t.typ, t.detail, rules);
          newTxRecords.push({
            date: t.date,
            typ: t.typ,
            detail: t.detail,
            amountCents: t.amountCents,
            category: categoryId,
            categorySource: 'rule',
            merchantKey,
            fingerprint,
            isManual: false,
            fixkostenId: null,
            plannedId: null,
            createdAt: new Date().toISOString(),
          });
        }

        const ids = await DB.bulkAdd('transactions', newTxRecords);
        newTxRecords.forEach((r, i) => { r.id = ids[i]; });
        totalNew += newTxRecords.length;

        await DB.markImported(statementFingerprint, {
          konto: parsed.accountNumber,
          auszugNr: parsed.openingBalance.auszugNr,
          von: parsed.openingBalance.date,
          bis: parsed.closingBalance.date,
          anzahlBuchungen: newTxRecords.length,
        });

        await DB.setMeta('currentBalanceCents', parsed.closingBalance.balanceCents);
        await DB.setMeta('currentBalanceSource', 'import');
        await DB.setMeta('currentBalanceDate', parsed.closingBalance.date);

        // Wiederkehr-Erkennung + Fixkosten-Vorschläge aktualisieren.
        // Referenzdatum für den Aktualitäts-Check ist die neueste uns
        // bekannte Buchung, NICHT das reale heutige Datum — sonst würden
        // alle Fixkosten fälschlich als "ausgelaufen" markiert, sobald der
        // Nutzer eine Weile keinen neuen Auszug importiert hat.
        const allTx = await DB.getAll('transactions');
        const referenceDate = allTx.reduce((max, t) => (t.date > max ? t.date : max), '0000-00-00');
        const candidates = Recurring.detectRecurring(allTx, referenceDate);
        const existingFixkosten = await DB.getAll('fixkosten');
        for (const cand of candidates) {
          const match = existingFixkosten.find((f) =>
            f.merchantKey === cand.merchantKey && Recurring.amountsCloseEnough(f.amountCents, cand.amountCents));
          if (match) {
            if (match.status !== 'ignoriert' && match.status !== 'manuell') {
              match.naechsteFaelligkeit = cand.naechsteFaelligkeit;
              match.occurrences = cand.occurrences;
              match.rhythmus = cand.rhythmus;
              match.confidenceScore = cand.confidenceScore;
              // "ausgelaufen": Buchung seit deutlich länger als dem
              // erkannten Rhythmus entsprechend nicht mehr aufgetaucht
              // (z. B. gekündigtes Abo) -> nicht länger als anstehend führen.
              match.status = cand.confidence === 'ausgelaufen' ? 'ausgelaufen' : cand.confidence;
              match.active = match.status === 'bestaetigt';
              await DB.put('fixkosten', match);
            }
          } else if (cand.confidence !== 'ausgelaufen') {
            const lastTx = allTx.filter((t) => t.merchantKey === cand.merchantKey).sort((a, b) => b.date.localeCompare(a.date))[0];
            const { categoryId } = Categorization.categorize(lastTx.typ, lastTx.detail, rules);
            await DB.add('fixkosten', {
              name: Categorization.extractMerchantDisplay(lastTx.typ, lastTx.detail),
              merchantKey: cand.merchantKey,
              amountCents: cand.amountCents,
              rhythmus: cand.rhythmus,
              naechsteFaelligkeit: cand.naechsteFaelligkeit,
              occurrences: cand.occurrences,
              confidenceScore: cand.confidenceScore,
              category: categoryId,
              status: cand.confidence,
              active: cand.confidence === 'bestaetigt',
              createdAt: new Date().toISOString(),
            });
          }
        }

        // Abgleich mit geplanten Ausgaben
        const openPlanned = await DB.getAll('geplanteAusgaben');
        const matches = Planned.matchPlannedToTransactions(
          openPlanned.filter((p) => p.status === 'offen'),
          newTxRecords,
          []
        );
        if (matches.length > 0) await Planned.applyMatches(DB, matches);
      } catch (err) {
        console.error('Import-Fehler', file.name, err);
        toast(`${file.name}: Import fehlgeschlagen`);
      }
    }

    await loadAll();
    render();

    if (totalNew > 0) toast(`${totalNew} Buchung(en) importiert`);
    else if (skippedStatements > 0) toast('Auszug wurde bereits importiert');
    else toast('Keine neuen Buchungen gefunden');
  }

  // ---------------------------------------------------------------
  // Kontostand manuell setzen
  // ---------------------------------------------------------------
  // Kontoauszüge lassen sich realistisch erst zum Monatsende importieren,
  // daher kennt die App tagesaktuelle Buchungen im laufenden Monat nicht.
  // Damit der Nutzer trotzdem jederzeit "bereinigt" starten kann, lässt
  // sich der getrackte Kontostand hier direkt setzen (z. B. nach Blick in
  // die Banking-App), statt auf den nächsten Import warten zu müssen.
  function openKontostandModal() {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="modal-title">Kontostand aktualisieren</div>
      <p class="hint-text" style="margin-bottom:14px">Setze den aktuellen Kontostand direkt — z. B. wenn du ihn gerade in deiner Banking-App nachgeschaut hast und der nächste Kontoauszug noch nicht importierbar ist.</p>
      <div class="field"><label>Aktueller Kontostand (€)</label><input class="input" id="ksAmount" type="number" step="0.01" value="${(state.currentBalanceCents / 100).toFixed(2)}"></div>
      <div class="modal-actions"><button class="btn btn-primary btn-block" id="ksSave">Speichern</button></div>
    `;
    body.querySelector('#ksSave').addEventListener('click', async () => {
      const raw = body.querySelector('#ksAmount').value.replace(',', '.');
      const eur = parseFloat(raw);
      if (Number.isNaN(eur)) { toast('Bitte einen gültigen Betrag angeben'); return; }
      await Manual.setBalanceManually(DB, Math.round(eur * 100));
      toast('Kontostand aktualisiert');
      closeModal();
      await loadAll();
      render();
    });
    openModal(body);
  }

  // ---------------------------------------------------------------
  // Quick-Add (manuelle Buchung)
  // ---------------------------------------------------------------
  function openQuickAddModal() {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="modal-title">Ausgabe erfassen</div>
      <div class="field"><label>Beschreibung</label><input class="input" id="qaDesc" placeholder="z. B. Eis am Kiosk"></div>
      <div class="field"><label>Betrag (€)</label><input class="input" id="qaAmount" type="number" step="0.01" inputmode="decimal" placeholder="0,00"></div>
      <div class="field"><label>Datum</label><input class="input" id="qaDate" type="date" value="${todayISO()}"></div>
      <div class="field"><label>Kategorie</label><div class="category-select" id="qaCat"></div></div>
      <div class="modal-actions"><button class="btn btn-primary btn-block" id="qaSave">Speichern</button></div>
    `;
    let selectedCat = Categorization.DEFAULT_CATEGORY_ID;
    const catWrap = body.querySelector('#qaCat');
    for (const c of Categorization.CATEGORIES) {
      const chip = document.createElement('div');
      chip.className = 'category-chip' + (c.id === selectedCat ? ' selected' : '');
      chip.textContent = c.name;
      chip.addEventListener('click', () => {
        selectedCat = c.id;
        catWrap.querySelectorAll('.category-chip').forEach((el) => el.classList.remove('selected'));
        chip.classList.add('selected');
      });
      catWrap.appendChild(chip);
    }

    body.querySelector('#qaSave').addEventListener('click', async () => {
      const desc = body.querySelector('#qaDesc').value.trim();
      const amountEur = parseFloat(body.querySelector('#qaAmount').value.replace(',', '.'));
      const date = body.querySelector('#qaDate').value;
      if (!desc || !amountEur || amountEur <= 0 || !date) { toast('Bitte alle Felder ausfüllen'); return; }
      await Manual.addManualTransaction(DB, {
        date, amountCents: -Math.round(amountEur * 100), description: desc, category: selectedCat,
      });
      toast('Ausgabe erfasst');
      closeModal();
      await loadAll();
      render();
    });

    openModal(body);
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  function wireEvents() {
    document.querySelectorAll('.tab').forEach((el) => {
      el.addEventListener('click', () => switchView(el.dataset.view));
    });

    document.getElementById('btnImport').addEventListener('click', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', async (e) => {
      await importFiles([...e.target.files]);
      e.target.value = '';
    });

    document.getElementById('btnQuickAdd').addEventListener('click', openQuickAddModal);
    document.getElementById('btnEditKontostand').addEventListener('click', openKontostandModal);
    document.getElementById('btnFixkostenNeu').addEventListener('click', () => openFixkostenModal({}));
    document.getElementById('btnGeplantNeu').addEventListener('click', () => openGeplantModal({}));

    document.getElementById('monatFilter').addEventListener('change', (e) => {
      state.selectedMonth = e.target.value;
      renderBuchungen();
    });

    document.getElementById('buchungenSuche').addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderBuchungen();
    });

    document.getElementById('buchungenKategorieFilter').addEventListener('change', (e) => {
      state.categoryFilter = e.target.value || null;
      renderBuchungen();
    });

    document.getElementById('btnExport').addEventListener('click', async () => {
      const ym = document.getElementById('exportMonatSelect').value;
      await ExportData.exportMonthAndDownload(DB, ym);
      toast('Export heruntergeladen');
    });

    document.getElementById('btnBackupExport').addEventListener('click', async () => {
      await Backup.downloadBackup(DB);
      toast('Backup gespeichert');
    });

    document.getElementById('btnBackupImport').addEventListener('click', () => {
      document.getElementById('backupFileInput').click();
    });

    document.getElementById('backupFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      let payload;
      try {
        payload = await Backup.readBackupFile(file);
      } catch (err) {
        toast('Datei ist kein gültiges JSON.');
        e.target.value = '';
        return;
      }

      const validation = Backup.validateBackup(payload);
      if (!validation.ok) {
        toast(validation.fehler);
        e.target.value = '';
        return;
      }

      // Bestätigung einholen
      const count = payload.stores.transactions ? payload.stores.transactions.length : 0;
      const body = document.createElement('div');
      body.innerHTML = `
        <div class="modal-title">Backup einspielen?</div>
        <p class="hint-text">Die Backup-Datei enthält ${count} Buchung(en).</p>
        <p style="color: var(--text-secondary)"><strong>Warnung:</strong> Alle aktuellen Daten auf diesem Gerät werden gelöscht und durch das Backup ersetzt. Dieser Vorgang lässt sich nicht rückgängig machen.</p>
        <div class="modal-actions" style="display: flex; gap: 8px; margin-top: 16px;">
          <button class="btn btn-secondary btn-block" id="btnAbbrechen">Abbrechen</button>
          <button class="btn btn-primary btn-block" id="btnErsetzen">Ersetzen</button>
        </div>
      `;

      openModal(body);

      body.querySelector('#btnAbbrechen').addEventListener('click', () => {
        closeModal();
        e.target.value = '';
      });

      body.querySelector('#btnErsetzen').addEventListener('click', async () => {
        const result = await Backup.importBackup(DB, payload);
        if (!result.ok) {
          toast(`Fehler beim Import: ${result.fehler}`);
        } else {
          closeModal();
          await loadAll();
          render();
          toast('Backup wiederhergestellt');
        }
        e.target.value = '';
      });
    });

    document.getElementById('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay') closeModal();
    });
  }

  async function init() {
    wireEvents();
    await loadAll();
    render();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch((e) => console.warn('SW-Registrierung fehlgeschlagen', e));
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
