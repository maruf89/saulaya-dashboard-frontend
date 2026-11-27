'use strict';
// Saulaya admin: a thin screen over the Directus API (same origin, /api/ -> Directus).
// One generic list / edit / delete engine, driven by the TABLES config below.

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'selected') e[k] = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  e.append(...kids.flat(Infinity).map(c => (c instanceof Node ? c : document.createTextNode(c ?? ''))));
  return e;
}
const toLocal = v => { if (!v) return ''; const d = new Date(v); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); };
const fmt = v => v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? '✓' : '')
  : typeof v === 'string' && /^-?\d+\.\d+$/.test(v) ? String(Math.round(v * 100) / 100)
  : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? when(new Date(v)) : v;
const when = d => d.toLocaleString(undefined, d.getHours() || d.getMinutes() ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
// Money and percent columns, by name. Labels never say "pct": the value carries the unit.
const MONEY = new Set(['price', 'pack_price', 'total', 'unit_price', 'line_total', 'sale_price', 'ingredient_cost',
  'ingredients_per_unit', 'labour_per_unit', 'packaging_per_unit', 'total_cost_per_unit', 'profit_per_unit', 'cost', 'profit', 'ingredients', 'packaging', 'labour', 'shipping_fee']);
const PCT = new Set(['discount_pct', 'margin_pct']);
const eur = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
const lbl = c => c.replace(/_pct$/, '').replace(/(.)_id$/, '$1').replace(/_/g, ' ');
function cell(c, v, row) {
  if (v == null || v === '') return '';
  if (MONEY.has(c) || (c === 'value' && String(row?.key).includes('eur'))) return eur.format(Number(v));
  if (PCT.has(c)) return `${Math.round(Number(v) * 100) / 100}%`;
  return fmt(v);
}

// an amount kept in g / ml / units, shown in the ingredient's own unit (kg, l)
const amt = (base, unit) => { const n = Number(base), r = x => Math.round(x * 10) / 10;
  return base == null ? '' : unit === 'kg' || unit === 'g' ? (Math.abs(n) >= 1000 ? r(n / 1000) + ' kg' : r(n) + ' g')
    : unit === 'l' || unit === 'ml' ? (Math.abs(n) >= 1000 ? r(n / 1000) + ' l' : r(n) + ' ml') : r(n) + (unit ? ' ' + unit : ''); };
// a bare domain gets https://; anything else that is not http(s) is no link
const webUrl = u => { u = (u || '').trim(); return /^https?:\/\//i.test(u) ? u : /^[^\s/:]+\.[^\s]+$/.test(u) ? 'https://' + u : ''; };
const tile = (label, value, cls = '') => h('div', { class: 'stat ' + cls }, h('span', {}, label), h('b', {}, value));
const isNum = v => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));

function note(text, err) {
  const n = h('div', { class: 'note' + (err ? ' err' : ''), title: 'Click to dismiss', onclick: () => n.remove() }, text);
  $('#msg').replaceChildren(n);
  if (!err) setTimeout(() => n.remove(), 4000);
}

// ---------- api (login, token refresh) ----------
// Same site by default (nginx passes /api/ to the API). config.js can point it at another address.
const API = (window.SAULAYA && window.SAULAYA.api) || '/api';
let me = null; // { id, email, name, role } once logged in
// Logins are kept in localStorage so a refresh or a closed tab does not log you out (sessionStorage if that is blocked).
const store = (() => { try { localStorage.setItem('_t', '1'); localStorage.removeItem('_t'); return localStorage; } catch { return sessionStorage; } })();
let tok = store.getItem('at'), rt = store.getItem('rt');
function setTokens(d) {
  tok = d.access_token; rt = d.refresh_token;
  store.setItem('at', tok); store.setItem('rt', rt);
}
// Directus replaces the refresh token each time it is used. Several requests failing at once must share ONE refresh
// (a second use of the old token fails and would log you out), and another open tab may already have refreshed.
let refreshing = null;
const refresh = () => refreshing ||= doRefresh().finally(() => { refreshing = null; });
async function doRefresh() {
  const saved = store.getItem('at');
  if (saved && saved !== tok) { tok = saved; rt = store.getItem('rt'); return true; }
  rt = store.getItem('rt') || rt;
  if (!rt) return false;
  const r = await fetch(API + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt, mode: 'json' }) });
  if (!r.ok) return false;
  setTokens((await r.json()).data);
  return true;
}
async function api(path, opts = {}, retry = true) {
  const r = await fetch(API + path, { ...opts,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  if (r.status === 401 && retry && await refresh()) return api(path, opts, false);
  if (r.status === 401 && tok) { logout(); throw new Error('Signed out, please log in again'); }
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.errors?.[0]?.message || j.error || r.statusText, used = /violates foreign key constraint .* on table "(\w+)"/.exec(msg);
    throw new Error(used && /^delete/i.test(msg) ? `Can't delete: it is still used in ${used[1].replace(/_/g, ' ')}. Remove it there first.` : msg);
  }
  return j.data;
}
function logout(why) { store.removeItem('at'); store.removeItem('rt'); sessionStorage.clear(); tok = rt = me = null; resetSell(); start(typeof why === 'string' ? why : ''); }

// ---------- table config ----------
const LANGS = ['en', 'fr', 'lt'], LANG_NAMES = { en: 'English', fr: 'French', lt: 'Lithuanian' };
// A field marked i18n becomes one input per language; the language picker shows one at a time.
const expand = fields => fields.flatMap(fl => fl.i18n ? LANGS.map(lang => ({ ...fl, k: fl.i18n + lang, lang, i18n: null })) : [fl]);
// f(key, type, extras): types text (default) | area | n | d | dt | b | sel (opts) | ref (ref:[table,valueKey,labelKey], num)
const f = (k, t = 'text', o = {}) => ({ k, t, ...o });
const sel = (k, opts, o) => f(k, 'sel', { opts, ...o });
const skuRef = f('sku', 'ref', { ref: ['skus', 'sku', 'sku'], l: 'sku' });
// dropdown over the ingredients table; default shows ingredients only, {} shows everything (purchases)
const ingRef = (k, l, filter = { kind: 'ingredient' }, blank = '') => f(k, 'ref', { ref: ['ingredients', 'id', 'name'], num: true, l, filter, blank });
const containerRef = f('jar_ingredient_id', 'ref', { ref: ['ingredients', 'id', 'name'], num: true, l: 'container type', filter: { kind: 'packaging', packaging_kind: 'container' } });
const labelRef = (k, l, blank) => f(k, 'ref', { ref: ['ingredients', 'id', 'name'], num: true, l, filter: { kind: 'packaging', packaging_kind: 'label' }, blank });
const STATUS = ['live', 'draft', 'discontinued']; // discontinued: no longer made; sold off while stock lasts

const TABLES = {
  sales: {
    title: 'Sales', pk: 'sale_id', sort: '-sold_at', totals: true,
    list: ['sale_id', 'sold_at', 'channel', 'discount_pct', 'notes'],
    fields: [f('sale_id'), f('sold_at', 'dt'), f('channel'), f('discount_pct', 'n', { unit: '%' }), f('notes', 'area')],
    defaults: () => ({ sold_at: new Date().toISOString(), channel: 'Market', discount_pct: 0 }),
    nextId: async () => { const [r] = await api('/items/sales?limit=1&sort=-sale_id&fields=sale_id'); return 'S-' + String((r ? +r.sale_id.slice(2) : 0) + 1).padStart(4, '0'); },
    live: saleLive,
    kids: [{ table: 'sale_lines', fk: 'sale_id', title: 'Lines',
      calc: true, fields: [skuRef, f('quantity', 'n'), f('unit_price', 'n', { unit: '€', hint: 'catalogue price' })] }],
  },
  purchases: {
    title: 'Purchases', pk: 'id', sort: '-id',
    list: ['id', 'purchased_on', 'supplier', 'description', 'total'],
    fields: [f('purchased_on', 'd'), f('supplier'), f('description'), f('total', 'n', { unit: '€' }),
      f('shipping_fee', 'n', { unit: '€', hint: 'optional' }), f('invoice_url', 'text', { l: 'invoice link', openUrl: true, hint: 'optional' }), f('invoice_file', 'file', { l: 'invoice file', hint: 'optional: PDF or photo' })],
    deleteWarn: 'The ingredients it added leave the stock again. Ingredient prices stay as they are.',
    kids: [
      { table: 'purchase_lines', fk: 'purchase_id', title: 'Ingredients', add: '+ Add Ingredient Line', prefill: true,
        fields: [ingRef('ingredient_id', 'ingredient', {}), f('packs', 'n', { l: 'packs bought' }), f('pack_size', 'n', { hint: 'size of one pack' }),
          sel('pack_unit', ['kg', 'g', 'l', 'ml', 'unit']), f('pack_price', 'n', { l: 'price per pack', unit: '€' })] },
      { table: 'purchase_extras', fk: 'purchase_id', title: 'Other items', add: '+ Add Non-Ingredient Line', need: 0,
        fields: [f('description', 'text', { l: 'what was bought', hint: 'e.g. website domain, cups' }), f('amount', 'n', { unit: '€' })] }],
  },
  adjustments: {
    title: 'Adjustments', pk: 'id', sort: '-adjusted_at',
    list: ['id', 'adjusted_at', 'sku', 'quantity_change', 'reason'],
    fields: [f('adjusted_at', 'dt'), skuRef, f('quantity_change', 'n', { hint: 'negative = out (gift, breakage)' }), f('reason', 'area')],
    defaults: () => ({ adjusted_at: new Date().toISOString() }),
  },
  recipes: {
    title: 'Recipes', pk: 'sku', sort: 'sku',
    list: ['sku', 'units_per_batch', 'labour_minutes_per_batch', 'labels_per_unit'],
    fields: [skuRef, f('ratios_from', 'ref', { ref: ['recipes', 'sku', 'sku'], filter: { ratios_from: null }, l: 'same ratios as', blank: 'own ingredient lines', hint: 'e.g. the 220g jar uses the 110g recipe' }),
      f('scale_pct', 'n', { l: 'size vs original', unit: '%', hint: '50 = half, 200 = twice', showIf: ['ratios_from', '*'], offValue: 100 }),
      f('units_per_batch', 'n', { l: 'units per batch', hint: 'a unit is a jar or a pack' }), containerRef,
      labelRef('label_ingredient_id', 'label type', 'category default'),
      f('labels_per_unit', 'n', { l: 'labels per unit' }), f('labour_minutes_per_batch', 'n'), f('batch_weight_g', 'n', { hint: 'optional, overrides the sum of the lines', showIf: ['ratios_from', ''] }),
      f('notes', 'area', { l: 'notes for making' })],
    live: recipeLive, defaults: () => ({ scale_pct: 100 }),
    kids: [{ table: 'recipe_lines', fk: 'sku', title: 'Ingredient lines (per batch)', link: 'ingredients', unless: 'ratios_from', calc: true,
      fields: [ingRef('ingredient_id', 'ingredient'), f('grams', 'n', { l: 'grams (or ml)', unit: 'g' }), f('drops', 'n')] }],
  },
  stock_batches: {
    title: 'Batches', pk: 'id', sort: '-made_at,-id',
    list: ['id', 'sku', 'made_at', 'quantity', 'batch_ref', 'notes'],
    fields: [skuRef, f('made_at', 'dt'), f('quantity', 'n', { hint: 'does not change the ingredients that were taken out' }), f('batch_ref'), f('notes', 'area')],
    defaults: () => ({ made_at: new Date().toISOString() }),
    deleteWarn: 'The units leave the stock. Ingredients the batch already took out are not put back.',
  },
  skus: {
    title: 'SKUs', pk: 'sku', sort: 'sku',
    list: ['sku', 'product_id', 'size_value', 'size_unit', 'price', 'status'],
    fields: [f('sku'), f('product_id', 'ref', { ref: ['products', 'id', 'id'] }), f('size_value', 'n'), sel('size_unit', ['ml', 'g', 'unit']),
      f('price', 'n', { unit: '€' }), sel('status', STATUS), f('low_stock_at', 'n')],
    defaults: () => ({ currency: '€', status: 'draft', low_stock_at: 3 }),
  },
  products: {
    title: 'Products', pk: 'id', sort: 'sort_order,id', order: 'sort_order', image: 'image_url',
    list: ['id', 'category_id', 'status', 'sort_order'], enrich: productNames,
    fields: [f('id'), f('category_id', 'ref', { ref: ['categories', 'id', 'id'] }), sel('status', STATUS), f('image_url')],
    defaults: () => ({ status: 'draft' }), panel: productIngredients,
    kids: [
      { table: 'product_translations', fk: 'product_id', title: 'Translations', tabs: 'lang', langs: ['en', 'fr', 'lt'],
        fields: [f('name'), f('short_description', 'area'), f('full_description', 'area'), f('usage', 'area'),
          f('benefits', 'area'), f('storage', 'area'), f('seo_title'), f('seo_description', 'area')] },
    ],
  },
  ingredients: {
    title: 'Ingredients', pk: 'id', sort: 'name',
    list: ['id', 'name', 'kind', 'packaging_kind', 'supplier', 'pack_size', 'pack_unit', 'pack_price'], hide: ['id', 'packaging_kind', 'pack_unit'],
    enrich: async rows => {
      const st = Object.fromEntries((await view('ingredient_stock')).map(s => [s.id, s]));
      rows.forEach(r => { const s = st[r.id];
        if (r.packaging_kind) r.kind += ' · ' + r.packaging_kind; r.pack_size = r.pack_size == null ? null : `${fmt(r.pack_size)} ${r.pack_unit || ''}`;
        r.in_stock = s ? amt(s.on_hand_base, s.unit) + (s.is_low ? ' · low' : '') : ''; });
    },
    defaults: () => ({ kind: 'ingredient' }),
    fields: [f('name'), sel('kind', ['ingredient', 'packaging']), sel('packaging_kind', ['container', 'label', 'other'], { showIf: ['kind', 'packaging'] }),
      f('organic', 'b'), f('supplier'), f('pack_size', 'n'), sel('pack_unit', ['kg', 'g', 'l', 'ml', 'unit']),
      f('pack_price', 'n', { unit: '€' }), f('link', 'text', { openUrl: true }), f('notes', 'area')],
    kids: [{ table: 'ingredient_translations', fk: 'ingredient_id', title: 'Display names on the label', tabs: 'lang',
      fields: [f('name', 'text', { l: 'display name' })] }],
  },
  categories: {
    title: 'Categories', pk: 'id', sort: 'sort_order,id', order: 'sort_order',
    list: ['id', 'sort_order'], enrich: categoryNames,
    fields: [f('id'), labelRef('label_ingredient_id', 'default label', 'none')],
    kids: [{ table: 'category_translations', fk: 'category_id', title: 'Name', tabs: 'lang', fields: [f('name')] }],
  },
  settings: {
    title: 'Settings', pk: 'key', sort: 'key',
    list: ['key', 'value'], fields: [f('key'), f('value', 'n', { unit: '€' })],
  },
};
const NAV = [
  ['Day to day', [['overview', 'Overview'], ['sell', 'Sell'], ['report', 'Report'], ['stock', 'Stock'], ['sales', 'Sales'], ['batch', 'Make a batch'], ['purchases', 'Purchases'], ['adjustments', 'Adjustments']]],
  ['Making', [['recipes', 'Recipes'], ['ingredients', 'Ingredients'], ['costs', 'Costs']]],
  ['Catalogue', [['products', 'Products'], ['skus', 'SKUs'], ['categories', 'Categories']]],
  ['Admin', [['users', 'Users'], ['history', 'History'], ['settings', 'Settings']]]];
// Admin and editor see every page. This only hides things: the API refuses what a role may not do.
const ACCESS = { analyst: ['overview', 'report', 'stock'], clerk: ['sell'] };
const canOpen = p => p === 'history' ? me.role === 'admin' : me.role === 'admin' || me.role === 'editor' || (ACCESS[me.role] || []).includes(p);
const isEditor = () => me.role === 'admin' || me.role === 'editor';
const landing = () => me.role === 'clerk' ? 'sell' : 'overview';

// ---------- form fields ----------
let refCache = {};
const refKey = fl => fl.ref[0] + JSON.stringify(fl.filter || {});
async function loadRefs(fields) {
  for (const fl of fields.filter(x => x.t === 'ref')) {
    const [t, val, lab] = fl.ref;
    const q = Object.entries(fl.filter || {}).map(([c, v]) => `&filter[${c}][${v === null ? '_null' : '_eq'}]=${v === null ? 'true' : encodeURIComponent(v)}`).join('');
    if (!refCache[refKey(fl)]) refCache[refKey(fl)] = await api(`/items/${t}?limit=-1&sort=${lab}&fields=${val},${lab}${q}`);
  }
}
function fieldInput(fl, v, ro) {
  let el;
  const blank = h('option', { value: '' }, fl.blank || '');
  switch (fl.t) {
    case 'area': el = h('textarea', { rows: 3 }, v ?? ''); break;
    case 'b': el = h('input', { type: 'checkbox', checked: !!v }); break;
    case 'sel': el = h('select', {}, blank, fl.opts.map(o => h('option', { value: o, selected: o === v }, o))); break;
    case 'ref': { const [t, val, lab] = fl.ref;
      el = h('select', {}, blank, refCache[refKey(fl)].map(o => h('option', { value: o[val], selected: String(o[val]) === String(v) }, o[lab]))); break; }
    case 'file': el = fileBox(v); break;
    case 'n': el = h('input', { type: 'number', step: 'any', value: v ?? '' }); break;
    case 'd': el = h('input', { type: 'date', value: v ?? '' }); break;
    case 'dt': el = h('input', { type: 'datetime-local', value: toLocal(v) }); break;
    default: el = h('input', { type: 'text', value: v ?? '' });
  }
  el.disabled = !!ro;
  return el;
}
// An uploaded file (Directus /files): the box holds the file's id as its value, so it reads like any field.
function fileBox(id) {
  const el = h('div', { class: 'filebox' }), info = h('span', { class: 'muted' });
  const pick = h('input', { type: 'file', accept: 'application/pdf,image/*' });
  const open = h('button', { type: 'button', onclick: async () => {
    const w = window.open('', '_blank'); // opened first so the browser does not block it
    try {
      const r = await fetch(`${API}/assets/${el.value}`, { headers: { Authorization: 'Bearer ' + tok } });
      if (!r.ok) throw new Error('Could not open the file');
      w.location = URL.createObjectURL(await r.blob());
    } catch (e) { w.close(); note(e.message, true); }
  } }, 'Open ↗');
  const clear = h('button', { type: 'button', onclick: () => { el.value = ''; sync(); el.dispatchEvent(new Event('input', { bubbles: true })); } }, 'Remove');
  const sync = () => { info.textContent = el.value ? 'File attached' : 'No file'; open.hidden = clear.hidden = !el.value; };
  pick.addEventListener('change', async () => {
    if (!pick.files[0]) return;
    const send = () => { const fd = new FormData(); fd.append('file', pick.files[0]);
      return fetch(API + '/files', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd }); };
    try {
      let r = await send();
      if (r.status === 401 && await refresh()) r = await send();
      if (!r.ok) throw new Error('Upload failed');
      el.value = (await r.json()).data.id; sync(); el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) { note(e.message, true); }
    pick.value = '';
  });
  el.value = id ?? ''; el.append(info, open, clear, pick); sync();
  return el;
}
function readField(fl, el) {
  if (fl.t === 'b') return el.checked;
  if (el.value === '') return null;
  if (fl.t === 'n' || fl.num) return Number(el.value);
  if (fl.t === 'dt') return new Date(el.value).toISOString();
  return el.value;
}
function urlButton(el) {
  const a = h('a', { class: 'btn', target: '_blank', rel: 'noopener noreferrer', title: 'Open this link in a new tab' }, 'Open ↗');
  const set = () => {
    const full = webUrl(el.value);
    a.hidden = !full; if (full) a.href = full;
  };
  el.addEventListener('input', set); set();
  return h('div', { class: 'withbtn' }, el, a);
}
const fieldRow = (fl, el) => h('label', { class: 'f' + (fl.t === 'area' ? ' wide' : ''), 'data-lang': fl.lang },
  h('span', {}, fl.l || lbl(fl.k)), fl.unit ? h('div', { class: 'suffix' }, el, h('i', {}, fl.unit)) : fl.openUrl ? urlButton(el) : el,
  fl.hint ? h('small', {}, fl.hint) : '');

// ---------- generic table ----------
// Click a header to sort, click again to flip. Sorting reorders the existing rows, so row state survives.
const sortKey = v => v == null || v === '' ? null : typeof v === 'number' ? v : typeof v === 'boolean' ? +v
  : Array.isArray(v) ? v.join(', ').toLowerCase() : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : String(v).toLowerCase();
const compare = (a, b) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });

function table(rows, href, { hide = [], drag = false } = {}) {
  if (!rows.length) return h('p', { class: 'muted' }, 'Nothing here yet.');
  const cols = Object.keys(rows[0]).filter(c => !hide.includes(c));
  let col = null, dir = 1;
  const num = Object.fromEntries(cols.map(c => [c, rows.some(r => isNum(r[c]))]));
  const ths = cols.map(c => h('th', { class: 'sort' + (num[c] ? ' num' : ''), title: 'Click to sort', onclick: () => sortBy(c) }, lbl(c), h('i', {})));
  const body = h('tbody', {}, rows.map((r, i) => {
    const tr = h('tr', href ? { class: 'click', onclick: () => { location.hash = href(r); } } : {},
      drag ? h('td', { class: 'grip', title: 'Drag to reorder', onclick: e => e.stopPropagation() }, '⋮⋮') : '',
      cols.map(c => h('td', { class: (num[c] ? 'num' : '') + ((MONEY.has(c) || PCT.has(c)) && Number(r[c]) < 0 ? ' neg' : ''), title: cell(c, r[c], r) }, cell(c, r[c], r))));
    tr._row = r; tr._i = i;
    return tr;
  }));
  function sortBy(c) { // null = back to the original (manual) order
    if (c === null) col = null; else { dir = col === c ? -dir : 1; col = c; }
    body.append(...[...body.children].sort((x, y) => {
      if (col === null) return x._i - y._i;
      const a = sortKey(x._row[col]), b = sortKey(y._row[col]);
      if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1; // blanks last, either direction
      return dir * compare(a, b);
    }));
    ths.forEach((th, i) => { th.lastChild.textContent = cols[i] === col ? (dir > 0 ? ' ▲' : ' ▼') : ''; });
    wrap.dispatchEvent(new CustomEvent('sorted', { detail: col !== null }));
  }
  const first = drag ? h('th', { class: 'sort', title: 'Back to manual order', onclick: () => sortBy(null) }) : '';
  const wrap = h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, first, ths)), body));
  return wrap;
}
const view = name => api('/saulaya/view/' + name);

// ---------- pages ----------
async function productNames(rows) {
  const en = Object.fromEntries((await api('/items/product_translations?limit=-1&filter[lang][_eq]=en&fields=product_id,name'))
    .map(t => [t.product_id, t.name]));
  rows.forEach(r => { const { id, ...rest } = r; Object.keys(r).forEach(k => delete r[k]); Object.assign(r, { id, name: en[id] ?? '' }, rest); });
}
async function categoryNames(rows) {
  const en = Object.fromEntries((await api('/items/category_translations?limit=-1&filter[lang][_eq]=en&fields=category_id,name'))
    .map(t => [t.category_id, t.name]));
  rows.forEach(r => { r.name = en[r.id] ?? ''; });
}
async function listPage(cfg, table_) {
  const rows = await api(`/items/${table_}?limit=500&sort=${cfg.sort}&fields=${cfg.list.join(',')}`);
  if (cfg.enrich) await cfg.enrich(rows);
  if (cfg.totals) {
    const sums = {};
    for (const l of await view('sale_line_totals')) sums[l.sale_id] = (sums[l.sale_id] || 0) + Number(l.line_total);
    rows.forEach(r => { r.total = Math.round((sums[r.sale_id] || 0) * 100) / 100; });
  }
  const body = table(rows, r => `#/${table_}/${encodeURIComponent(r[cfg.pk])}`, { hide: [...(cfg.order ? [cfg.order] : []), ...(cfg.hide || [])], drag: !!cfg.order });
  let sorter, sorted = false, filtered = false;
  const syncSorter = () => sorter?.option('disabled', sorted || filtered);
  body.addEventListener('sorted', e => { sorted = e.detail; syncSorter(); });
  if (cfg.order && rows.length) {
    const pks = rows.map(r => String(r[cfg.pk])), was = Object.fromEntries(rows.map(r => [String(r[cfg.pk]), r[cfg.order]]));
    // each row remembers its key, so the new order can be read back from the DOM after a drop
    body.querySelectorAll('tbody tr').forEach((tr, i) => { tr.dataset.pk = pks[i]; });
    sorter = new Sortable(body.querySelector('tbody'), { handle: '.grip', animation: 150, onEnd: async () => {
      const ids = [...body.querySelectorAll('tbody tr')].map(tr => tr.dataset.pk);
      try {
        for (const [i, id] of ids.entries())
          if (was[id] !== i + 1) { await api(`/items/${table_}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { [cfg.order]: i + 1 } }); was[id] = i + 1; }
        note('Order saved');
      } catch (e) { note(e.message, true); route(); }
    } });
  }
  const search = h('input', { type: 'search', placeholder: 'Filter…', oninput: e => {
    const q = e.target.value.toLowerCase();
    body.querySelectorAll('tbody tr').forEach(tr => { tr.hidden = !tr.textContent.toLowerCase().includes(q); });
    filtered = !!q; syncSorter(); // reordering a filtered or sorted list would renumber the rows wrongly
  } });
  return [h('div', { class: 'bar' }, h('h2', { style: 'margin:0' }, cfg.title), search,
    h('button', { class: 'primary', onclick: () => { location.hash = `#/${table_}/new`; } }, '+ New')), body];
}

// Read-only: worked out from the product's recipes. Edit the amounts in the recipe, the names in the ingredient.
async function productIngredients(id) {
  const [rows, skus, recipes] = await Promise.all([view('product_ingredients'),
    api(`/items/skus?limit=-1&fields=sku&filter[product_id][_eq]=${encodeURIComponent(id)}`), api('/items/recipes?limit=-1&fields=sku')]);
  const mine = rows.filter(r => r.product_id === id).sort((a, b) => b.share - a.share);
  const have = new Set(recipes.map(r => r.sku));
  const list = mine.map(r => {
    const tr = h('tr', { class: 'ing' }, h('td', {}, h('span', { class: 'disp' })),
      h('td', { class: 'num' }, Math.round(r.share * 1000) / 10 + '%'),
      h('td', { class: 'sharecol' }, h('div', { class: 'share' }, h('i', { style: `width:${Math.max(r.share * 100, 1)}%` }))),
      h('td', { class: 'num' }, h('a', { href: `#/ingredients/${r.ingredient_id}` }, 'Open ↗')));
    tr._ing = r.ingredient_id; tr._disp = tr.querySelector('.disp'); paintRow(tr);
    return tr;
  });
  return [h('h3', {}, 'Ingredients ', h('small', {}, 'from the recipes, largest first · edit amounts in the recipe, names in the ingredient')),
    list.length ? h('div', { class: 'tw' }, h('table', {}, h('tbody', {}, list)))
      : h('p', { class: 'muted' }, 'No ingredients yet: add them to a recipe for one of this product\'s SKUs.'),
    h('div', { class: 'chips' }, h('span', { class: 'muted' }, 'Recipes'), skus.map(s => have.has(s.sku)
      ? h('a', { class: 'chip', href: `#/recipes/${encodeURIComponent(s.sku)}` }, s.sku + ' ↗')
      : h('span', { class: 'chip off' }, s.sku + ' · no recipe')))];
}
// Live costing while a recipe is edited: per line, per batch and per unit, same sums as the recipe_cost_per_unit view.
async function recipeLive({ val, rows }) {
  const [costs, ings, settings, skus, products, cats] = await Promise.all([view('ingredient_costs'),
    api('/items/ingredients?limit=-1&fields=id,pack_unit'), api('/items/settings?limit=-1'),
    api('/items/skus?limit=-1&fields=sku,price,product_id'), api('/items/products?limit=-1&fields=id,category_id'),
    api('/items/categories?limit=-1&fields=id,label_ingredient_id')]);
  const per = Object.fromEntries(costs.map(c => [c.id, c.cost_per_base == null ? null : Number(c.cost_per_base)]));
  const bulk = Object.fromEntries(ings.map(i => [i.id, ({ kg: [1000, 'kg'], g: [1000, 'kg'], l: [1000, 'l'], ml: [1000, 'l'] })[i.pack_unit] || [1, 'unit']]));
  const rate = Number(settings.find(s => s.key === 'labour_rate_eur_per_hour')?.value ?? 0);
  const baseLines = {}, el = h('div', { class: 'card live' });
  const money = v => v == null || !isFinite(v) ? '—' : eur.format(v);
  const sum = a => a.reduce((x, y) => x + y, 0);
  let busy = 0;
  async function run() {
    const ticket = ++busy, base = val('ratios_from');
    let lines;
    if (base) {
      baseLines[base] ||= await api(`/items/recipe_lines?limit=-1&fields=ingredient_id,grams&filter[sku][_eq]=${encodeURIComponent(base)}`);
      const k = (Number(val('scale_pct')) || 100) / 100; // size as a share of the original recipe
      lines = baseLines[base].map(l => ({ id: l.ingredient_id, g: Number(l.grams) * k }));
    } else lines = rows().map(r => ({ id: Number(r._els[0].value), g: Number(r._els[1].value) || 0, row: r }));
    if (ticket !== busy) return; // a newer edit is already being worked out
    const grams = sum(lines.map(l => l.g));
    for (const l of lines) {
      l.cost = per[l.id] == null ? null : l.g * per[l.id];
      if (!l.row?._calc) continue;
      const [n, u] = bulk[l.id] || [1000, 'kg'];
      l.row._calc.textContent = !l.id ? '' : per[l.id] == null ? 'no price yet'
        : `${money(l.cost)} · ${grams ? Math.round(1000 * l.g / grams) / 10 : 0}% · ${money(per[l.id] * n)}/${u}`;
      l.row._calc.classList.toggle('warn', l.id && per[l.id] == null);
    }
    const units = Number(val('units_per_batch')) || 0;
    const sku = skus.find(s => s.sku === val('sku')), prod = products.find(p => p.id === sku?.product_id);
    const label = val('label_ingredient_id') || cats.find(c => c.id === prod?.category_id)?.label_ingredient_id;
    const ingBatch = sum(lines.map(l => l.cost || 0));
    const missing = [!units && 'units per batch', lines.some(l => l.id && l.cost == null) && 'ingredient prices',
      !val('jar_ingredient_id') ? 'container' : per[val('jar_ingredient_id')] == null && 'container price',
      !label ? 'label' : per[label] == null && 'label price', !val('labour_minutes_per_batch') && 'labour minutes',
      sku?.price == null && 'sale price'].filter(Boolean);
    const pu = v => units ? v / units : null;
    const ingU = pu(ingBatch), packU = (per[val('jar_ingredient_id')] || 0) + (Number(val('labels_per_unit')) || 0) * (per[label] || 0);
    const labU = pu((Number(val('labour_minutes_per_batch')) || 0) / 60 * rate);
    const total = units ? ingU + packU + labU : null, price = sku?.price == null ? null : Number(sku.price);
    const profit = total == null || price == null ? null : price - total;
    el.replaceChildren(h('h3', {}, 'Costs as you edit ', h('small', {}, 'not saved until you press Save')),
      h('div', { class: 'stats' },
        tile('Batch', `${Math.round(Number(val('batch_weight_g')) || grams)} g → ${units || '?'} units`),
        tile('Ingredients per batch', money(ingBatch)),
        tile('Ingredients per unit', money(ingU)), tile('Packaging per unit', money(packU)), tile('Labour per unit', money(labU)),
        tile('Total cost per unit', money(total), 'strong'), tile('Sale price', money(price)),
        tile('Profit per unit', money(profit), profit < 0 ? 'bad' : ''),
        tile('Margin', profit == null || !price ? '—' : Math.round(1000 * profit / price) / 10 + '%', profit < 0 ? 'bad' : '')),
      missing.length ? h('p', { class: 'warn' }, 'Missing, counted as €0: ' + missing.join(', ')) : '');
  }
  return { el, run };
}
// Running total for a sale, the same sum as the sale_line_totals view: blank unit price = catalogue price.
async function saleLive({ val, rows }) {
  const price = Object.fromEntries((await api('/items/skus?limit=-1&fields=sku,price')).map(s => [s.sku, s.price == null ? null : Number(s.price)]));
  const el = h('div', { class: 'card live' });
  function run() {
    const lines = rows().map(r => {
      const qty = Number(r._els[1].value) || 0, unit = r._els[2].value === '' ? price[r._els[0].value] : Number(r._els[2].value);
      r._calc.textContent = r._els[0].value && qty && unit != null ? `${qty} × ${eur.format(unit)} = ${eur.format(qty * unit)}` : '';
      return { qty, sum: qty * (unit || 0) };
    });
    const sub = lines.reduce((a, l) => a + l.sum, 0), disc = sub * (Number(val('discount_pct')) || 0) / 100;
    el.replaceChildren(h('div', { class: 'stats' }, tile('Items', lines.reduce((a, l) => a + l.qty, 0)), tile('Subtotal', eur.format(sub)),
      tile('Discount', '−' + eur.format(disc)), tile('Total', eur.format(sub - disc), 'strong')));
  }
  return { el, run };
}
let curLang = 'en', ingCache = {}, dispCache = {}, ingDef = {};
async function loadDisplay(needed) {
  if (!needed) return;
  ingCache = Object.fromEntries((await api('/items/ingredients?limit=-1&fields=id,name,organic')).map(i => [i.id, i]));
  dispCache = {};
  for (const t of await api('/items/ingredient_translations?limit=-1&fields=ingredient_id,lang,name')) (dispCache[t.ingredient_id] ||= {})[t.lang] = t.name;
}
// read-only: what the label prints for the picked ingredient, in the language chosen in the picker
function paintRow(row) {
  const id = row._ing, i = ingCache[id];
  row._disp.textContent = i ? (dispCache[id]?.[curLang] || dispCache[id]?.en || i.name) + (i.organic ? ' · organic' : '') : '—';
}
const kidRow = (kid, row) => {
  const locked = kid.appendOnly && row;
  const fields = expand(kid.fields);
  const els = fields.map(fl => fieldInput(fl, row?.[fl.k], locked));
  const open = kid.link ? h('a', { class: 'open', title: 'Open in ' + kid.link, onclick: e => {
    if (div.closest('form')?.dataset.dirty && !confirm('You have unsaved changes. Leave without saving?')) e.preventDefault();
  } }, 'Open ↗') : '';
  const calc = kid.calc ? h('span', { class: 'calc' }) : '';
  const div = h('div', { class: 'kidrow' + (kid.order ? ' ordered' : '') + (kid.tabs ? '' : ' line'), 'data-id': row?.id ?? '' },
    kid.order ? h('span', { class: 'grip', title: 'Drag to reorder' }, '⋮⋮') : '',
    h('div', { class: 'grid' }, fields.map((fl, i) => kid.tabs ? fieldRow(fl, els[i]) : (els[i].placeholder = fl.hint || '', fieldRow({ ...fl, hint: '' }, els[i]))), calc, open),
    locked || kid.tabs ? '' : h('button', { type: 'button', class: 'x', title: 'Remove', onclick: () => { const fm = div.closest('form'); div.remove(); fm?.dispatchEvent(new Event('input')); } }, '✕'));
  div._fields = fields; div._els = els; div._calc = calc;
  if (kid.prefill) els[0].addEventListener('change', () => { // a new pack size and price per purchase: start from the ingredient's current ones
    const d = ingDef[els[0].value];
    if (d) { [els[2].value, els[3].value, els[4].value] = [d.pack_size ?? '', d.pack_unit ?? '', d.pack_price ?? '']; els[2].dispatchEvent(new Event('input', { bubbles: true })); }
  });
  if (kid.link) {
    const set = () => { open.hidden = !els[0].value; open.href = `#/${kid.link}/${encodeURIComponent(els[0].value)}`; };
    els[0].addEventListener('change', set); set();
  }
  return div;
};
const rowData = (kid, d, pos) => ({ ...Object.fromEntries(d._fields.map((fl, i) => [fl, d._els[i]])
  .filter(([, el]) => !el.disabled).map(([fl, el]) => [fl.k, readField(fl, el)])), ...(kid.order ? { [kid.order]: pos + 1 } : {}),
  ...(kid.tabs ? { [kid.tabs]: d.dataset.lang } : {}) });

async function syncKids(kid, pk, box, existing) {
  const rows = [...box.children].filter(d => d._els);
  const keep = new Set(rows.map(d => d.dataset.id).filter(Boolean));
  for (const e of existing) if (!keep.has(String(e.id))) await api(`/items/${kid.table}/${e.id}`, { method: 'DELETE' });
  const old = rows.filter(d => d.dataset.id);
  // positions are unique per product, so park the rows out of the way first: swapping 1 and 2 would collide
  if (kid.order) for (const d of old) await api(`/items/${kid.table}/${d.dataset.id}`, { method: 'PATCH', body: { [kid.order]: -Number(d.dataset.id) } });
  if (!kid.appendOnly) for (const d of old) await api(`/items/${kid.table}/${d.dataset.id}`, { method: 'PATCH', body: rowData(kid, d, rows.indexOf(d)) });
  // a language with nothing typed in is not saved as an empty translation
  const fresh = rows.filter(d => !d.dataset.id && (!kid.tabs || d._els.some(e => e.value.trim())) && (kid.need == null || d._els[kid.need].value.trim())).map(d => ({ ...rowData(kid, d, rows.indexOf(d)), [kid.fk]: pk }));
  if (fresh.length) await api(`/items/${kid.table}`, { method: 'POST', body: fresh }); // one request = one transaction
}

// One pane per language. The picker decides which pane shows.
function translationsBox(kid, existing) {
  const panes = LANGS.map(lang => {
    const pane = kidRow(kid, existing.find(r => r[kid.tabs] === lang) || { [kid.tabs]: lang });
    pane.dataset.lang = lang;
    return pane;
  });
  return h('div', { class: 'kids' }, h('div', {}, h('div', {}, ...panes)));
}

async function recordPage(cfg, table_, id) {
  const isNew = id === 'new', kids = cfg.kids || [];
  await loadRefs([...cfg.fields, ...kids.flatMap(k => k.fields)]);
  await loadDisplay(cfg.panel);
  if (kids.some(k => k.prefill)) ingDef = Object.fromEntries((await api('/items/ingredients?limit=-1&fields=id,pack_size,pack_unit,pack_price')).map(i => [i.id, i]));
  let rec = {}, existing = kids.map(() => []);
  if (isNew) {
    rec = { ...(cfg.defaults?.() || {}), ...Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || '')) };
    if (cfg.nextId) rec[cfg.pk] = await cfg.nextId();
  } else {
    rec = await api(`/items/${table_}/${encodeURIComponent(id)}`);
    existing = await Promise.all(kids.map(k =>
      api(`/items/${k.table}?limit=-1&sort=${k.sort || 'id'}&filter[${k.fk}][_eq]=${encodeURIComponent(id)}`)));
  }
  const els = cfg.fields.map(fl => fieldInput(fl, rec[fl.k], !isNew && fl.k === cfg.pk));
  const boxes = kids.map((kid, i) => {
    if (kid.tabs) return translationsBox(kid, existing[i]);
    const box = h('div', {}, existing[i].map(r => kidRow(kid, r)));
    if (kid.order) new Sortable(box, { handle: '.grip', animation: 150 });
    return h('div', { class: 'kids' }, h('div', {}, box, kid.appendOnly ? h('p', { class: 'muted' }, kid.appendOnly) : ''),
      h('button', { type: 'button', onclick: () => box.append(kidRow(kid)) }, kid.add || '+ Add line'));
  });
  const heads = kids.map(kid => h('h3', {}, kid.title));
  const boxOf = i => boxes[i].firstChild.firstChild;
  const panel = isNew || !cfg.panel ? '' : await cfg.panel(id);
  // a recipe that takes its ratios from another has no lines of its own: hide them while that is chosen
  const unlessEl = kid => els[cfg.fields.findIndex(fl => fl.k === kid.unless)];
  const syncUnless = () => kids.forEach((kid, i) => { if (kid.unless) [heads[i], boxes[i]].forEach(e => { e.hidden = !!unlessEl(kid).value; }); });

  async function onSave(ev) {
    ev.preventDefault();
    const data = {};
    cfg.fields.forEach((fl, i) => { if (!els[i].disabled || fl.showIf) data[fl.k] = readField(fl, els[i]); });
    try {
      let pk = id;
      if (isNew && cfg.order) { const [m] = await api(`/items/${table_}?limit=1&sort=-${cfg.order}&fields=${cfg.order}`); data[cfg.order] = (m ? m[cfg.order] : 0) + 1; }
      if (isNew) pk = (await api(`/items/${table_}`, { method: 'POST', body: data }))[cfg.pk];
      else await api(`/items/${table_}/${encodeURIComponent(id)}`, { method: 'PATCH', body: data });
      try {
        for (const [i, kid] of kids.entries()) if (!(kid.unless && unlessEl(kid).value)) await syncKids(kid, pk, boxOf(i), existing[i]);
      } catch (e) {
        if (isNew) await api(`/items/${table_}/${encodeURIComponent(pk)}`, { method: 'DELETE' }).catch(() => {}); // undo the half-made record
        throw e;
      }
      location.hash = `#/${table_}`;
      note('Saved');
    } catch (e) { note(e.message, true); }
  }
  async function onDelete() {
    if (!confirm(`Delete this ${cfg.title.replace(/s$/, '').toLowerCase()}?\n${cfg.deleteWarn || ''}`)) return;
    try { await api(`/items/${table_}/${encodeURIComponent(id)}`, { method: 'DELETE' }); location.hash = `#/${table_}`; note('Deleted'); }
    catch (e) { note(e.message, true); }
  }

  // one language at a time: English by default, the picker shows the others only when chosen
  const hasLang = kids.some(k => k.tabs || expand(k.fields).some(fl => fl.lang));
  let formEl;
  const setLang = lang => { curLang = lang; formEl.querySelectorAll('[data-lang]').forEach(e => { e.hidden = e.dataset.lang !== lang; }); formEl.querySelectorAll('.ing').forEach(paintRow); };
  const filled = lang => [...formEl.querySelectorAll(`[data-lang="${lang}"] input, [data-lang="${lang}"] textarea`)]
    .some(e => e.type !== 'checkbox' && e.value.trim());
  const picker = h('select', { class: 'langpick', onchange: e => setLang(e.target.value) },
    LANGS.map(l => h('option', { value: l }, LANG_NAMES[l])));
  const refreshPicker = () => [...picker.options].forEach(o => { o.textContent = LANG_NAMES[o.value] + (filled(o.value) ? '' : ' · empty'); });
  formEl = h('form', { onsubmit: onSave, oninput: () => { formEl.dataset.dirty = '1'; refreshPicker(); } },
    h('div', { class: 'card' }, h('div', { class: 'grid' }, cfg.fields.map((fl, i) => fieldRow(fl, els[i])))),
    panel,
    kids.map((kid, i) => [heads[i], boxes[i]]),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', type: 'submit' }, 'Save'),
      h('button', { type: 'button', onclick: () => { location.hash = `#/${table_}`; } }, 'Cancel'),
      h('span', { class: 'sp' }),
      isNew ? '' : h('button', { type: 'button', class: 'danger', onclick: onDelete }, 'Delete')));
  cfg.fields.forEach((fl, i) => {
    if (!fl.showIf) return;
    const src = els[cfg.fields.findIndex(x => x.k === fl.showIf[0])];
    // showIf: [field, value]: enabled when that field equals value ('*' = anything chosen). Off = disabled and reset.
    const sync = () => { const off = fl.showIf[1] === '*' ? !src.value : src.value !== fl.showIf[1]; els[i].disabled = off; if (off) els[i].value = fl.offValue ?? ''; };
    src.addEventListener('change', sync); sync();
  });
  kids.forEach(kid => kid.unless && unlessEl(kid).addEventListener('change', syncUnless)); syncUnless();
  if (hasLang) { setLang('en'); refreshPicker(); }
  if (cfg.image) {
    const src = els[cfg.fields.findIndex(fl => fl.k === cfg.image)], img = h('img', { class: 'preview', alt: '' });
    const show = () => { img.src = src.value.trim(); img.hidden = !src.value.trim(); };
    src.addEventListener('input', show); show();
    formEl.querySelector('.card').append(img);
  }
  if (cfg.live) {
    const live = await cfg.live({ val: k => els[cfg.fields.findIndex(fl => fl.k === k)].value,
      rows: () => kids.flatMap((kid, i) => kid.tabs ? [] : [...boxOf(i).children].filter(d => d._els)) });
    formEl.insertBefore(live.el, formEl.querySelector('.actions'));
    formEl.addEventListener('input', live.run); formEl.addEventListener('change', live.run); live.run();
  }
  return [h('div', { class: 'bar head' }, h('h2', {}, h('a', { class: 'crumb', href: `#/${table_}` }, cfg.title), ' › ', isNew ? 'New' : rec.name || id),
    h('span', { class: 'sp' }), hasLang ? h('label', { class: 'lang' }, h('span', { class: 'muted' }, 'Language'), picker) : ''),
    formEl];
}

async function overviewPage() {
  const full = isEditor(); // analysts get the sales and stock figures, not recipes or ingredients
  const [stock, lines, gaps, ing, recipes] = await Promise.all([view('sku_stock'), view('sale_line_totals'),
    full ? view('recipe_gaps') : [], full ? view('ingredient_stock') : [], full ? api('/items/recipes?limit=-1&fields=sku') : []]);
  const since = Date.now() - 30 * 864e5, recent = lines.filter(l => new Date(l.sold_at) >= since);
  const unused = r => r.status !== 'live' && (r.status === 'discontinued' ? Number(r.on_hand) <= 0 : Number(r.on_hand) === 0); // draft or sold-out discontinued: not worth showing
  const low = stock.filter(r => r.is_low && r.status === 'live').sort((a, b) => a.on_hand - b.on_hand);
  const have = new Set(recipes.map(r => r.sku)), sum = a => a.reduce((x, y) => x + Number(y || 0), 0);
  const stocked = ing.filter(r => Number(r.on_hand_base)), restock = ing.filter(r => r.is_low).sort((a, b) => a.name.localeCompare(b.name));
  return [h('h2', {}, 'Overview'),
    h('div', { class: 'stats' },
      tile('Sales, last 30 days', eur.format(sum(recent.map(l => l.line_total)))),
      tile('Units sold, last 30 days', sum(recent.map(l => l.quantity))),
      tile('Units in stock', sum(stock.map(r => r.on_hand))),
      tile('Low on stock', low.length, low.length ? 'bad' : ''),
      full ? tile('Ingredients to restock', restock.length, restock.length ? 'bad' : '') : '',
      full ? tile('Recipes incomplete', gaps.length, gaps.length ? 'warnt' : '') : ''),
    h('h3', {}, 'Low on stock'),
    low.length ? table(low.map(r => ({ sku: r.sku, on_hand: r.on_hand, low_stock_at: r.low_stock_at })), full ? r => `#/skus/${encodeURIComponent(r.sku)}` : null)
      : h('p', { class: 'muted' }, 'Every SKU is above its low-stock level.'),
    full ? [h('h3', {}, 'Ingredients to restock ', h('small', {}, 'less in stock than one batch of a live SKU needs')),
      restock.length ? h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, ['Ingredient', 'On hand', 'One batch needs', 'For', 'Restock'].map((t, i) => h('th', { class: i === 1 || i === 2 ? 'num' : '' }, t)))),
        h('tbody', {}, restock.map(r => h('tr', {}, h('td', {}, r.name), h('td', { class: 'num neg' }, amt(r.on_hand_base, r.unit)), h('td', { class: 'num' }, amt(r.need_base, r.unit)),
          h('td', {}, r.skus.join(', ')), h('td', {}, r.supplier ? r.supplier + ' · ' : '', webUrl(r.link) ? h('a', { href: webUrl(r.link), target: '_blank', rel: 'noopener noreferrer' }, 'Buy ↗')
            : h('a', { href: `#/ingredients/${r.id}` }, 'add link')))))))
        : h('p', { class: 'muted' }, 'Every ingredient used by a live SKU covers at least one batch.'),
      h('h3', {}, 'Recipes needing attention'),
      table(gaps.map(g => ({ sku: g.sku, status: g.status, missing: g.missing })),
        r => have.has(r.sku) ? `#/recipes/${encodeURIComponent(r.sku)}` : `#/recipes/new?sku=${encodeURIComponent(r.sku)}`)] : '',
    h('details', {}, h('summary', {}, `Stock for every SKU (${stock.filter(r => !unused(r)).length})`),
      table(stock.filter(r => !unused(r)).sort((a, b) => a.on_hand - b.on_hand), null, { hide: ['product_id', 'is_low'] })),
    full ? h('details', {}, h('summary', {}, `Ingredient stock (${stocked.length} of ${ing.length} have stock recorded)`), table(ing.map(r => ({ id: r.id, name: r.name, on_hand: amt(r.on_hand_base, r.unit) })), r => `#/ingredients/${r.id}`, { hide: ['id'] })) : ''];
}
async function costsPage() {
  const have = new Set((await api('/items/recipes?limit=-1&fields=sku')).map(r => r.sku));
  return [h('h2', {}, 'Costs and margin per unit'), h('p', { class: 'muted' }, 'All amounts are per unit. Click a row to open its recipe. Blank cells mean the recipe is missing something (see Overview).'),
    table((await view('recipe_cost_per_unit')).map(r => ({ sku: r.sku, price: r.sale_price, cost: r.total_cost_per_unit, profit: r.profit_per_unit,
      margin_pct: r.margin_pct, ingredients: r.ingredients_per_unit, packaging: r.packaging_per_unit, labour: r.labour_per_unit,
      units_per_batch: r.units_per_batch })), r => have.has(r.sku) ? `#/recipes/${encodeURIComponent(r.sku)}` : `#/recipes/new?sku=${encodeURIComponent(r.sku)}`)];
}
async function batchPage() {
  await loadRefs([skuRef]);
  const sku = fieldInput(skuRef, ''), jars = h('input', { type: 'number', min: 1, step: 1, required: true }), ref = h('input', { type: 'text' });
  const form = h('form', { class: 'card', onsubmit: async ev => {
    ev.preventDefault();
    try {
      const r = await api('/saulaya/make-batch', { method: 'POST', body: { sku: sku.value, units: Number(jars.value), ref: ref.value || null } });
      await route(); note(`Batch #${r.id} recorded: stock added, ingredients taken out`);
    } catch (e) { note(e.message, true); }
  } },
  h('div', { class: 'grid' }, fieldRow({ k: 'sku' }, sku), fieldRow({ k: 'units made' }, jars), fieldRow({ k: 'batch ref', hint: 'optional' }, ref)),
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Make batch')),
  h('p', { class: 'muted' }, 'Scales the recipe to the units made and takes ingredients, containers and labels out of stock. Refused if the recipe is incomplete (see Overview).'));
  return [h('h2', {}, 'Make a batch'), form, h('h3', {}, 'Recent batches'),
    h('p', { class: 'muted' }, 'Click a batch to correct or remove it. ', h('a', { href: '#/stock_batches' }, 'All batches')),
    table(await api('/items/stock_batches?limit=20&sort=-made_at,-id'), r => `#/stock_batches/${r.id}`)];
}

// Admin only: every change with who made it, and a button to put it back.
async function historyPage() {
  const rows = await api('/saulaya/history?limit=300');
  const show = v => v == null ? '∅' : String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 40);
  const what = r => r.op === 'c' ? 'created' : r.op === 'd' ? 'deleted · ' + Object.entries(r.old).filter(([, v]) => v != null).slice(0, 5).map(([k, v]) => `${lbl(k)} ${show(v)}`).join(', ')
    : Object.keys(r.old).map(k => `${lbl(k)}: ${show(r.old[k])} → ${show(r.new[k])}`).join(' · ');
  async function undo(r) {
    if (!confirm(`Put this back?\n${r.tbl} ${r.pk}: ${what(r)}`)) return;
    const url = `/items/${r.tbl}/${encodeURIComponent(r.pk)}`;
    try {
      if (r.op === 'u') await api(url, { method: 'PATCH', body: r.old });
      else if (r.op === 'd') await api(`/items/${r.tbl}`, { method: 'POST', body: r.old }); // rows that went with it (a purchase's lines) are not restored
      else await api(url, { method: 'DELETE' });
      note('Reverted'); route();
    } catch (e) { note(e.message, true); }
  }
  const tr = r => h('tr', {}, h('td', {}, when(new Date(r.at))), h('td', {}, r.who), h('td', {}, r.tbl.replace(/_/g, ' ')),
    h('td', {}, TABLES[r.tbl] && r.op !== 'd' ? h('a', { href: `#/${r.tbl}/${encodeURIComponent(r.pk)}` }, r.pk) : r.pk),
    h('td', { class: 'wrap' }, what(r)), h('td', {}, h('button', { onclick: () => undo(r) }, 'Revert')));
  const body = h('tbody', {}, rows.map(tr));
  const search = h('input', { type: 'search', placeholder: 'Filter by person, table or value…', oninput: e => {
    const q = e.target.value.toLowerCase(); [...body.children].forEach(t => { t.hidden = !t.textContent.toLowerCase().includes(q); }); } });
  return [h('div', { class: 'bar' }, h('h2', { style: 'margin:0' }, 'History'), search),
    h('p', { class: 'muted' }, 'The latest 300 changes. Revert puts the old values back (and is itself recorded).'),
    rows.length ? h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'Table', 'Record', 'Change', ''].map(t => h('th', {}, t)))), body)) : h('p', { class: 'muted' }, 'No changes recorded yet.')];
}

// ---------- shell and routing ----------
let navId = 0; // only the newest navigation may draw: a slow page must not overwrite the one clicked after it
async function route() {
  const mine = ++navId;
  const [page, rawId] = location.hash.slice(2).split('?')[0].split('/');
  const id = rawId && decodeURIComponent(rawId), name = page || landing();
  if (!canOpen(name)) { location.hash = '#/' + landing(); return; }
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.p === name));
  refCache = {};
  const main = $('#main');
  main.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    const cfg = TABLES[name];
    const out = name === 'overview' ? await overviewPage() : name === 'costs' ? await costsPage() : name === 'batch' ? await batchPage()
      : name === 'sell' ? await sellPage() : name === 'report' ? await reportPage() : name === 'stock' ? await stockPage() : name === 'users' ? await usersPage(id) : name === 'history' ? await historyPage()
      : cfg ? (id ? await recordPage(cfg, name, id) : await listPage(cfg, name)) : [h('p', {}, 'Page not found')];
    if (mine === navId) main.replaceChildren(...out);
  } catch (e) { if (mine === navId) main.replaceChildren(h('p', { class: 'note err' }, e.message)); }
}

async function shell() {
  try { me = await api('/saulaya/me'); }
  catch (e) { return logout(e.message === 'Not allowed' ? 'This account has no role yet. Ask an admin.' : e.message); }
  const groups = NAV.map(([group, items]) => [group, items.filter(([p]) => canOpen(p))]).filter(([, items]) => items.length);
  $('#app').replaceChildren(h('div', { class: 'shell' },
    h('nav', {}, h('h1', {}, 'Saulaya'), groups.map(([group, items]) => [h('div', { class: 'ng' }, group), items.map(([p, l]) => h('a', { href: '#/' + p, 'data-p': p }, l))]),
      h('div', { class: 'who' }, h('span', {}, me.name), h('small', {}, me.role)),
      h('button', { onclick: () => logout() }, 'Log out')),
    h('main', { id: 'main' }), h('div', { id: 'msg' })));
  route();
}

function loginScreen(problem) {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const pass = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const msg = h('div', { id: 'msg', style: 'position:static' }, problem ? h('div', { class: 'note err' }, problem) : '');
  $('#app').replaceChildren(h('form', { class: 'card login', onsubmit: async ev => {
    ev.preventDefault();
    try {
      const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.value, password: pass.value, mode: 'json' }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.errors?.[0]?.message || 'Login failed');
      setTokens(j.data); shell();
    } catch (e) { msg.replaceChildren(h('div', { class: 'note err' }, e.message)); }
  } }, h('h2', {}, 'Saulaya'), fieldRow({ k: 'email' }, email), fieldRow({ k: 'password' }, pass),
  h('button', { class: 'primary', type: 'submit' }, 'Log in'), msg));
}

function start(problem) { if (tok) shell(); else loginScreen(problem); }
addEventListener('hashchange', () => { if ($('#main')) route(); });
start();
