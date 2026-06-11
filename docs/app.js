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
function demoOperators() { try { return JSON.parse(localStorage.getItem(OPERATORS_KEY)) || []; } catch (_) { return []; } }

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
    if (r.ok) { MODE = 'api'; setBadge('Servidor ligado · dados partilhados', false); return; }
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
  async invoice(id, operator) {
    if (MODE === 'api') return postJSON('api/orders/' + id + '/invoice', 'POST', { operator });
    const all = demoLoad(); const o = all.find((x) => x.id === id);
    if (o) {
      const ts = new Date().toISOString();
      o.invoiced = true; o.invoicedBy = operator; o.invoicedAt = ts; o.updatedAt = ts;
      o.history.push({ status: o.status, at: ts, by: operator, note: 'Faturado (Sifarma)' });
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
        if (extra.paymentCollected) o.paymentStatus = 'pago';
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
    if (o.status === 'entregue' && !isToday(o.updatedAt)) continue;
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
  const cobrar = orders.filter((o) => o.paymentStatus === 'cobrar' && ['pronto', 'recolhido'].includes(o.status))
    .reduce((s, o) => s + (Number(o.paymentAmount) || 0), 0);
  document.getElementById('stats').innerHTML =
    `<span>Ativos: <b>${active}</b></span><span>Entregues hoje: <b>${today}</b></span>` +
    `<span>A cobrar (em rota): <b>${cobrar.toFixed(2)}€</b></span>`;
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

function badges(o) {
  const b = [];
  const amt = Number(o.paymentAmount) || 0;
  if (o.paymentStatus === 'pago') b.push(`<span class="badge pay-pago">${ic('check')} Pago${amt ? ' ' + amt.toFixed(2) + '€' : ''}</span>`);
  else b.push(`<span class="badge pay-cobrar">${ic('wallet')} Cobrar${amt ? ' ' + amt.toFixed(2) + '€' : ''}</span>`);
  if (o.requiresPrescription) b.push(`<span class="badge rx">${ic('file')} Receita</span>`);
  if (o.refrigerated) b.push(`<span class="badge cold">${ic('snow')} Frio</span>`);
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

function cardCommon(o) {
  return (
    `<div class="card-top"><span class="card-code">${esc(o.code)}</span><span class="card-time">${fmtTime(o.createdAt)}</span></div>` +
    `<div class="card-name">${esc(o.customerName)}</div>` +
    `<div class="card-line">${ic('pin')} ${esc(o.customerAddress)}</div>` +
    (o.customerPhone ? `<div class="card-line">${ic('phone')} <a href="tel:${esc(o.customerPhone)}">${esc(o.customerPhone)}</a></div>` : '') +
    (o.items ? `<div class="card-items">${ic('pill')} ${esc(o.items)}</div>` : '') +
    (o.notes ? `<div class="card-line">${ic('pencil')} ${esc(o.notes)}</div>` : '') +
    `<div class="badges">${badges(o)}</div>`
  );
}

function cardFarmacia(o) {
  let actions = '';
  if (o.status === 'pendente') {
    actions =
      (o.invoiced ? '' : `<button class="btn btn-sm" data-act="invoice" data-id="${o.id}">${ic('receipt')} Faturar</button>`) +
      `<button class="btn btn-sm btn-primary" data-act="status" data-id="${o.id}" data-status="pronto">Marcar pronto</button>` +
      `<button class="btn btn-sm" data-act="edit" data-id="${o.id}">Editar</button>` +
      `<button class="btn btn-sm btn-danger" data-act="cancel" data-id="${o.id}">✕</button>`;
  } else if (o.status === 'pronto') {
    actions =
      (o.invoiced ? '' : `<button class="btn btn-sm" data-act="invoice" data-id="${o.id}">${ic('receipt')} Faturar</button>`) +
      `<button class="btn btn-sm" data-act="status" data-id="${o.id}" data-status="pendente">↩ Voltar</button>` +
      `<button class="btn btn-sm" data-act="edit" data-id="${o.id}">Editar</button>`;
  } else if (o.status === 'recolhido') {
    actions = `<button class="btn btn-sm btn-ok" data-act="deliver" data-id="${o.id}">Confirmar entrega</button>`;
  }
  return `<div class="card">${cardCommon(o)}${stampsLine(o)}<div class="card-actions">${actions}</div></div>`;
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
  return `<div class="card">${cardCommon(o)}<div class="card-actions">` +
    `<button class="btn btn-primary btn-block" data-act="recolher" data-id="${o.id}">${ic('bike')} Recolhi este pedido</button></div></div>`;
}
function cardEntrega(o) {
  return `<div class="card">${cardCommon(o)}${stampsLine(o)}<div class="card-actions">` +
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
  document.getElementById('btnPrintReport').addEventListener('click', () => window.print());

  document.querySelector('main').addEventListener('click', onCardClick);

  const modal = document.getElementById('modal');
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.hasAttribute('data-close')) closeModal(); });
  document.getElementById('orderForm').addEventListener('submit', onSubmitForm);

  const dm = document.getElementById('deliverModal');
  dm.addEventListener('click', (e) => { if (e.target === dm || e.target.hasAttribute('data-close-deliver')) dm.hidden = true; });
  document.getElementById('deliverForm').addEventListener('submit', onSubmitDeliver);
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
    } else if (act === 'invoice') {
      const operator = requireOperator(); if (!operator) return;
      await store.invoice(id, operator);
      toast('Marcado como faturado.');
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

function openModal(order) {
  const form = document.getElementById('orderForm');
  form.reset();
  document.getElementById('modalTitle').textContent = order ? 'Editar pedido ' + order.code : 'Novo pedido';
  form.elements.namedItem('orderId').value = order ? order.id : '';
  if (order) {
    form.elements.namedItem('customerName').value = order.customerName || '';
    form.elements.namedItem('customerPhone').value = order.customerPhone || '';
    form.elements.namedItem('customerAddress').value = order.customerAddress || '';
    form.elements.namedItem('items').value = order.items || '';
    form.elements.namedItem('paymentAmount').value = order.paymentAmount || '';
    form.elements.namedItem('paymentStatus').value = order.paymentStatus || 'cobrar';
    form.elements.namedItem('requiresPrescription').checked = !!order.requiresPrescription;
    form.elements.namedItem('refrigerated').checked = !!order.refrigerated;
    form.elements.namedItem('callOnArrival').checked = !!order.callOnArrival;
    form.elements.namedItem('notes').value = order.notes || '';
  }
  document.getElementById('modal').hidden = false;
  setTimeout(() => form.elements.namedItem('customerName').focus(), 50);
}
function closeModal() { document.getElementById('modal').hidden = true; }

async function onSubmitForm(e) {
  e.preventDefault();
  const form = e.target;
  const data = {
    customerName: form.elements.namedItem('customerName').value.trim(),
    customerPhone: form.elements.namedItem('customerPhone').value.trim(),
    customerAddress: form.elements.namedItem('customerAddress').value.trim(),
    items: form.elements.namedItem('items').value.trim(),
    paymentAmount: Number(form.elements.namedItem('paymentAmount').value) || 0,
    paymentStatus: form.elements.namedItem('paymentStatus').value,
    requiresPrescription: form.elements.namedItem('requiresPrescription').checked,
    refrigerated: form.elements.namedItem('refrigerated').checked,
    callOnArrival: form.elements.namedItem('callOnArrival').checked,
    notes: form.elements.namedItem('notes').value.trim(),
  };
  if (!data.customerName || !data.customerAddress) return toast('Nome e morada são obrigatórios.');
  try {
    if (form.elements.namedItem('orderId').value) await store.update(form.elements.namedItem('orderId').value, data);
    else { const operator = requireOperator(); if (!operator) return; await store.create(data, operator); }
    closeModal(); await refresh();
    toast(form.elements.namedItem('orderId').value ? 'Pedido atualizado.' : 'Pedido registado ✓');
  } catch (err) { toast('Erro: ' + err.message); }
}

function openDeliver(order) {
  const form = document.getElementById('deliverForm');
  form.reset();
  form.elements.namedItem('orderId').value = order.id;
  document.getElementById('deliverCode').textContent = order.code;
  const payRow = document.getElementById('payRow');
  const amt = Number(order.paymentAmount) || 0;
  if (order.paymentStatus === 'cobrar' && amt > 0) {
    payRow.hidden = false; document.getElementById('payAmount').textContent = amt.toFixed(2) + '€';
  } else { payRow.hidden = true; }
  document.getElementById('deliverModal').hidden = false;
}

async function onSubmitDeliver(e) {
  e.preventDefault();
  const form = e.target;
  const id = form.elements.namedItem('orderId').value;
  const actor = prefs.role === 'estafeta' ? requireCourier() : requireOperator();
  if (!actor) return;
  try {
    await store.setStatus(id, 'entregue', {
      operator: actor, courier: prefs.role === 'estafeta' ? actor : undefined,
      receivedBy: form.elements.namedItem('receivedBy').value.trim(),
      deliveryOutcome: form.elements.namedItem('deliveryOutcome').value,
      paymentCollected: form.elements.namedItem('paymentCollected').checked,
      note: form.elements.namedItem('note').value.trim(),
    });
    document.getElementById('deliverModal').hidden = true;
    await refresh();
    toast('Entrega confirmada!');
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
