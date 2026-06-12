'use strict';
/*
 * Gripharma — Entregas ao Domicílio (frontend)
 *
 * Funciona em dois modos, detetados automaticamente:
 *  - API:  servido pelo server.js → dados partilhados entre o PC da farmácia
 *          e o telemóvel do estafeta (inclui localização do estafeta).
 *  - DEMO: aberto sem servidor (ex.: GitHub Pages) → dados guardados só neste
 *          browser (localStorage). Ideal para demonstração.
 *
 * Complementa o Sifarma (GLINTT): a faturação real é feita no Sifarma; aqui
 * regista-se QUEM faturou, para haver rasto de responsabilidade.
 */

const STORAGE_KEY = 'gripharma_orders_v1';
const PREFS_KEY = 'gripharma_prefs_v1';
const OPERATORS_KEY = 'gripharma_operators_v1';
const CLIENTS_KEY = 'gripharma_clients_v1';
const SCHEDULES_KEY = 'gripharma_schedules_v1';
const PAY_LABELS = { mb: 'MB na entrega', mbway: 'MB WAY', referencia: 'Ref. MB', numerario: 'Numerário', pago: 'Pago' };
let EASYPAY_ON = false;
const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
function demoOperators() { try { return JSON.parse(localStorage.getItem(OPERATORS_KEY)) || []; } catch (_) { return []; } }
function demoClients() { try { return JSON.parse(localStorage.getItem(CLIENTS_KEY)) || []; } catch (_) { return []; } }
function demoSaveClients(a) { localStorage.setItem(CLIENTS_KEY, JSON.stringify(a)); }
function demoSchedules() { try { return JSON.parse(localStorage.getItem(SCHEDULES_KEY)) || []; } catch (_) { return []; } }
function demoSaveSchedules(a) { localStorage.setItem(SCHEDULES_KEY, JSON.stringify(a)); }

let clients = []; // cache local para pesquisa/autofill

let MODE = 'demo'; // 'api' | 'demo'
let prefs = loadPrefs();
let orders = [];
let geoWatchId = null;

/* ------------------------------- Arranque ------------------------------ */

async function init() {
  await detectMode();
  setupUI();
  initTheme();
  renderSession();
  applyRole(prefs.role || 'farmacia');
  await refresh();
  if (MODE === 'api') setInterval(refresh, 5000); // mantém PC e telemóvel a par
}

async function detectMode() {
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    if (r.ok) {
      const h = await r.json().catch(() => ({}));
      EASYPAY_ON = !!h.easypay;
      MODE = 'api';
      setBadge('Servidor ligado · dados partilhados' + (EASYPAY_ON ? ' · Easypay' : ''), false);
      return;
    }
  } catch (_) { /* sem servidor */ }
  MODE = 'demo';
  setBadge('Modo demonstração (dados só neste browser)', true);
}

function setBadge(text, isDemo) {
  const el = document.getElementById('modeBadge');
  el.textContent = text;
  el.classList.toggle('demo', !!isDemo);
}

/* --------------------------- Camada de dados --------------------------- */

const store = {
  async list() {
    if (MODE === 'api') return (await getJSON('api/orders')).orders || [];
    demoMaterializeSchedules();
    return demoLoad();
  },
  async couriers() {
    if (MODE === 'api') return (await getJSON('api/couriers')).couriers || [];
    return [];
  },
  async shareLocation(name, lat, lng) {
    if (MODE !== 'api') return;
    await postJSON('api/couriers/location', 'POST', { name, lat, lng });
  },
  async login(pin) {
    if (MODE === 'api') {
      const r = await fetch('api/operators/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'PIN inválido.');
      return d.operator;
    }
    const op = demoOperators().find((o) => o.pin === String(pin));
    if (!op) throw new Error('PIN inválido.');
    return { id: op.id, name: op.name };
  },
  async createOperator(name, pin) {
    if (MODE === 'api') {
      const r = await fetch('api/operators', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pin }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Erro ao criar operador.');
      return d.operator;
    }
    if (!/^\d{4,6}$/.test(String(pin))) throw new Error('PIN deve ter 4 a 6 dígitos.');
    const all = demoOperators();
    if (all.some((o) => o.name.toLowerCase() === name.toLowerCase())) throw new Error('Já existe um operador com esse nome.');
    if (all.some((o) => o.pin === String(pin))) throw new Error('Esse PIN já está em uso.');
    const op = { id: uuid(), name, pin: String(pin) };
    all.push(op); localStorage.setItem(OPERATORS_KEY, JSON.stringify(all));
    return { id: op.id, name: op.name };
  },
  /* ------------------------------ Clientes ----------------------------- */
  async listClients() {
    if (MODE === 'api') return (await getJSON('api/clients')).clients || [];
    return demoClients();
  },
  async saveClientRecord(data) {
    if (MODE === 'api') {
      const r = await fetch('api/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Erro ao guardar cliente.');
      return d.client;
    }
    return demoUpsertClient(data);
  },
  async deleteClient(id) {
    if (MODE === 'api') { await fetch('api/clients/' + id, { method: 'DELETE' }); return; }
    demoSaveClients(demoClients().filter((c) => c.id !== id));
  },
  async importClients(list) {
    if (MODE === 'api') {
      const r = await fetch('api/clients/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clients: list }) });
      return r.json();
    }
    let n = 0;
    for (const c of list) { if (c.name) { demoUpsertClient(c); n++; } }
    return { imported: n, total: demoClients().length };
  },
  /* ---------------------------- Programadas ---------------------------- */
  async listSchedules() {
    if (MODE === 'api') return (await getJSON('api/schedules')).schedules || [];
    return demoSchedules();
  },
  async createSchedule(s) {
    if (MODE === 'api') {
      const r = await fetch('api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Erro ao criar programação.');
      return d.schedule;
    }
    const all = demoSchedules();
    const sch = { id: uuid(), label: s.label || s.order.customerName, weekday: Number(s.weekday) || 0, time: s.time || '', order: s.order, lastRun: '', createdAt: new Date().toISOString() };
    all.push(sch); demoSaveSchedules(all);
    return sch;
  },
  async deleteSchedule(id) {
    if (MODE === 'api') { await fetch('api/schedules/' + id, { method: 'DELETE' }); return; }
    demoSaveSchedules(demoSchedules().filter((s) => s.id !== id));
  },
  async easypay(id, method, operator) {
    if (MODE !== 'api') throw new Error('Easypay só funciona na versão com servidor (não na demo).');
    return postJSON('api/orders/' + id + '/easypay', 'POST', { method, operator });
  },
  async collect(id, operator) {
    if (MODE === 'api') return postJSON('api/orders/' + id + '/collect', 'POST', { operator });
    const all = demoLoad(); const o = all.find((x) => x.id === id);
    if (o) {
      const ts = new Date().toISOString();
      o.paymentStatus = 'pago'; o.paymentAlert = false; o.updatedAt = ts;
      o.history.push({ status: o.status, at: ts, by: operator, note: 'Pagamento recebido (' + (o.paymentMethod || 'mb') + ')' });
      demoSave(all);
    }
    return o;
  },
  async create(data, operator) {
    if (MODE === 'api') return postJSON('api/orders', 'POST', { ...data, operator });
    const all = demoLoad();
    const ts = new Date().toISOString();
    const counter = Number(localStorage.getItem('gripharma_counter') || all.length) + 1;
    localStorage.setItem('gripharma_counter', String(counter));
    const order = {
      id: uuid(), code: '#' + String(counter).padStart(4, '0'), ...data,
      status: 'pendente', registeredBy: operator,
      invoiced: false, invoicedBy: '', invoicedAt: '', readyBy: '', readyAt: '',
      courier: '', pickedAt: '', deliveredBy: '', deliveredAt: '', receivedBy: '', deliveryOutcome: '',
      paymentAlert: false,
      createdAt: ts, updatedAt: ts,
      history: [{ status: 'pendente', at: ts, by: operator, note: 'Pedido registado' }],
    };
    all.push(order); demoSave(all); return order;
  },
  async update(id, data) {
    if (MODE === 'api') return postJSON('api/orders/' + id, 'PUT', data);
    const all = demoLoad(); const o = all.find((x) => x.id === id);
    if (o) { Object.assign(o, data, { updatedAt: new Date().toISOString() }); demoSave(all); }
    return o;
  },
  async invoice(id, operator, invoiceAmount) {
    if (MODE === 'api') return postJSON('api/orders/' + id + '/invoice', 'POST', { operator, invoiceAmount });
    const all = demoLoad(); const o = all.find((x) => x.id === id);
    if (o) {
      const ts = new Date().toISOString();
      o.invoiced = true; o.invoicedBy = operator; o.invoicedAt = ts; o.updatedAt = ts;
      if (invoiceAmount != null) o.paymentAmount = Number(invoiceAmount) || 0;
      o.history.push({ status: o.status, at: ts, by: operator, note: 'Faturado (Sifarma)' + (invoiceAmount != null ? ' — ' + (Number(invoiceAmount) || 0).toFixed(2) + '€' : '') });
      demoSave(all);
    }
    return o;
  },
  async setStatus(id, status, extra = {}) {
    if (MODE === 'api') return postJSON('api/orders/' + id + '/status', 'POST', { status, ...extra });
    const all = demoLoad(); const o = all.find((x) => x.id === id);
    if (o) {
      const ts = new Date().toISOString();
      o.status = status; o.updatedAt = ts;
      if (status === 'pronto') { o.readyBy = extra.operator || ''; o.readyAt = ts; }
      if (status === 'recolhido') { o.courier = extra.courier || extra.operator || ''; o.pickedAt = ts; }
      if (status === 'entregue') {
        o.deliveredBy = extra.courier || extra.operator || o.courier;
        o.deliveredAt = ts; o.receivedBy = extra.receivedBy || ''; o.deliveryOutcome = extra.deliveryOutcome || '';
        if (extra.paymentCollected) { o.paymentStatus = 'pago'; o.paymentAlert = false; }
        if (extra.paymentFailed) {
          o.paymentMethod = 'referencia'; o.paymentAlert = true;
          o.history.push({ status, at: ts, by: extra.operator || o.courier || '', note: 'Cliente não pagou — passou a Referência MB' });
        }
      }
      o.history.push({ status, at: ts, by: extra.operator || o.courier || '', note: extra.note || '' });
      demoSave(all);
    }
    return o;
  },
  async remove(id) {
    if (MODE === 'api') { await fetch('api/orders/' + id, { method: 'DELETE' }); return; }
    demoSave(demoLoad().filter((x) => x.id !== id));
  },
};

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  return r.json();
}
async function postJSON(url, method, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Erro');
  return d.order;
}
function demoLoad() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch (_) { return []; } }
function demoSave(a) { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)); }
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (_) { return {}; } }
function savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function demoUpsertClient(data) {
  const all = demoClients();
  const norm = (s) => String(s || '').toLowerCase();
  let c = null;
  if (data.id) c = all.find((x) => x.id === data.id);
  if (!c && data.nif) c = all.find((x) => x.nif && x.nif === data.nif);
  if (!c && data.phone) c = all.find((x) => x.phone && x.phone === data.phone);
  if (!c && data.name) c = all.find((x) => norm(x.name) === norm(data.name) && !x.nif && !data.nif);
  const ts = new Date().toISOString();
  if (c) Object.assign(c, { name: data.name || c.name, nif: data.nif || c.nif, phone: data.phone || c.phone, address: data.address || c.address, notes: data.notes != null ? data.notes : c.notes, updatedAt: ts });
  else { c = { id: uuid(), name: data.name || '', nif: data.nif || '', phone: data.phone || '', address: data.address || '', notes: data.notes || '', createdAt: ts, updatedAt: ts }; all.push(c); }
  demoSaveClients(all);
  return c;
}

/* Demo: gera pedidos das entregas programadas quando o dia coincide */
function demoMaterializeSchedules() {
  const today = new Date().toISOString().slice(0, 10);
  const weekday = new Date().getDay();
  const schedules = demoSchedules();
  let changed = false;
  for (const s of schedules) {
    if (Number(s.weekday) !== weekday || s.lastRun === today) continue;
    const all = demoLoad();
    const ts = new Date().toISOString();
    const counter = Number(localStorage.getItem('gripharma_counter') || all.length) + 1;
    localStorage.setItem('gripharma_counter', String(counter));
    all.push({
      id: uuid(), code: '#' + String(counter).padStart(4, '0'), ...(s.order || {}),
      deliveryDate: today, deliveryTime: s.time || '',
      status: 'pendente', registeredBy: 'Programada',
      invoiced: false, invoicedBy: '', invoicedAt: '', readyBy: '', readyAt: '',
      courier: '', pickedAt: '', deliveredBy: '', deliveredAt: '', receivedBy: '', deliveryOutcome: '',
      paymentAlert: false, scheduleId: s.id,
      createdAt: ts, updatedAt: ts,
      history: [{ status: 'pendente', at: ts, by: 'Programada', note: 'Entrega programada (' + (s.label || '') + ')' }],
    });
    demoSave(all);
    s.lastRun = today;
    changed = true;
  }
  if (changed) demoSaveSchedules(schedules);
}

/* --------------------------- Sessão / operador ------------------------- */

function currentUser() { return (prefs.session && prefs.session.name) || ''; }

function requireOperator() {
  const u = currentUser();
  if (!u) { toast('Inicia sessão para registar a operação.'); openLogin(); }
  return u;
}
const requireCourier = requireOperator; // mesma identidade (quem está em sessão)

function renderSession() {
  const el = document.getElementById('sessionArea');
  if (!el) return;
  if (currentUser()) {
    el.innerHTML = `<span class="who"><svg class="ic"><use href="#i-user"/></svg> <b>${esc(currentUser())}</b></span>`
      + `<button class="chip-btn" id="btnLogout" title="Terminar sessão" aria-label="Terminar sessão"><svg class="ic"><use href="#i-logout"/></svg></button>`;
  } else {
    el.innerHTML = `<button class="chip-btn has-label" id="btnLogin"><svg class="ic"><use href="#i-user"/></svg> Entrar</button>`;
  }
}

function openLogin() {
  const m = document.getElementById('loginModal');
  document.getElementById('loginForm').reset();
  document.getElementById('createOpForm').reset();
  document.getElementById('createOpDetails').open = false;
  m.hidden = false;
  setTimeout(() => document.querySelector('#loginForm input[name=pin]').focus(), 50);
}
function closeLogin() { document.getElementById('loginModal').hidden = true; }

function setSession(op) {
  prefs.session = { id: op.id, name: op.name };
  savePrefs();
  renderSession();
}
function logout() { prefs.session = null; savePrefs(); renderSession(); }

/* ------------------------------- Render -------------------------------- */

async function refresh() {
  orders = await store.list();
  if (prefs.role === 'estafeta') renderEstafeta();
  else { renderFarmacia(); renderCouriers(); }
}

function matchesSearch(o, q) {
  if (!q) return true;
  return [o.code, o.customerName, o.customerPhone, o.customerAddress, o.items, o.notes]
    .join(' ').toLowerCase().includes(q);
}
function isToday(iso) {
  const d = new Date(iso); const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function renderFarmacia() {
  const q = (document.getElementById('search').value || '').trim().toLowerCase();
  const buckets = { pendente: [], pronto: [], recolhido: [], entregue: [] };
  for (const o of orders) {
    if (o.status === 'cancelado') continue;
    // entregues: mostra as de hoje + as com pagamento pendente (até resolver)
    if (o.status === 'entregue' && !isToday(o.updatedAt) && !o.paymentAlert) continue;
    if (!matchesSearch(o, q)) continue;
    if (buckets[o.status]) buckets[o.status].push(o);
  }
  for (const status of Object.keys(buckets)) {
    document.querySelector(`[data-count="${status}"]`).textContent = buckets[status].length;
    const wrap = document.querySelector(`[data-cards="${status}"]`);
    wrap.innerHTML = buckets[status].length ? buckets[status].map(cardFarmacia).join('') : '<div class="empty">—</div>';
  }
  const active = orders.filter((o) => ['pendente', 'pronto', 'recolhido'].includes(o.status)).length;
  const today = orders.filter((o) => o.status === 'entregue' && isToday(o.updatedAt)).length;
  const cobrar = orders.filter((o) => o.paymentStatus === 'cobrar' && !o.paymentAlert && ['pronto', 'recolhido'].includes(o.status))
    .reduce((s, o) => s + (Number(o.paymentAmount) || 0), 0);
  const pendentes = orders.filter((o) => o.paymentAlert);
  const pendVal = pendentes.reduce((s, o) => s + (Number(o.paymentAmount) || 0), 0);
  document.getElementById('stats').innerHTML =
    `<span>Ativos: <b>${active}</b></span><span>Entregues hoje: <b>${today}</b></span>` +
    `<span>A cobrar (em rota): <b>${cobrar.toFixed(2)}€</b></span>` +
    (pendentes.length ? `<span class="stat-alert">${ic('alert')} Pagamentos pendentes: <b>${pendentes.length}</b> (${pendVal.toFixed(2)}€)</span>` : '');
}

async function renderCouriers() {
  const panel = document.getElementById('couriersPanel');
  if (MODE !== 'api') { panel.hidden = true; return; }
  const list = (await store.couriers()).filter((c) => Date.now() - new Date(c.at).getTime() < 15 * 60 * 1000);
  if (!list.length) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<strong style="font-size:.8rem;color:var(--muted)">Estafetas em rota:</strong>' +
    list.map((c) =>
      `<span class="courier-chip">${ic('bike')} ${esc(c.name)} · ${ago(c.at)}` +
      ` · <a href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}" target="_blank" rel="noopener">${ic('map')} ver no mapa</a></span>`
    ).join('');
}

function fmtDatePt(d) {
  try { const [y, m, dd] = d.split('-'); return dd + '/' + m; } catch (_) { return d; }
}

function badges(o) {
  const b = [];
  const amt = Number(o.paymentAmount) || 0;
  const method = PAY_LABELS[o.paymentMethod] || 'Cobrar';
  if (o.paymentAlert) b.push(`<span class="badge pay-alert">${ic('alert')} Pagamento pendente · Ref. MB${amt ? ' ' + amt.toFixed(2) + '€' : ''}</span>`);
  else if (o.paymentStatus === 'pago') b.push(`<span class="badge pay-pago">${ic('check')} Pago${amt ? ' ' + amt.toFixed(2) + '€' : ''}</span>`);
  else b.push(`<span class="badge pay-cobrar">${ic('wallet')} ${esc(method)}${amt ? ' ' + amt.toFixed(2) + '€' : ''}</span>`);
  const nRx = (o.prescriptions || []).length;
  if (nRx) b.push(`<span class="badge rx">${ic('file')} ${nRx > 1 ? nRx + ' receitas' : 'Receita'}</span>`);
  else if (o.requiresPrescription) b.push(`<span class="badge rx">${ic('file')} Receita</span>`);
  if (o.deliveryDate) b.push(`<span class="badge date">${ic('calendar')} ${esc(fmtDatePt(o.deliveryDate))}${o.deliveryTime ? ' ' + esc(o.deliveryTime) : ''}</span>`);
  if (o.callOnArrival) b.push(`<span class="badge call">${ic('phone')} Ligar ao chegar</span>`);
  if (o.invoiced) b.push(`<span class="badge pay-pago">${ic('receipt')} Faturado</span>`);
  if (o.courier) b.push(`<span class="badge courier">${ic('bike')} ${esc(o.courier)}</span>`);
  return b.join('');
}

function stampsLine(o) {
  const s = [];
  if (o.registeredBy) s.push(`Recebido: ${esc(o.registeredBy)}`);
  if (o.invoicedBy) s.push(`Faturado: ${esc(o.invoicedBy)}`);
  if (o.courier) s.push(`Estafeta: ${esc(o.courier)}`);
  if (o.deliveryOutcome) s.push(`Entrega: ${esc(o.deliveryOutcome)}`);
  if (o.receivedBy) s.push(`Recebeu: ${esc(o.receivedBy)}`);
  return s.length ? `<div class="history-mini">${s.map((x) => `<div>• ${x}</div>`).join('')}</div>` : '';
}

function easypayLine(o) {
  const e = o.easypay;
  if (!e) return '';
  if (e.method === 'mb' && e.reference) {
    return `<div class="easypay-ref">${ic('wallet')} <b>Ref. MB</b> · Entidade ${esc(e.entity)} · Ref. <b>${esc(e.reference)}</b> · ${(Number(e.value) || 0).toFixed(2)}€${e.status === 'paid' ? ' ✓ pago' : ''}</div>`;
  }
  return `<div class="easypay-ref">${ic('phone')} <b>MB WAY</b> enviado · ${(Number(e.value) || 0).toFixed(2)}€ · ${e.status === 'paid' ? '✓ pago' : 'a aguardar confirmação'}</div>`;
}

function cardClasses(o) {
  let c = 'card';
  if (o.refrigerated) c += ' card-cold';
  if (o.paymentAlert) c += ' card-payalert';
  return c;
}

function cardCommon(o) {
  return (
    (o.refrigerated ? `<div class="cold-banner">${ic('snow')} Refrigerado — manter frio</div>` : '') +
    `<div class="card-top"><span class="card-code">${esc(o.code)}</span><span class="card-time">${fmtTime(o.createdAt)}</span></div>` +
    `<div class="card-name">${esc(o.customerName)}</div>` +
    `<div class="card-line">${ic('pin')} ${esc(o.customerAddress)}</div>` +
    (o.customerPhone ? `<div class="card-line">${ic('phone')} <a href="tel:${esc(o.customerPhone)}">${esc(o.customerPhone)}</a></div>` : '') +
    (o.items ? `<div class="card-items">${ic('pill')} ${esc(o.items)}</div>` : '') +
    ((o.prescriptions || []).length ? `<div class="card-line">${ic('file')} ${o.prescriptions.map((p) => esc(p.number || p.accessCode)).filter(Boolean).join(' · ')}</div>` : '') +
    (o.notes ? `<div class="card-line">${ic('pencil')} ${esc(o.notes)}</div>` : '') +
    easypayLine(o) +
    `<div class="badges">${badges(o)}</div>`
  );
}

function easypayButtons(o) {
  if (!EASYPAY_ON) return '';
  let b = '';
  if (o.customerPhone) b += `<button class="btn btn-sm" data-act="easypay" data-method="mbw" data-id="${o.id}">${ic('phone')} MB WAY</button>`;
  b += `<button class="btn btn-sm" data-act="easypay" data-method="mb" data-id="${o.id}">${ic('wallet')} Ref. MB</button>`;
  return b;
}

function cardFarmacia(o) {
  let actions = '';
  const printBtn = `<button class="btn btn-sm" data-act="print" data-id="${o.id}" title="Imprimir talão" aria-label="Imprimir talão">${ic('printer')}</button>`;
  if (o.status === 'pendente') {
    actions =
      (o.invoiced ? '' : `<button class="btn btn-sm" data-act="invoice" data-id="${o.id}">${ic('receipt')} Faturar</button>`) +
      `<button class="btn btn-sm btn-primary" data-act="status" data-id="${o.id}" data-status="pronto">Marcar pronto</button>` +
      `<button class="btn btn-sm" data-act="edit" data-id="${o.id}">Editar</button>` +
      printBtn +
      `<button class="btn btn-sm btn-danger" data-act="cancel" data-id="${o.id}">✕</button>`;
  } else if (o.status === 'pronto') {
    actions =
      (o.invoiced ? '' : `<button class="btn btn-sm" data-act="invoice" data-id="${o.id}">${ic('receipt')} Faturar</button>`) +
      `<button class="btn btn-sm" data-act="status" data-id="${o.id}" data-status="pendente">↩ Voltar</button>` +
      `<button class="btn btn-sm" data-act="edit" data-id="${o.id}">Editar</button>` +
      printBtn;
  } else if (o.status === 'recolhido') {
    actions = `<button class="btn btn-sm btn-ok" data-act="deliver" data-id="${o.id}">Confirmar entrega</button>` + printBtn;
  } else if (o.status === 'entregue' && o.paymentAlert) {
    actions = `<button class="btn btn-sm btn-primary" data-act="collect" data-id="${o.id}">${ic('wallet')} Receber pagamento</button>` + easypayButtons(o);
  }
  // gerar pagamento Easypay proativamente quando o método é MB WAY / Referência
  if (['pronto', 'recolhido'].includes(o.status) && ['referencia', 'mbway'].includes(o.paymentMethod) && !o.easypay && o.paymentStatus !== 'pago') {
    actions += easypayButtons(o);
  }
  return `<div class="${cardClasses(o)}">${cardCommon(o)}${stampsLine(o)}<div class="card-actions">${actions}</div></div>`;
}

function renderEstafeta() {
  const recolher = orders.filter((o) => o.status === 'pronto');
  const entrega = orders.filter((o) => o.status === 'recolhido');
  document.getElementById('cntRecolher').textContent = recolher.length;
  document.getElementById('cntEntrega').textContent = entrega.length;
  document.getElementById('listRecolher').innerHTML = recolher.length
    ? recolher.map(cardRecolher).join('') : '<div class="empty">Nada para recolher de momento.</div>';
  document.getElementById('listEntrega').innerHTML = entrega.length
    ? entrega.map(cardEntrega).join('') : '<div class="empty">Sem entregas em curso.</div>';
}

function cardRecolher(o) {
  return `<div class="${cardClasses(o)}">${cardCommon(o)}<div class="card-actions">` +
    `<button class="btn btn-primary btn-block" data-act="recolher" data-id="${o.id}">${ic('bike')} Recolhi este pedido</button></div></div>`;
}
function cardEntrega(o) {
  return `<div class="${cardClasses(o)}">${cardCommon(o)}${stampsLine(o)}<div class="card-actions">` +
    `<a class="btn btn-sm" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.customerAddress)}" target="_blank" rel="noopener">${ic('map')} Mapa</a>` +
    `<button class="btn btn-ok" data-act="deliver" data-id="${o.id}">${ic('check')} Confirmar entrega</button></div></div>`;
}

/* ------------------------------- Eventos ------------------------------- */

function setupUI() {
  document.getElementById('roleSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role]');
    if (btn) { applyRole(btn.dataset.role); refresh(); }
  });
  document.getElementById('search').addEventListener('input', renderFarmacia);
  document.getElementById('btnNew').addEventListener('click', () => { if (requireOperator()) openModal(); });

  document.getElementById('shareLocation').addEventListener('change', onToggleLocation);
  document.getElementById('themeToggle').addEventListener('click', () =>
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  // Sessão / login
  document.getElementById('sessionArea').addEventListener('click', (e) => {
    if (e.target.closest('#btnLogin')) openLogin();
    else if (e.target.closest('#btnLogout')) logout();
  });
  const lm = document.getElementById('loginModal');
  lm.addEventListener('click', (e) => { if (e.target === lm || e.target.hasAttribute('data-close-login')) closeLogin(); });
  document.getElementById('loginForm').addEventListener('submit', onSubmitLogin);
  document.getElementById('createOpForm').addEventListener('submit', onSubmitCreateOp);

  // Relatório
  document.getElementById('btnReport').addEventListener('click', openReport);
  const rm = document.getElementById('reportModal');
  rm.addEventListener('click', (e) => { if (e.target === rm || e.target.hasAttribute('data-close-report')) rm.hidden = true; });
  document.getElementById('btnExportCsv').addEventListener('click', exportReportCsv);
  document.getElementById('btnPrintReport').addEventListener('click', () => doPrint('printing-report'));

  document.querySelector('main').addEventListener('click', onCardClick);

  const modal = document.getElementById('modal');
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.hasAttribute('data-close')) closeModal(); });
  document.getElementById('orderForm').addEventListener('submit', onSubmitForm);

  const dm = document.getElementById('deliverModal');
  dm.addEventListener('click', (e) => { if (e.target === dm || e.target.hasAttribute('data-close-deliver')) dm.hidden = true; });
  document.getElementById('deliverForm').addEventListener('submit', onSubmitDeliver);

  // Receitas (linhas dinâmicas)
  document.getElementById('btnAddRx').addEventListener('click', () => {
    document.getElementById('rxList').insertAdjacentHTML('beforeend', rxRowHTML());
  });
  document.getElementById('rxList').addEventListener('click', (e) => {
    if (e.target.closest('[data-rx-remove]')) e.target.closest('.rx-row').remove();
  });

  // Pesquisa de cliente no formulário
  document.getElementById('clientSearch').addEventListener('input', onClientSearch);
  document.getElementById('clientSuggestions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-client]');
    if (!btn) return;
    const c = clients.find((x) => x.id === btn.dataset.client);
    if (c) fillFromClient(c);
  });

  // Faturação
  const im = document.getElementById('invoiceModal');
  im.addEventListener('click', (e) => { if (e.target === im || e.target.hasAttribute('data-close-invoice')) im.hidden = true; });
  document.getElementById('invoiceForm').addEventListener('submit', onSubmitInvoice);

  // Clientes
  document.getElementById('btnClients').addEventListener('click', openClients);
  const cm = document.getElementById('clientsModal');
  cm.addEventListener('click', (e) => { if (e.target === cm || e.target.hasAttribute('data-close-clients')) cm.hidden = true; });
  document.getElementById('clientsFilter').addEventListener('input', renderClientsList);
  document.getElementById('clientsList').addEventListener('click', onClientRowClick);
  document.getElementById('clientForm').addEventListener('submit', onSubmitClient);
  document.getElementById('btnClientNew').addEventListener('click', () => fillClientForm(null));
  document.getElementById('btnImport').addEventListener('click', onImportClients);
  document.getElementById('importFile').addEventListener('change', onImportFile);

  // Programadas
  document.getElementById('btnSchedules').addEventListener('click', openSchedules);
  const sm = document.getElementById('schedulesModal');
  sm.addEventListener('click', (e) => { if (e.target === sm || e.target.hasAttribute('data-close-schedules')) sm.hidden = true; });
  document.getElementById('schedulesList').addEventListener('click', onScheduleRowClick);
  document.getElementById('scheduleForm').addEventListener('submit', onSubmitSchedule);
}

/* ------------------------------ Clientes UI ---------------------------- */

async function openClients() {
  await loadClientsCache();
  fillClientForm(null);
  document.getElementById('clientsFilter').value = '';
  document.getElementById('importResult').textContent = '';
  renderClientsList();
  document.getElementById('clientsModal').hidden = false;
}

function renderClientsList() {
  const q = document.getElementById('clientsFilter').value.trim().toLowerCase();
  const list = clients
    .filter((c) => !q || [c.name, c.nif, c.phone].some((v) => v && String(v).toLowerCase().includes(q)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt'));
  document.getElementById('clientsCount').textContent = clients.length;
  document.getElementById('clientsList').innerHTML = list.length
    ? list.slice(0, 200).map((c) =>
        `<button type="button" class="cl-row" data-cid="${c.id}">
           <span><b>${esc(c.name)}</b><br/><span class="cl-sub">${[c.nif && 'NIF ' + c.nif, c.phone, c.address].filter(Boolean).map(esc).join(' · ')}</span></span>
           <span class="cl-sub">editar ›</span>
         </button>`).join('')
    : '<div class="empty">Sem clientes. Importa um ficheiro ou cria abaixo.</div>';
}

function fillClientForm(c) {
  const f = document.getElementById('clientForm');
  f.reset();
  f.elements.namedItem('cId').value = c ? c.id : '';
  if (c) {
    f.elements.namedItem('cName').value = c.name || '';
    f.elements.namedItem('cNif').value = c.nif || '';
    f.elements.namedItem('cPhone').value = c.phone || '';
    f.elements.namedItem('cAddress').value = c.address || '';
    f.elements.namedItem('cNotes').value = c.notes || '';
  }
}

function onClientRowClick(e) {
  const row = e.target.closest('[data-cid]');
  if (!row) return;
  const c = clients.find((x) => x.id === row.dataset.cid);
  if (c) fillClientForm(c);
}

async function onSubmitClient(e) {
  e.preventDefault();
  const f = e.target;
  const data = {
    id: f.elements.namedItem('cId').value,
    name: f.elements.namedItem('cName').value.trim(),
    nif: f.elements.namedItem('cNif').value.trim(),
    phone: f.elements.namedItem('cPhone').value.trim(),
    address: f.elements.namedItem('cAddress').value.trim(),
    notes: f.elements.namedItem('cNotes').value.trim(),
  };
  if (!data.name) return toast('O nome do cliente é obrigatório.');
  try {
    await store.saveClientRecord(data);
    await loadClientsCache();
    renderClientsList();
    fillClientForm(null);
    toast('Cliente guardado ✓');
  } catch (err) { toast('Erro: ' + err.message); }
}

/* CSV flexível (Infoprex/Sifarma): deteta separador e mapeia colunas */
function parseClientsCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = [';', '\t', ','].map((s) => ({ s, n: (lines[0].match(new RegExp(s === '\t' ? '\t' : '\\' + s, 'g')) || []).length }))
    .sort((a, b) => b.n - a.n)[0].s;
  const split = (l) => l.split(sep).map((v) => v.replace(/^"|"$/g, '').trim());
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const findCol = (...keys) => header.findIndex((h) => keys.some((k) => h.includes(k)));
  let iName = findCol('nome', 'name', 'cliente');
  const iNif = findCol('nif', 'contrib', 'fiscal');
  const iPhone = findCol('telef', 'telem', 'tlm', 'phone', 'contacto');
  const iAddr = findCol('morada', 'ender', 'address', 'rua');
  const hasHeader = iName >= 0 || iNif >= 0 || iPhone >= 0;
  if (!hasHeader) iName = 0; // sem cabeçalho: assume 1ª coluna = nome
  const rows = hasHeader ? lines.slice(1) : lines;
  return rows.map((l) => {
    const v = split(l);
    return {
      name: iName >= 0 ? v[iName] || '' : v[0] || '',
      nif: iNif >= 0 ? (v[iNif] || '').replace(/\D/g, '') : '',
      phone: iPhone >= 0 ? v[iPhone] || '' : '',
      address: iAddr >= 0 ? v[iAddr] || '' : '',
    };
  }).filter((c) => c.name);
}

function onImportFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { document.getElementById('importText').value = String(reader.result || ''); };
  reader.readAsText(file, 'utf-8');
}

async function onImportClients() {
  const text = document.getElementById('importText').value;
  if (!text.trim()) return toast('Escolhe um ficheiro ou cola o conteúdo CSV.');
  const list = parseClientsCsv(text);
  if (!list.length) return toast('Não encontrei clientes no ficheiro. Verifica o formato.');
  try {
    const r = await store.importClients(list);
    await loadClientsCache();
    renderClientsList();
    document.getElementById('importResult').textContent =
      `Importados/atualizados ${r.imported} clientes (total: ${r.total ?? clients.length}).`;
    toast(`Importados ${r.imported} clientes ✓`);
  } catch (err) { toast('Erro na importação: ' + err.message); }
}

/* --------------------------- Programadas UI ---------------------------- */

async function openSchedules() {
  await renderSchedulesList();
  document.getElementById('schedulesModal').hidden = false;
}

async function renderSchedulesList() {
  const list = await store.listSchedules();
  document.getElementById('schedulesList').innerHTML = list.length
    ? list.map((s) =>
        `<div class="cl-row">
           <span><b>${esc(s.label)}</b><br/><span class="cl-sub">${WEEKDAYS[s.weekday]} às ${esc(s.time || '—')} · ${esc((s.order && s.order.customerAddress) || '')}</span></span>
           <button type="button" class="icon-btn" data-sched-del="${s.id}" title="Apagar programação">${ic('trash')}</button>
         </div>`).join('')
    : '<div class="empty">Sem entregas programadas.</div>';
}

async function onScheduleRowClick(e) {
  const del = e.target.closest('[data-sched-del]');
  if (!del) return;
  if (!confirm('Apagar esta entrega programada?')) return;
  await store.deleteSchedule(del.dataset.schedDel);
  await renderSchedulesList();
  toast('Programação removida.');
}

async function onSubmitSchedule(e) {
  e.preventDefault();
  const f = e.target;
  const order = {
    customerName: f.elements.namedItem('sName').value.trim(),
    customerPhone: f.elements.namedItem('sPhone').value.trim(),
    customerAddress: f.elements.namedItem('sAddress').value.trim(),
    items: f.elements.namedItem('sItems').value.trim(),
    paymentAmount: Number(f.elements.namedItem('sAmount').value) || 0,
    paymentMethod: f.elements.namedItem('sMethod').value,
    paymentStatus: f.elements.namedItem('sMethod').value === 'pago' ? 'pago' : 'cobrar',
  };
  if (!order.customerName || !order.customerAddress) return toast('Nome e morada são obrigatórios.');
  try {
    await store.createSchedule({
      label: order.customerName,
      weekday: Number(f.elements.namedItem('sWeekday').value),
      time: f.elements.namedItem('sTime').value,
      order,
    });
    f.reset();
    await renderSchedulesList();
    await refresh();
    toast('Entrega programada criada ✓');
  } catch (err) { toast('Erro: ' + err.message); }
}

async function onSubmitLogin(e) {
  e.preventDefault();
  const pin = e.target.elements.namedItem('pin').value.trim();
  if (!pin) return;
  try {
    const op = await store.login(pin);
    setSession(op); closeLogin(); await refresh();
    toast('Sessão iniciada: ' + op.name);
  } catch (err) { toast(err.message); }
}
async function onSubmitCreateOp(e) {
  e.preventDefault();
  const name = e.target.elements.namedItem('opName').value.trim();
  const pin = e.target.elements.namedItem('pin').value.trim();
  if (!name || !pin) return toast('Indica nome e PIN.');
  try {
    const op = await store.createOperator(name, pin);
    setSession(op); closeLogin(); await refresh();
    toast('Operador criado. Sessão iniciada: ' + op.name);
  } catch (err) { toast(err.message); }
}

/* ------------------------------- Tema ---------------------------------- */

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  prefs.theme = dark ? 'dark' : 'light'; savePrefs();
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = `<svg class="ic"><use href="#i-${dark ? 'sun' : 'moon'}"/></svg>`;
}
function initTheme() {
  const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(prefs.theme || (sysDark ? 'dark' : 'light'));
}

function applyRole(role) {
  prefs.role = role; savePrefs();
  document.querySelectorAll('.role-btn').forEach((b) => b.classList.toggle('active', b.dataset.role === role));
  document.getElementById('view-farmacia').hidden = role !== 'farmacia';
  document.getElementById('view-estafeta').hidden = role !== 'estafeta';
}

async function onCardClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  const order = orders.find((o) => o.id === id);
  try {
    if (act === 'status') {
      const operator = requireOperator(); if (!operator) return;
      await store.setStatus(id, btn.dataset.status, { operator });
      if (btn.dataset.status === 'pronto' && order) {
        // talão automático ao marcar pronto (nº encomenda + morada + telefone)
        printSlip({ ...order, status: 'pronto' });
      }
    } else if (act === 'invoice') {
      const operator = requireOperator(); if (!operator) return;
      return openInvoice(order);
    } else if (act === 'collect') {
      const operator = requireOperator(); if (!operator) return;
      await store.collect(id, operator);
      toast('Pagamento recebido.');
    } else if (act === 'easypay') {
      const operator = requireOperator(); if (!operator) return;
      const method = btn.dataset.method === 'mb' ? 'mb' : 'mbw';
      toast(method === 'mbw' ? 'A enviar MB WAY…' : 'A gerar referência…');
      const updated = await store.easypay(id, method, operator);
      toast(method === 'mbw'
        ? 'MB WAY enviado para ' + (updated.customerPhone || 'o cliente') + '.'
        : 'Ref. MB: Ent. ' + updated.easypay.entity + ' · ' + updated.easypay.reference);
    } else if (act === 'print') {
      if (order) printSlip(order);
      return;
    } else if (act === 'edit') {
      return openModal(order);
    } else if (act === 'cancel') {
      const operator = requireOperator(); if (!operator) return;
      if (!confirm('Cancelar/remover este pedido?')) return;
      await store.setStatus(id, 'cancelado', { operator });
    } else if (act === 'recolher') {
      const courier = requireCourier(); if (!courier) return;
      await store.setStatus(id, 'recolhido', { courier, operator: courier, note: 'Recolhido pelo estafeta' });
      toast('Pedido recolhido. Boa viagem!');
    } else if (act === 'deliver') {
      return openDeliver(order);
    }
    await refresh();
  } catch (err) { toast('Erro: ' + err.message); }
}

/* --------------------------- Localização (GPS) ------------------------- */

function onToggleLocation(e) {
  const status = document.getElementById('locStatus');
  if (e.target.checked) {
    const name = requireCourier();
    if (!name) { e.target.checked = false; return; }
    if (MODE !== 'api') { status.textContent = '(precisa do servidor para partilhar entre dispositivos)'; }
    if (!navigator.geolocation) { status.textContent = 'GPS não disponível neste dispositivo.'; e.target.checked = false; return; }
    status.textContent = 'A obter localização…';
    let last = 0;
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const t = Date.now();
        if (t - last < 15000) return; // no máx. a cada 15s
        last = t;
        store.shareLocation(currentUser(), pos.coords.latitude, pos.coords.longitude)
          .then(() => { status.textContent = 'Localização partilhada · ' + fmtTime(new Date().toISOString()); })
          .catch(() => {});
      },
      () => { status.textContent = 'Sem permissão de localização.'; },
      { enableHighAccuracy: true, maximumAge: 10000 }
    );
  } else {
    if (geoWatchId != null) { navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
    status.textContent = 'Partilha desligada.';
  }
}

/* ------------------------------ Modais --------------------------------- */

function rxRowHTML(p = {}) {
  return `<div class="rx-row">
    <input type="text" data-rx="number" placeholder="N.º da receita" value="${esc(p.number || '')}" autocomplete="off" />
    <input type="text" data-rx="accessCode" placeholder="Cód. acesso" value="${esc(p.accessCode || '')}" autocomplete="off" />
    <input type="text" data-rx="optionCode" placeholder="Cód. opção" value="${esc(p.optionCode || '')}" autocomplete="off" />
    <button type="button" class="icon-btn" data-rx-remove title="Remover receita">✕</button>
  </div>`;
}
function readPrescriptions() {
  return Array.from(document.querySelectorAll('#rxList .rx-row')).map((row) => ({
    number: row.querySelector('[data-rx="number"]').value.trim(),
    accessCode: row.querySelector('[data-rx="accessCode"]').value.trim(),
    optionCode: row.querySelector('[data-rx="optionCode"]').value.trim(),
  })).filter((p) => p.number || p.accessCode || p.optionCode);
}

function openModal(order) {
  const form = document.getElementById('orderForm');
  form.reset();
  document.getElementById('modalTitle').textContent = order ? 'Editar pedido ' + order.code : 'Novo pedido';
  form.elements.namedItem('orderId').value = order ? order.id : '';
  form.elements.namedItem('clientId').value = (order && order.clientId) || '';
  document.getElementById('clientSuggestions').hidden = true;
  document.getElementById('clientSearch').value = '';
  const rxList = document.getElementById('rxList');
  rxList.innerHTML = '';
  if (order) {
    form.elements.namedItem('customerName').value = order.customerName || '';
    form.elements.namedItem('customerNif').value = order.customerNif || '';
    form.elements.namedItem('customerPhone').value = order.customerPhone || '';
    form.elements.namedItem('customerAddress').value = order.customerAddress || '';
    form.elements.namedItem('deliveryDate').value = order.deliveryDate || '';
    form.elements.namedItem('items').value = order.items || '';
    form.elements.namedItem('paymentAmount').value = order.paymentAmount || '';
    form.elements.namedItem('paymentMethod').value = order.paymentMethod || 'mb';
    form.elements.namedItem('refrigerated').checked = !!order.refrigerated;
    form.elements.namedItem('callOnArrival').checked = !!order.callOnArrival;
    form.elements.namedItem('notes').value = order.notes || '';
    (order.prescriptions || []).forEach((p) => rxList.insertAdjacentHTML('beforeend', rxRowHTML(p)));
  }
  loadClientsCache();
  document.getElementById('modal').hidden = false;
  setTimeout(() => form.elements.namedItem('customerName').focus(), 50);
}
function closeModal() { document.getElementById('modal').hidden = true; }

async function loadClientsCache() {
  try { clients = await store.listClients(); } catch (_) { clients = []; }
}

function clientMatches(q) {
  const n = q.toLowerCase();
  return clients.filter((c) =>
    (c.name && c.name.toLowerCase().includes(n)) ||
    (c.nif && c.nif.includes(q)) ||
    (c.phone && c.phone.replace(/\s/g, '').includes(q.replace(/\s/g, '')))
  ).slice(0, 8);
}

function onClientSearch() {
  const q = document.getElementById('clientSearch').value.trim();
  const box = document.getElementById('clientSuggestions');
  if (q.length < 2) { box.hidden = true; return; }
  const found = clientMatches(q);
  if (!found.length) { box.innerHTML = '<button type="button" disabled>Sem resultados — preenche abaixo para criar.</button>'; box.hidden = false; return; }
  box.innerHTML = found.map((c) =>
    `<button type="button" data-client="${c.id}">${esc(c.name)}<span class="cs-sub">${[c.nif && 'NIF ' + c.nif, c.phone, c.address].filter(Boolean).map(esc).join(' · ')}</span></button>`
  ).join('');
  box.hidden = false;
}

function fillFromClient(c) {
  const form = document.getElementById('orderForm');
  form.elements.namedItem('clientId').value = c.id;
  form.elements.namedItem('customerName').value = c.name || '';
  form.elements.namedItem('customerNif').value = c.nif || '';
  form.elements.namedItem('customerPhone').value = c.phone || '';
  form.elements.namedItem('customerAddress').value = c.address || '';
  document.getElementById('clientSuggestions').hidden = true;
  document.getElementById('clientSearch').value = '';
  toast('Cliente preenchido: ' + c.name);
}

async function onSubmitForm(e) {
  e.preventDefault();
  const form = e.target;
  const data = {
    clientId: form.elements.namedItem('clientId').value,
    customerName: form.elements.namedItem('customerName').value.trim(),
    customerNif: form.elements.namedItem('customerNif').value.trim(),
    customerPhone: form.elements.namedItem('customerPhone').value.trim(),
    customerAddress: form.elements.namedItem('customerAddress').value.trim(),
    deliveryDate: form.elements.namedItem('deliveryDate').value,
    items: form.elements.namedItem('items').value.trim(),
    prescriptions: readPrescriptions(),
    paymentAmount: Number(form.elements.namedItem('paymentAmount').value) || 0,
    paymentMethod: form.elements.namedItem('paymentMethod').value,
    paymentStatus: form.elements.namedItem('paymentMethod').value === 'pago' ? 'pago' : 'cobrar',
    refrigerated: form.elements.namedItem('refrigerated').checked,
    callOnArrival: form.elements.namedItem('callOnArrival').checked,
    notes: form.elements.namedItem('notes').value.trim(),
  };
  if (!data.customerName || !data.customerAddress) return toast('Nome e morada são obrigatórios.');
  try {
    // guarda/atualiza a ficha do cliente para futuras entregas
    if (form.elements.namedItem('saveClient').checked) {
      try {
        const c = await store.saveClientRecord({
          id: data.clientId, name: data.customerName, nif: data.customerNif,
          phone: data.customerPhone, address: data.customerAddress,
        });
        if (c && c.id) data.clientId = c.id;
      } catch (_) { /* não bloqueia o pedido */ }
    }
    if (form.elements.namedItem('orderId').value) await store.update(form.elements.namedItem('orderId').value, data);
    else { const operator = requireOperator(); if (!operator) return; await store.create(data, operator); }
    closeModal(); await refresh();
    toast(form.elements.namedItem('orderId').value ? 'Pedido atualizado.' : 'Pedido registado ✓');
  } catch (err) { toast('Erro: ' + err.message); }
}

/* ------------------------------ Faturação ------------------------------ */

function openInvoice(order) {
  const form = document.getElementById('invoiceForm');
  form.reset();
  form.elements.namedItem('orderId').value = order.id;
  document.getElementById('invoiceCode').textContent = order.code;
  form.elements.namedItem('invoiceAmount').value = order.paymentAmount || '';
  document.getElementById('invoiceModal').hidden = false;
  setTimeout(() => form.elements.namedItem('invoiceAmount').focus(), 50);
}

async function onSubmitInvoice(e) {
  e.preventDefault();
  const form = e.target;
  const operator = requireOperator(); if (!operator) return;
  try {
    await store.invoice(form.elements.namedItem('orderId').value, operator, Number(form.elements.namedItem('invoiceAmount').value) || 0);
    document.getElementById('invoiceModal').hidden = true;
    await refresh();
    toast('Faturado ✓');
  } catch (err) { toast('Erro: ' + err.message); }
}

/* ---------------------------- Impressão -------------------------------- */

function doPrint(bodyClass) {
  document.body.classList.add(bodyClass);
  try { if (typeof window.print === 'function') window.print(); } catch (_) {}
  setTimeout(() => document.body.classList.remove(bodyClass), 500);
}

function printSlip(o) {
  const slip = document.getElementById('printSlip');
  const amt = Number(o.paymentAmount) || 0;
  slip.innerHTML =
    '<h2>Gripharma — Entrega ao domicílio</h2>' +
    `<div class="slip-code">${esc(o.code)}</div>` +
    `<p><b>${esc(o.customerName)}</b>${o.customerNif ? ' · NIF ' + esc(o.customerNif) : ''}</p>` +
    `<p>${esc(o.customerAddress)}</p>` +
    (o.customerPhone ? `<p>Tel: ${esc(o.customerPhone)}</p>` : '') +
    (o.deliveryDate ? `<p>Entrega: ${esc(fmtDatePt(o.deliveryDate))}${o.deliveryTime ? ' às ' + esc(o.deliveryTime) : ''}</p>` : '') +
    '<hr/>' +
    (o.items ? `<p>${esc(o.items)}</p>` : '') +
    ((o.prescriptions || []).length ? `<p class="slip-small">Receitas: ${o.prescriptions.map((p) => esc(p.number || p.accessCode)).filter(Boolean).join(', ')}</p>` : '') +
    (o.refrigerated ? '<p><b>❄ REFRIGERADO — MANTER FRIO</b></p>' : '') +
    (o.callOnArrival ? '<p><b>Ligar ao chegar — cliente desce</b></p>' : '') +
    (o.notes ? `<p class="slip-small">Obs: ${esc(o.notes)}</p>` : '') +
    '<hr/>' +
    `<p><b>${o.paymentStatus === 'pago' ? 'PAGO' : 'A COBRAR: ' + amt.toFixed(2) + '€ (' + (PAY_LABELS[o.paymentMethod] || 'MB') + ')'}</b></p>` +
    `<p class="slip-small">Impresso ${new Date().toLocaleString('pt-PT')}</p>`;
  doPrint('printing-slip');
}

function openDeliver(order) {
  const form = document.getElementById('deliverForm');
  form.reset();
  form.elements.namedItem('orderId').value = order.id;
  document.getElementById('deliverCode').textContent = order.code;
  const payRow = document.getElementById('payRow');
  const amt = Number(order.paymentAmount) || 0;
  if (order.paymentStatus === 'cobrar' && amt > 0) {
    payRow.hidden = false;
    document.getElementById('payAmount').textContent = amt.toFixed(2) + '€';
    document.getElementById('payMethodLabel').textContent = '(' + (PAY_LABELS[order.paymentMethod] || 'MB') + ')';
  } else { payRow.hidden = true; }
  document.getElementById('deliverModal').hidden = false;
}

async function onSubmitDeliver(e) {
  e.preventDefault();
  const form = e.target;
  const id = form.elements.namedItem('orderId').value;
  const actor = prefs.role === 'estafeta' ? requireCourier() : requireOperator();
  if (!actor) return;
  const collected = form.elements.namedItem('paymentCollected').checked;
  const failed = form.elements.namedItem('paymentFailed').checked;
  if (collected && failed) return toast('Escolhe só uma opção: recebeste o pagamento OU o cliente não pagou.');
  try {
    await store.setStatus(id, 'entregue', {
      operator: actor, courier: prefs.role === 'estafeta' ? actor : undefined,
      receivedBy: form.elements.namedItem('receivedBy').value.trim(),
      deliveryOutcome: form.elements.namedItem('deliveryOutcome').value,
      paymentCollected: collected,
      paymentFailed: failed,
      note: form.elements.namedItem('note').value.trim(),
    });
    document.getElementById('deliverModal').hidden = true;
    await refresh();
    toast(failed ? 'Entrega registada — pagamento passou a Ref. MB (alerta na farmácia).' : 'Entrega confirmada!');
  } catch (err) { toast('Erro: ' + err.message); }
}

/* ------------------------------ Relatório ------------------------------ */

function reportRows() {
  return orders
    .filter((o) => o.status === 'entregue' && isToday(o.deliveredAt || o.updatedAt))
    .sort((a, b) => ((a.deliveredAt || a.updatedAt) < (b.deliveredAt || b.updatedAt) ? -1 : 1));
}

function openReport() {
  const rows = reportRows();
  document.getElementById('reportDate').textContent =
    new Date().toLocaleDateString('pt-PT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const body = document.getElementById('reportBody');
  if (!rows.length) {
    body.innerHTML = '<div class="report-empty">Ainda não há entregas registadas hoje.</div>';
  } else {
    const total = rows.reduce((s, o) => s + (Number(o.paymentAmount) || 0), 0);
    const cobrado = rows.filter((o) => o.paymentStatus === 'pago').reduce((s, o) => s + (Number(o.paymentAmount) || 0), 0);
    const byCourier = {};
    rows.forEach((o) => { const c = o.deliveredBy || o.courier || '—'; byCourier[c] = (byCourier[c] || 0) + 1; });
    const byCourierStr = Object.entries(byCourier).map(([c, n]) => `${esc(c)}: ${n}`).join(' · ');
    body.innerHTML =
      `<div class="report-summary">
         <div class="report-stat"><div class="v">${rows.length}</div><div class="l">Entregas</div></div>
         <div class="report-stat"><div class="v">${cobrado.toFixed(2)}€</div><div class="l">Cobrado na entrega</div></div>
         <div class="report-stat"><div class="v">${total.toFixed(2)}€</div><div class="l">Valor total entregue</div></div>
       </div>
       <div class="report-bycourier"><b>Por estafeta:</b> ${byCourierStr}</div>
       <table class="report-table"><thead><tr>
         <th>Hora</th><th>Código</th><th>Cliente</th><th>Estafeta</th><th>Desfecho</th><th class="num">Valor</th><th>Pagamento</th>
       </tr></thead><tbody>` +
      rows.map((o) => `<tr>
         <td>${fmtTime(o.deliveredAt || o.updatedAt)}</td>
         <td>${esc(o.code)}</td>
         <td>${esc(o.customerName)}</td>
         <td>${esc(o.deliveredBy || o.courier || '—')}</td>
         <td>${esc(o.deliveryOutcome || '—')}</td>
         <td class="num">${(Number(o.paymentAmount) || 0).toFixed(2)}€</td>
         <td>${o.paymentStatus === 'pago' ? 'Pago' : 'A cobrar'}</td>
       </tr>`).join('') +
      '</tbody></table>';
  }
  document.getElementById('reportModal').hidden = false;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportReportCsv() {
  const rows = reportRows();
  const header = ['Hora', 'Codigo', 'Cliente', 'Telefone', 'Morada', 'Estafeta', 'Desfecho', 'Valor', 'Pagamento', 'RecebidoPor'];
  const lines = [header.join(';')];
  rows.forEach((o) => {
    lines.push([
      fmtTime(o.deliveredAt || o.updatedAt), o.code, o.customerName, o.customerPhone, o.customerAddress,
      o.deliveredBy || o.courier || '', o.deliveryOutcome || '',
      (Number(o.paymentAmount) || 0).toFixed(2), o.paymentStatus === 'pago' ? 'Pago' : 'A cobrar', o.receivedBy || '',
    ].map(csvCell).join(';'));
  });
  const csv = '\uFEFF' + lines.join('\r\n'); // BOM para o Excel reconhecer UTF-8
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `entregas-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------- Utils --------------------------------- */

function ic(name) { return `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`; }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
}
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m <= 0) return 'agora';
  if (m === 1) return 'há 1 min';
  return 'há ' + m + ' min';
}
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

init();
