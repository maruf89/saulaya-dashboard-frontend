'use strict';
// Sales calculator: Sell, Report and Stock. Ported from the old sales form (Apps Script) onto the Saulaya API.
// Loaded before app.js; it uses h(), api(), fieldRow(), eur and `me` from there, only after the page has started.

// ---------- dates (always France time, like the server) ----------
const PARIS = 'Europe/Paris';
const parisToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const parisNowHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: PARIS, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date());
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function presetRange(name) {
  const t = parisToday(), monday = addDays(t, -((new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const first = t.slice(0, 8) + '01', prevLast = addDays(first, -1), prevFirst = prevLast.slice(0, 8) + '01';
  return { today: [t, t], yesterday: [addDays(t, -1), addDays(t, -1)], thisweek: [monday, t], lastweek: [addDays(monday, -7), addDays(monday, -1)],
    thismonth: [first, t], lastmonth: [prevFirst, prevLast], last7: [addDays(t, -6), t], last30: [addDays(t, -29), t], thisyear: [t.slice(0, 4) + '-01-01', t] }[name] || null;
}
const round2 = n => Math.round(n * 100) / 100;
const newId = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + '00000000';
const clone = o => JSON.parse(JSON.stringify(o));
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: the queue just is not kept */ } };
const skuLabel = s => `${s.name} (${s.size})`;
const msgEl = () => h('div', { class: 'msg' });
const say = (el, text, cls = '') => { el.className = 'msg ' + cls; el.textContent = text; };
const opt = (value, text, selected) => h('option', { value, selected: !!selected }, text);

let sellState = null; // built once per login so the cart and the queue survive moving between pages
function resetSell() { sellState = null; }

// ---------- Sell ----------
async function sellPage() {
  const skus = await api('/saulaya/sell/skus');
  sellState ||= makeSell();
  sellState.setSkus(skus);
  return [h('h2', {}, 'Sell'), sellState.el];
}

function makeSell() {
  const STORE = 'pendingOrders:' + me.id;
  let skus = [], serverStock = {}, cart = [], editingId = null, orders = [], sending = false;
  try { orders = JSON.parse(lsGet(STORE) || '[]').map(o => o.state === 'sending'
    ? { ...o, state: 'error', retry: true, error: 'The page closed before a reply arrived. Retry is safe.' } : o); } catch { orders = []; }

  const find = sku => skus.find(s => s.sku === sku);
  const label = sku => { const s = find(sku); return s ? skuLabel(s) : sku; };
  const qtyOf = (data, sku) => data ? data.items.filter(i => i.sku === sku).reduce((t, i) => t + i.quantity, 0) : 0;
  // stock shown = last known server value minus whatever is still waiting to be sent
  const pendingDelta = sku => orders.reduce((d, o) => {
    if (o.state !== 'queued' && o.state !== 'sending') return d;
    return d + (o.op === 'delete' ? 0 : qtyOf(o.data, sku)) - (o.op === 'create' ? 0 : qtyOf(o.confirmed, sku));
  }, 0);
  const shown = sku => (serverStock[sku] || 0) - pendingDelta(sku);
  function calc(data) {
    let sub = 0, total = 0, unpriced = false;
    for (const l of data.items) {
      if (l.gift) continue;
      if (l.price == null) { unpriced = true; continue; }
      sub += l.quantity * l.price; total += round2(l.quantity * l.price * (1 - data.discount / 100));
    }
    return { sub: round2(sub), total: round2(total), disc: round2(sub - total), unpriced };
  }
  const persist = () => lsSet(STORE, JSON.stringify(orders.filter(o => o.state !== 'ok')));

  // ----- add item -----
  const skuSel = h('select', { onchange: () => refreshProduct() });
  const stockHint = h('div', { class: 'hint' });
  const qty = h('input', { type: 'number', min: 1, step: 1, value: 1, inputmode: 'numeric' });
  const price = h('input', { type: 'number', min: 0, step: 'any', inputmode: 'decimal', placeholder: 'catalogue price' });
  const gift = h('input', { type: 'checkbox', onchange: () => { price.disabled = gift.checked; refreshProduct(); } });
  const addMsg = msgEl();
  const current = () => find(skuSel.value);
  function refreshProduct() {
    const s = current();
    if (!s) return;
    price.value = gift.checked || s.price == null ? '' : s.price;
    const n = shown(s.sku), low = n <= s.low_stock_at;
    stockHint.textContent = `In stock: ${n}${low ? ' (low)' : ''}`;
    stockHint.className = 'hint' + (low ? ' warnText' : '');
  }
  function addToCart() {
    const s = current();
    say(addMsg, '');
    if (!s) return;
    const q = Number(qty.value);
    if (!Number.isInteger(q) || q < 1) return say(addMsg, 'Quantity must be a whole number.', 'err');
    const isGift = gift.checked, p = isGift || price.value === '' ? null : Number(price.value);
    if (p !== null && (isNaN(p) || p < 0)) return say(addMsg, 'Invalid price.', 'err');
    const same = cart.find(l => l.sku === s.sku && !!l.gift === isGift && l.price === p);
    if (same) same.quantity += q; else cart.push({ sku: s.sku, quantity: q, price: p, gift: isGift });
    qty.value = 1; gift.checked = false; price.disabled = false; // gifting never carries over by accident
    refreshProduct(); renderCart();
  }

  // ----- cart -----
  const cartList = h('ul', { class: 'cart' });
  const emptyNote = h('p', { class: 'muted' }, 'Nothing added yet.');
  const discount = h('select', { onchange: () => renderCart() }, opt('0', 'No discount'), opt('10', '10%'), opt('15', '15%'), opt('20', '20%'));
  const date = h('input', { type: 'date', required: true, value: parisToday() });
  const channel = h('select', { onchange: () => { otherWrap.hidden = channel.value !== 'Other'; } },
    ['Market', 'Organic', 'Online', 'Other'].map(c => opt(c, c)));
  const other = h('input', { type: 'text', maxlength: 50, placeholder: 'e.g. friends, gift shop' });
  const otherWrap = h('div', { hidden: true }, fieldRow({ l: 'Other channel' }, other));
  const notes = h('textarea', { rows: 2, placeholder: 'optional' });
  const submit = h('button', { class: 'primary', type: 'submit', disabled: true }, 'Save sale');
  const tSub = h('b', {}, '€0.00'), tDisc = h('b', {}, '−€0.00'), tTotal = h('b', {}, '€0.00');
  const unpricedNote = h('p', { class: 'hint', hidden: true }, 'Items without a price are not counted in the total.');
  const bannerText = h('span');
  const banner = h('div', { class: 'banner', hidden: true }, bannerText, h('button', { type: 'button', onclick: () => resetCart() }, 'Cancel'));
  const lineText = l => `${l.quantity} × ${label(l.sku)}${l.gift ? ' — gift' : l.price == null ? ' — no price' : ' @ ' + eur.format(l.price)}`;

  function renderCart() {
    cartList.replaceChildren(...cart.map((l, i) => h('li', {}, h('span', {}, lineText(l)),
      h('button', { type: 'button', title: 'Remove', onclick: () => { cart.splice(i, 1); renderCart(); } }, '✕'))));
    emptyNote.hidden = cart.length > 0;
    const c = calc({ items: cart, discount: Number(discount.value) });
    tSub.textContent = eur.format(c.sub); tDisc.textContent = '−' + eur.format(c.disc); tTotal.textContent = eur.format(c.total);
    unpricedNote.hidden = !c.unpriced;
    submit.disabled = !cart.length;
    submit.textContent = editingId ? 'Save changes' : 'Save sale';
  }
  const readForm = () => ({ items: clone(cart), discount: Number(discount.value), date: date.value,
    channel: channel.value === 'Other' ? other.value.trim() || 'Other' : channel.value, notes: notes.value });
  function setChannel(ch) {
    if (['Market', 'Organic', 'Online'].includes(ch)) { channel.value = ch; other.value = ''; }
    else { channel.value = 'Other'; other.value = ch === 'Other' ? '' : ch || ''; }
    otherWrap.hidden = channel.value !== 'Other';
  }
  function loadIntoCart(data) {
    cart = clone(data.items); discount.value = String(data.discount); date.value = data.date; setChannel(data.channel);
    notes.value = data.notes || ''; renderCart();
  }
  function resetCart() {
    cart = []; editingId = null; discount.value = '0'; notes.value = ''; other.value = ''; banner.hidden = true; renderCart();
  }
  const confirmReplace = () => !cart.length || confirm('Replace what is in the cart?');

  const form = h('form', { class: 'card', onsubmit: ev => {
    ev.preventDefault();
    if (!cart.length) return;
    const data = readForm();
    if (editingId) {
      const o = orders.find(x => x.id === editingId);
      if (!o || o.state !== 'ok') return resetCart();
      Object.assign(o, { data, op: 'edit', state: 'queued', reqId: newId(), error: null, warn: null });
    } else orders.unshift({ id: newId(), op: 'create', state: 'queued', reqId: newId(), data, confirmed: null, saleId: null, error: null, retry: false, warn: null });
    resetCart(); persist(); renderOrders(); refreshProduct(); pump();
  } },
  banner, h('h3', { style: 'margin-top:0' }, 'Cart'), emptyNote, cartList,
  fieldRow({ l: 'Discount' }, discount),
  h('div', { class: 'stats tight' },
    h('div', { class: 'stat' }, h('span', {}, 'Subtotal'), tSub), h('div', { class: 'stat' }, h('span', {}, 'Discount'), tDisc),
    h('div', { class: 'stat strong' }, h('span', {}, 'Total'), tTotal)),
  unpricedNote,
  h('div', { class: 'grid two' }, fieldRow({ l: 'Date' }, date), fieldRow({ l: 'Channel' }, channel)),
  otherWrap, fieldRow({ l: 'Notes' }, notes), h('div', { class: 'actions' }, submit));

  // ----- background queue: a sale is kept in the browser until the server confirms it -----
  function payloadFor(o) {
    const body = { request_id: o.reqId,
      items: o.data.items.filter(l => !l.gift).map(l => ({ sku: l.sku, quantity: l.quantity, unit_price: l.price == null ? '' : l.price })),
      gifts: o.data.items.filter(l => l.gift).map(l => ({ sku: l.sku, quantity: l.quantity })),
      discount_pct: o.data.discount, date: o.data.date, channel: o.data.channel, notes: o.data.notes };
    if (o.op === 'create') return ['/saulaya/sell/order', body];
    if (o.op === 'edit') return ['/saulaya/sell/edit-order', { ...body, sale_id: o.saleId }];
    return ['/saulaya/sell/delete-order', { sale_id: o.saleId, request_id: o.reqId }];
  }
  async function send(o) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 25000);
    const [path, body] = payloadFor(o);
    let r;
    try { r = await api(path, { method: 'POST', body, signal: ctrl.signal }); }
    catch (e) {
      const transient = e.name === 'AbortError' || e instanceof TypeError || e.message === 'Server error';
      Object.assign(o, { state: 'error', retry: transient, error: e.name === 'AbortError' ? 'Timed out. It may or may not have been saved. Retry is safe.'
        : e instanceof TypeError ? 'No connection. Retry is safe.' : transient ? 'Server error. Retry is safe.' : 'Not saved: ' + e.message });
      return;
    } finally { clearTimeout(timer); }
    Object.assign(serverStock, r.on_hand || {});
    Object.assign(o, { state: 'ok', error: null, retry: false, warn: r.warnings?.length ? r.warnings.join(' ') : null });
    if (o.op === 'create') o.saleId = r.sale_id;
    if (o.op !== 'delete') o.confirmed = clone(o.data);
  }
  async function pump() {
    if (sending) return;
    const o = orders.find(x => x.state === 'queued');
    if (!o) return;
    sending = true; o.state = 'sending'; persist(); renderOrders(); refreshProduct();
    try { await send(o); } finally { sending = false; }
    persist(); renderOrders(); refreshProduct(); pump();
  }
  const retry = o => { o.state = 'queued'; o.error = null; persist(); renderOrders(); pump(); };
  function revert(o) {
    if (o.state === 'error' && o.retry && !confirm('This change may already have been saved. Check the sales list. Revert anyway?')) return;
    if (!o.confirmed) orders = orders.filter(x => x !== o);
    else Object.assign(o, { data: clone(o.confirmed), op: 'create', state: 'ok', error: null, warn: null });
    persist(); renderOrders(); refreshProduct();
  }
  function recreate(o) {
    if (o.state === 'error' && o.retry && !confirm('This sale may already be saved. Check the sales list first. Continue?')) return;
    if (!confirmReplace()) return;
    orders = orders.filter(x => x !== o); resetCart(); loadIntoCart(o.data); persist(); renderOrders(); refreshProduct();
  }
  function startEdit(o) {
    if (!confirmReplace()) return;
    editingId = o.id; loadIntoCart(o.data); bannerText.textContent = 'Editing ' + o.saleId; banner.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function del(o) {
    if (!confirm(`Delete ${o.saleId}? It is removed from the sales and logged.`)) return;
    if (editingId === o.id) resetCart();
    Object.assign(o, { op: 'delete', state: 'queued', reqId: newId(), error: null, warn: null });
    persist(); renderOrders(); refreshProduct(); pump();
  }
  const statusText = o => o.state === 'queued' ? (o.op === 'create' ? 'Waiting to send' : o.op === 'edit' ? 'Changes waiting to send' : 'Delete waiting to send')
    : o.state === 'sending' ? 'Sending…' : o.state === 'ok' ? (o.op === 'delete' ? 'Deleted' : 'Saved') : o.error || 'Failed';

  const ordersBox = h('div'), sessionCard = h('div', { class: 'card', hidden: true }, h('h3', { style: 'margin-top:0' }, 'This session'), ordersBox);
  function renderOrders() {
    sessionCard.hidden = !orders.length;
    ordersBox.replaceChildren(...orders.map(o => {
      const deleted = o.op === 'delete' && o.state === 'ok';
      const acts = [];
      if (o.state === 'queued') acts.push(o.op === 'create' ? ['Edit', () => recreate(o)] : ['Cancel change', () => revert(o)]);
      if (o.state === 'ok' && o.op !== 'delete') acts.push(['Edit', () => startEdit(o)], ['Delete', () => del(o)]);
      if (o.state === 'error') { if (o.retry) acts.push(['Retry', () => retry(o)]); acts.push(o.op === 'create' ? ['Recreate in cart', () => recreate(o)] : ['Revert change', () => revert(o)]); }
      const paid = o.data.items.some(i => !i.gift);
      return h('div', { class: 'order ' + (o.state === 'error' ? 'failed' : o.state === 'ok' ? 'done' : 'pending') + (deleted ? ' deleted' : '') },
        h('div', { class: 'top' }, h('span', {}, `${o.saleId || 'New sale'} · ${paid ? eur.format(calc(o.data).total) : 'gift only'}`), h('span', { class: 'status' }, statusText(o))),
        h('div', { class: 'lines' }, o.data.items.map(i => `${i.quantity} × ${label(i.sku)}${i.gift ? ' — gift' : i.price == null ? '' : ' @ ' + eur.format(i.price)}`).join('\n')),
        h('div', { class: 'meta' }, [o.data.date, o.data.channel, o.data.discount ? o.data.discount + '% off' : ''].filter(Boolean).join(' · ')),
        o.warn ? h('div', { class: 'meta warnText' }, o.warn) : '',
        acts.length ? h('div', { class: 'acts' }, acts.map(([t, fn]) => h('button', { type: 'button', onclick: fn }, t))) : '');
    }));
  }

  addEventListener('beforeunload', ev => { if (sellState && orders.some(o => o.state !== 'ok')) { ev.preventDefault(); ev.returnValue = ''; } });

  const el = h('div', { class: 'sellgrid' },
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Add item'),
      fieldRow({ l: 'Product' }, skuSel), stockHint,
      h('div', { class: 'grid two' },
        fieldRow({ l: 'Quantity' }, h('div', { class: 'qty' },
          h('button', { type: 'button', 'aria-label': 'Less', onclick: () => { qty.value = Math.max(1, (Number(qty.value) || 1) - 1); } }, '−'), qty,
          h('button', { type: 'button', 'aria-label': 'More', onclick: () => { qty.value = (Number(qty.value) || 0) + 1; } }, '+'))),
        fieldRow({ l: 'Unit price' }, h('div', { class: 'suffix' }, price, h('i', {}, '€')))),
      h('label', { class: 'chk' }, gift, ' Gift (free: logged as a stock adjustment, not a sale)'),
      h('button', { type: 'button', onclick: addToCart }, 'Add to cart'), addMsg),
    form, sessionCard);

  return { el, setSkus(list) {
    skus = list; serverStock = Object.fromEntries(list.map(s => [s.sku, s.on_hand]));
    const keep = skuSel.value;
    skuSel.replaceChildren(...list.map(s => opt(s.sku, skuLabel(s), s.sku === keep)));
    refreshProduct(); renderCart(); renderOrders(); pump();
  } };
}

// ---------- Report ----------
async function reportPage() {
  let last = null;
  const preset = h('select', { onchange: () => { if (preset.value !== 'custom') { applyPreset(); run(); } } },
    [['today', 'Today'], ['yesterday', 'Yesterday'], ['thisweek', 'This week (Mon–now)'], ['lastweek', 'Last week'], ['thismonth', 'This month'],
      ['lastmonth', 'Last month'], ['last7', 'Last 7 days'], ['last30', 'Last 30 days'], ['thisyear', 'This year'], ['custom', 'Custom']].map(([v, t]) => opt(v, t)));
  const mk = type => h('input', { type, oninput: () => { preset.value = 'custom'; } });
  const [from, to, fromT, toT] = [mk('date'), mk('date'), mk('time'), mk('time')];
  const out = h('div'), msg = msgEl();
  function applyPreset() { const r = presetRange(preset.value); if (r) { [from.value, to.value] = r; fromT.value = toT.value = ''; } }
  async function run() {
    say(msg, 'Loading…');
    try {
      last = await api('/saulaya/sell/report', { method: 'POST', body: { from: from.value, to: to.value, from_time: fromT.value, to_time: toT.value } });
      say(msg, ''); render(last);
    } catch (e) { say(msg, e.message, 'err'); }
  }
  const grid = (head, rows) => h('div', { class: 'tw', style: 'margin-top:6px' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
    h('tbody', {}, rows.map(r => h('tr', {}, r.map((c, i) => h('td', { class: i ? 'num' : '' }, String(c))))))));
  function render(r) {
    const s = r.summary, notes = [];
    if (r.mode === 'time_entered') notes.push('Matched by time entered, not sale date.');
    if (s.unpriced_lines) notes.push(`${s.unpriced_lines} line(s) have no price: counted in units, not in revenue.`);
    if (r.truncated) notes.push('Very large period: the CSV holds the first 20,000 lines only.');
    const tile = (l, v) => h('div', { class: 'stat' }, h('span', {}, l), h('b', {}, v));
    out.replaceChildren(h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, r.from + (r.to !== r.from ? ' → ' + r.to : '') + (r.from_time || r.to_time ? ` (${r.from_time || '00:00'}–${r.to_time || '23:59'})` : '')),
      h('div', { class: 'stats' }, tile('Net revenue', eur.format(s.net)), tile('Orders', s.orders), tile('Units', s.units), tile('Average order', eur.format(s.avg_order)),
        tile('Before discounts', eur.format(s.gross)), tile('Discounts given', eur.format(s.discount)), s.gifted_units == null ? '' : tile('Gifted units', s.gifted_units)),
      notes.map(n => h('p', { class: 'hint' }, n)),
      !s.orders ? h('p', { class: 'muted' }, 'No sales in this period.') : [
        h('h3', {}, 'By product'), grid(['Product', 'Units', 'Net'], r.by_product.map(p => [`${p.name} (${p.size})`, p.units, eur.format(p.net)])),
        h('h3', {}, 'By channel'), grid(['Channel', 'Orders', 'Net'], r.by_channel.map(c => [c.channel, c.orders, eur.format(c.net)])),
        h('h3', {}, 'By day'), grid(['Day', 'Orders', 'Net'], r.by_day.map(d => [d.day, d.orders, eur.format(d.net)])),
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => downloadCsv(last) }, 'Download CSV'))]));
  }
  applyPreset();
  const form = h('div', { class: 'card' }, fieldRow({ l: 'Period' }, preset),
    h('div', { class: 'grid two' }, fieldRow({ l: 'From' }, from), fieldRow({ l: 'Until' }, to)),
    h('details', {}, h('summary', { class: 'muted' }, 'Time of day (optional)'),
      h('div', { class: 'grid two' }, fieldRow({ l: 'From time' }, fromT), fieldRow({ l: 'Until time' }, toT)),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => { to.value = parisToday(); toT.value = parisNowHM(); preset.value = 'custom'; run(); } }, 'Until now')),
      h('p', { class: 'hint' }, 'With a time set, sales are matched by when they were entered, not by their sale date.')),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', onclick: run }, 'Run report')), msg);
  setTimeout(run, 0);
  return [h('h2', {}, 'Report'), h('div', { class: 'reportgrid' }, form, out)];
}

// Semicolon-separated, comma decimals, UTF-8 with BOM: opens correctly in French Excel
function downloadCsv(r) {
  if (!r) return;
  const cols = ['sale_id', 'date', 'created_at', 'sku', 'product', 'size', 'quantity', 'unit_price', 'discount_pct', 'line_total', 'channel', 'notes'];
  const cell = v => {
    let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v ?? '');
    if (/^[=+\-@]/.test(s) && typeof v !== 'number') s = "'" + s; // a cell that starts like a formula stays text
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(';'), ...r.rows.map(row => cols.map(c => cell(row[c])).join(';'))];
  const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })), download: `sales_${r.from}_${r.to}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Stock ----------
async function stockPage() {
  const rows = await api('/saulaya/sell/stock');
  const canEdit = me.role === 'admin' || me.role === 'editor';
  const reqIds = {};
  const list = h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Stock on hand'), rows.map(s => h('div', { class: 'sk' },
    h('div', {}, h('div', {}, skuLabel(s), s.status !== 'live' ? h('span', { class: 'tag' }, s.status) : '', s.on_hand <= s.low_stock_at ? h('span', { class: 'tag low' }, 'low') : ''),
      h('small', {}, `in ${s.in} · sold ${s.sold} · adjusted ${s.adjusted}`)),
    h('div', { class: 'n' }, String(s.on_hand)))));
  const skuSelect = () => h('select', {}, rows.map(s => opt(s.sku, skuLabel(s))));
  function stockForm(key, title, hint, path, fields, body, okText) {
    const msg = msgEl(), btn = h('button', { class: 'primary', type: 'submit' }, 'Save');
    const f = h('form', { class: 'card', oninput: () => { reqIds[key] = null; }, onsubmit: async ev => {
      ev.preventDefault();
      reqIds[key] ||= newId(); btn.disabled = true; say(msg, 'Saving…');
      try {
        const r = await api(path, { method: 'POST', body: { request_id: reqIds[key], ...body() } });
        reqIds[key] = null; say(msg, okText(r), 'ok'); route();
      } catch (e) { say(msg, 'Not saved: ' + e.message, 'err'); } finally { btn.disabled = false; }
    } }, h('h3', { style: 'margin-top:0' }, title), hint ? h('p', { class: 'hint' }, hint) : '', fields, h('div', { class: 'actions' }, btn), msg);
    return f;
  }
  if (!canEdit) return [h('h2', {}, 'Stock'), list];
  const today = () => h('input', { type: 'date', required: true, value: parisToday() });
  const [aSku, aQty, aDate, aBatch, aNotes] = [skuSelect(), h('input', { type: 'number', min: 1, step: 1, required: true }), today(), h('input', { type: 'text', maxlength: 50 }), h('input', { type: 'text', maxlength: 300 })];
  const [jSku, jQty, jDate, jReason] = [skuSelect(), h('input', { type: 'number', step: 1, required: true }), today(), h('input', { type: 'text', list: 'reasons', maxlength: 100, required: true, placeholder: 'e.g. Gift' })];
  return [h('h2', {}, 'Stock'), h('div', { class: 'sellgrid' }, list, h('div', {},
    stockForm('add', 'Add stock', 'For stock that was not made through "Make a batch": it does not take ingredients out.', '/saulaya/sell/add-stock',
      [fieldRow({ l: 'Product' }, aSku), h('div', { class: 'grid two' }, fieldRow({ l: 'Quantity' }, aQty), fieldRow({ l: 'Date' }, aDate)),
        fieldRow({ l: 'Batch ref (optional)' }, aBatch), fieldRow({ l: 'Notes (optional)' }, aNotes)],
      () => ({ sku: aSku.value, quantity: Number(aQty.value), date: aDate.value, batch_ref: aBatch.value, notes: aNotes.value }), r => `Added. On hand now: ${r.on_hand}`),
    stockForm('adj', 'Adjust stock', 'Gifts, samples, breakage, recounts. Use a minus to remove.', '/saulaya/sell/adjust',
      [fieldRow({ l: 'Product' }, jSku), h('div', { class: 'grid two' }, fieldRow({ l: 'Change (+/−)' }, jQty), fieldRow({ l: 'Date' }, jDate)),
        fieldRow({ l: 'Reason' }, jReason), h('datalist', { id: 'reasons' }, ['Gift', 'Sample', 'Breakage', 'Recount'].map(r => h('option', { value: r })))],
      () => ({ sku: jSku.value, quantity_change: Number(jQty.value), date: jDate.value, reason: jReason.value }), r => `Saved. On hand now: ${r.on_hand}`)))];
}
