'use strict';
/*
 * Gripharma — Gestão de Entregas ao Domicílio
 * Servidor Node.js puro (sem dependências externas).
 * - Serve o frontend estático a partir de /docs
 * - API REST em /api/* com persistência num ficheiro JSON
 *
 * Complementa o Sifarma (GLINTT): NÃO substitui a faturação/dispensa,
 * apenas organiza e rastreia as entregas ao domicílio.
 *
 * Arrancar:  node server.js   (ou: npm start)
 * Abrir:     http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'docs');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const STATUSES = ['pendente', 'pronto', 'recolhido', 'entregue', 'cancelado'];

/* ----------------------------- Persistência ----------------------------- */

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(data.orders)) data.orders = [];
    if (typeof data.counter !== 'number') data.counter = data.orders.length;
    if (typeof data.couriers !== 'object' || !data.couriers) data.couriers = {};
    if (!Array.isArray(data.operators)) data.operators = [];
    if (!Array.isArray(data.clients)) data.clients = [];
    if (!Array.isArray(data.schedules)) data.schedules = [];
    return data;
  } catch (_) {
    return { orders: [], counter: 0, couriers: {}, operators: [], clients: [], schedules: [] };
  }
}

let DB = loadData();

function saveData() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
  fs.renameSync(tmp, DATA_FILE); // escrita atómica
}

/* ------------------------------- Helpers -------------------------------- */

const nowISO = () => new Date().toISOString();

function sendJSON(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('payload demasiado grande'));
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const PAYMENT_METHODS = ['mb', 'referencia', 'numerario', 'pago'];

function sanitizePrescriptions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => ({ number: str(p.number), accessCode: str(p.accessCode), optionCode: str(p.optionCode) }))
    .filter((p) => p.number || p.accessCode || p.optionCode)
    .slice(0, 20);
}

function sanitizeOrderInput(input) {
  const method = PAYMENT_METHODS.includes(input.paymentMethod) ? input.paymentMethod : 'mb';
  return {
    clientId: str(input.clientId),
    customerName: str(input.customerName),
    customerNif: str(input.customerNif),
    customerPhone: str(input.customerPhone),
    customerAddress: str(input.customerAddress),
    items: str(input.items),
    prescriptions: sanitizePrescriptions(input.prescriptions),
    paymentAmount: num(input.paymentAmount),
    paymentMethod: method,
    paymentStatus: method === 'pago' ? 'pago' : 'cobrar',
    refrigerated: !!input.refrigerated,
    callOnArrival: !!input.callOnArrival,
    deliveryDate: str(input.deliveryDate),
    deliveryTime: str(input.deliveryTime),
    notes: str(input.notes),
  };
}

function sanitizeClient(input) {
  return {
    name: str(input.name),
    nif: str(input.nif),
    phone: str(input.phone),
    address: str(input.address),
    notes: str(input.notes),
  };
}

function upsertClient(data) {
  const norm = (s) => s.toLowerCase();
  let c = null;
  if (data.id) c = DB.clients.find((x) => x.id === data.id);
  if (!c && data.nif) c = DB.clients.find((x) => x.nif && x.nif === data.nif);
  if (!c && data.phone) c = DB.clients.find((x) => x.phone && x.phone === data.phone);
  if (!c && data.name) c = DB.clients.find((x) => norm(x.name) === norm(data.name) && !x.nif && !data.nif);
  const ts = nowISO();
  if (c) {
    Object.assign(c, sanitizeClient({ ...c, ...data }), { updatedAt: ts });
    return c;
  }
  c = { id: crypto.randomUUID(), ...sanitizeClient(data), createdAt: ts, updatedAt: ts };
  DB.clients.push(c);
  return c;
}

/* Entregas programadas recorrentes: gera o pedido do dia quando aplicável */
function todayStr() { return new Date().toISOString().slice(0, 10); }

function materializeSchedules() {
  const today = todayStr();
  const weekday = new Date().getDay(); // 0=Dom … 6=Sáb
  let changed = false;
  for (const s of DB.schedules) {
    if (Number(s.weekday) !== weekday || s.lastRun === today) continue;
    const ts = nowISO();
    DB.orders.push({
      id: crypto.randomUUID(),
      code: makeCode(),
      ...sanitizeOrderInput(s.order || {}),
      deliveryDate: today,
      deliveryTime: str(s.time),
      status: 'pendente',
      registeredBy: 'Programada',
      invoiced: false, invoicedBy: '', invoicedAt: '',
      readyBy: '', readyAt: '', courier: '', pickedAt: '',
      deliveredBy: '', deliveredAt: '', receivedBy: '', deliveryOutcome: '',
      paymentAlert: false, scheduleId: s.id,
      createdAt: ts, updatedAt: ts,
      history: [{ status: 'pendente', at: ts, by: 'Programada', note: 'Entrega programada (' + (s.label || '') + ')' }],
    });
    s.lastRun = today;
    changed = true;
  }
  if (changed) saveData();
}

function makeCode() {
  DB.counter += 1;
  return '#' + String(DB.counter).padStart(4, '0');
}

const findOrder = (id) => DB.orders.find((o) => o.id === id);

/* --------------------------------- API ---------------------------------- */

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, id, action]
  const resource = parts[1];

  if (resource === 'health') return sendJSON(res, 200, { ok: true, time: nowISO() });

  /* --------------------------- Estafetas / GPS -------------------------- */
  if (resource === 'couriers') {
    if (req.method === 'GET') {
      const list = Object.entries(DB.couriers).map(([name, c]) => ({ name, ...c }));
      return sendJSON(res, 200, { couriers: list });
    }
    if (req.method === 'POST' && parts[2] === 'location') {
      const body = await readBody(req);
      const name = str(body.name);
      if (!name) return sendJSON(res, 400, { error: 'Nome do estafeta em falta' });
      DB.couriers[name] = { lat: num(body.lat), lng: num(body.lng), at: nowISO() };
      saveData();
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: 'Método não permitido' });
  }

  /* ----------------------------- Operadores ---------------------------- */
  if (resource === 'operators') {
    if (req.method === 'GET') {
      return sendJSON(res, 200, { operators: DB.operators.map((o) => ({ id: o.id, name: o.name })) });
    }
    if (req.method === 'POST' && parts[2] === 'login') {
      const body = await readBody(req);
      const op = DB.operators.find((o) => o.pin === str(body.pin));
      if (!op) return sendJSON(res, 401, { error: 'PIN inválido.' });
      return sendJSON(res, 200, { operator: { id: op.id, name: op.name } });
    }
    if (req.method === 'POST' && !parts[2]) {
      const body = await readBody(req);
      const name = str(body.name);
      const pin = str(body.pin);
      if (!name || !/^\d{4,6}$/.test(pin)) return sendJSON(res, 400, { error: 'Nome e PIN (4 a 6 dígitos) obrigatórios.' });
      if (DB.operators.some((o) => o.name.toLowerCase() === name.toLowerCase())) return sendJSON(res, 409, { error: 'Já existe um operador com esse nome.' });
      if (DB.operators.some((o) => o.pin === pin)) return sendJSON(res, 409, { error: 'Esse PIN já está em uso.' });
      const op = { id: crypto.randomUUID(), name, pin };
      DB.operators.push(op);
      saveData();
      return sendJSON(res, 201, { operator: { id: op.id, name: op.name } });
    }
    if (req.method === 'DELETE' && parts[2]) {
      DB.operators = DB.operators.filter((o) => o.id !== parts[2]);
      saveData();
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: 'Método não permitido' });
  }

  /* ------------------------------ Clientes ------------------------------ */
  if (resource === 'clients') {
    if (req.method === 'GET') return sendJSON(res, 200, { clients: DB.clients });
    if (req.method === 'POST' && parts[2] === 'import') {
      const body = await readBody(req);
      const list = Array.isArray(body.clients) ? body.clients : [];
      let count = 0;
      for (const raw of list) {
        const data = sanitizeClient(raw);
        if (!data.name) continue;
        upsertClient(data);
        count++;
      }
      saveData();
      return sendJSON(res, 200, { imported: count, total: DB.clients.length });
    }
    if (req.method === 'POST' && !parts[2]) {
      const body = await readBody(req);
      const data = sanitizeClient(body);
      if (!data.name) return sendJSON(res, 400, { error: 'Nome do cliente é obrigatório.' });
      const c = upsertClient({ ...data, id: str(body.id) });
      saveData();
      return sendJSON(res, 201, { client: c });
    }
    if (req.method === 'PUT' && parts[2]) {
      const c = DB.clients.find((x) => x.id === parts[2]);
      if (!c) return sendJSON(res, 404, { error: 'Cliente não encontrado' });
      const body = await readBody(req);
      Object.assign(c, sanitizeClient({ ...c, ...body }), { updatedAt: nowISO() });
      saveData();
      return sendJSON(res, 200, { client: c });
    }
    if (req.method === 'DELETE' && parts[2]) {
      DB.clients = DB.clients.filter((x) => x.id !== parts[2]);
      saveData();
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: 'Método não permitido' });
  }

  /* ------------------------- Entregas programadas ----------------------- */
  if (resource === 'schedules') {
    if (req.method === 'GET') return sendJSON(res, 200, { schedules: DB.schedules });
    if (req.method === 'POST' && !parts[2]) {
      const body = await readBody(req);
      const order = sanitizeOrderInput(body.order || {});
      if (!order.customerName || !order.customerAddress) {
        return sendJSON(res, 400, { error: 'Nome e morada são obrigatórios.' });
      }
      const s = {
        id: crypto.randomUUID(),
        label: str(body.label) || order.customerName,
        weekday: Math.max(0, Math.min(6, num(body.weekday))),
        time: str(body.time),
        order,
        lastRun: '',
        createdAt: nowISO(),
      };
      DB.schedules.push(s);
      saveData();
      return sendJSON(res, 201, { schedule: s });
    }
    if (req.method === 'DELETE' && parts[2]) {
      DB.schedules = DB.schedules.filter((x) => x.id !== parts[2]);
      saveData();
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: 'Método não permitido' });
  }

  if (resource !== 'orders') return sendJSON(res, 404, { error: 'Recurso não encontrado' });

  const id = parts[2];
  const action = parts[3];

  // GET /api/orders
  if (req.method === 'GET' && !id) {
    materializeSchedules();
    const orders = [...DB.orders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return sendJSON(res, 200, { orders });
  }

  // POST /api/orders
  if (req.method === 'POST' && !id) {
    const body = await readBody(req);
    const data = sanitizeOrderInput(body);
    if (!data.customerName || !data.customerAddress) {
      return sendJSON(res, 400, { error: 'Nome e morada do cliente são obrigatórios.' });
    }
    const ts = nowISO();
    const operator = str(body.operator);
    const order = {
      id: crypto.randomUUID(),
      code: makeCode(),
      ...data,
      status: 'pendente',
      registeredBy: operator,
      invoiced: false, invoicedBy: '', invoicedAt: '',
      readyBy: '', readyAt: '',
      courier: '', pickedAt: '',
      deliveredBy: '', deliveredAt: '', receivedBy: '', deliveryOutcome: '',
      paymentAlert: false,
      createdAt: ts, updatedAt: ts,
      history: [{ status: 'pendente', at: ts, by: operator, note: 'Pedido registado' }],
    };
    DB.orders.push(order);
    saveData();
    return sendJSON(res, 201, { order });
  }

  if (!id) return sendJSON(res, 405, { error: 'Método não permitido' });

  const order = findOrder(id);
  if (!order) return sendJSON(res, 404, { error: 'Pedido não encontrado' });

  // PUT /api/orders/:id  (editar campos)
  if (req.method === 'PUT' && !action) {
    const body = await readBody(req);
    const data = sanitizeOrderInput({ ...order, ...body });
    if (!data.customerName || !data.customerAddress) {
      return sendJSON(res, 400, { error: 'Nome e morada do cliente são obrigatórios.' });
    }
    Object.assign(order, data, { updatedAt: nowISO() });
    saveData();
    return sendJSON(res, 200, { order });
  }

  // POST /api/orders/:id/invoice  (marcar como faturado no Sifarma)
  if (req.method === 'POST' && action === 'invoice') {
    const body = await readBody(req);
    const ts = nowISO();
    const operator = str(body.operator);
    order.invoiced = true;
    order.invoicedBy = operator;
    order.invoicedAt = ts;
    order.updatedAt = ts;
    if (body.invoiceAmount != null) order.paymentAmount = num(body.invoiceAmount);
    order.history.push({ status: order.status, at: ts, by: operator, note: 'Faturado (Sifarma)' + (body.invoiceAmount != null ? ' — ' + num(body.invoiceAmount).toFixed(2) + '€' : '') });
    saveData();
    return sendJSON(res, 200, { order });
  }

  // POST /api/orders/:id/status  (mudar estado)
  if (req.method === 'POST' && action === 'status') {
    const body = await readBody(req);
    const status = str(body.status);
    if (!STATUSES.includes(status)) return sendJSON(res, 400, { error: 'Estado inválido' });
    const ts = nowISO();
    const operator = str(body.operator);
    order.status = status;
    order.updatedAt = ts;

    if (status === 'pronto') { order.readyBy = operator; order.readyAt = ts; }
    if (status === 'recolhido') {
      order.courier = str(body.courier) || operator;
      order.pickedAt = ts;
    }
    if (status === 'entregue') {
      order.deliveredBy = str(body.courier) || str(body.operator) || order.courier;
      order.deliveredAt = ts;
      order.receivedBy = str(body.receivedBy);
      order.deliveryOutcome = str(body.deliveryOutcome);
      if (body.paymentCollected) { order.paymentStatus = 'pago'; order.paymentAlert = false; }
      if (body.paymentFailed) {
        // Cliente não pagou na entrega → passa a Referência MB + alerta no backoffice
        order.paymentMethod = 'referencia';
        order.paymentAlert = true;
        order.history.push({ status, at: ts, by: operator || order.courier, note: 'Cliente não pagou — passou a Referência MB' });
      }
    }
    order.history.push({
      status, at: ts, by: operator || order.courier, note: str(body.note),
    });
    saveData();
    return sendJSON(res, 200, { order });
  }

  // POST /api/orders/:id/collect  (receber pagamento pendente)
  if (req.method === 'POST' && action === 'collect') {
    const body = await readBody(req);
    const ts = nowISO();
    order.paymentStatus = 'pago';
    order.paymentAlert = false;
    order.updatedAt = ts;
    order.history.push({ status: order.status, at: ts, by: str(body.operator), note: 'Pagamento recebido (' + (order.paymentMethod || 'mb') + ')' });
    saveData();
    return sendJSON(res, 200, { order });
  }

  // DELETE /api/orders/:id
  if (req.method === 'DELETE' && !action) {
    DB.orders = DB.orders.filter((o) => o.id !== id);
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 405, { error: 'Método não permitido' });
}

/* ----------------------------- Estáticos -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Acesso negado'); }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('Não encontrado'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

/* ------------------------------- Servidor ------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (err) {
    sendJSON(res, 400, { error: err.message || 'Erro no pedido' });
  }
});

server.listen(PORT, () => {
  console.log('\n  Gripharma — Entregas ao Domicílio');
  console.log('  ---------------------------------');
  console.log(`  A correr em:  http://localhost:${PORT}`);
  console.log('  Na mesma rede (Wi-Fi), o estafeta acede por http://IP-DO-PC:' + PORT);
  console.log('  Ctrl+C para parar.\n');
});
