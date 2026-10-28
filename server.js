const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'miski-db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Asegurar carpeta de datos
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Base de datos inicial por defecto (Editable desde la App)
const DEFAULT_DB = {
  orderSequence: 0,
  security: {
    staffPin: '1234',
    adminPin: '9999',
    allowStaffMenuEdit: true,
    systemLocked: false,
    sessionVersion: 1
  },
  categories: [
    'Platos Fuertes',
    'Entradas',
    'Bebidas',
    'Extras / Porciones'
  ],
  tables: [
    'Mesa 1', 'Mesa 2', 'Mesa 3', 'Mesa 4', 'Mesa 5',
    'Mesa 6', 'Mesa 7', 'Mesa 8', 'Barra', 'Para Llevar'
  ],
  products: [
    {
      id: 'prod_1',
      name: 'Plato Especial Miski',
      category: 'Platos Fuertes',
      trackStock: true,
      stock: 20,
      active: true
    },
    {
      id: 'prod_2',
      name: 'Pollo a la Plancha con Guarnición',
      category: 'Platos Fuertes',
      trackStock: true,
      stock: 15,
      active: true
    },
    {
      id: 'prod_3',
      name: 'Lomo Saltado Clásico',
      category: 'Platos Fuertes',
      trackStock: false,
      stock: 0,
      active: true
    },
    {
      id: 'prod_4',
      name: 'Sopa / Entrada del Día',
      category: 'Entradas',
      trackStock: true,
      stock: 25,
      active: true
    },
    {
      id: 'prod_5',
      name: 'Tequeños / Empanaditas (x4)',
      category: 'Entradas',
      trackStock: false,
      stock: 0,
      active: true
    },
    {
      id: 'prod_6',
      name: 'Chicha Morada / Limonada (Vaso)',
      category: 'Bebidas',
      trackStock: true,
      stock: 30,
      active: true
    },
    {
      id: 'prod_7',
      name: 'Jarra de Refresco Familiar',
      category: 'Bebidas',
      trackStock: true,
      stock: 10,
      active: true
    },
    {
      id: 'prod_8',
      name: 'Gaseosa Personal',
      category: 'Bebidas',
      trackStock: false,
      stock: 0,
      active: true
    },
    {
      id: 'prod_9',
      name: 'Porción Extra de Papas / Arroz',
      category: 'Extras / Porciones',
      trackStock: false,
      stock: 0,
      active: true
    }
  ],
  orders: []
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_DB,
        ...parsed,
        security: { ...DEFAULT_DB.security, ...(parsed.security || {}) }
      };
    }
  } catch (err) {
    console.error('Error cargando base de datos, usando valores iniciales:', err.message);
  }
  saveDB(DEFAULT_DB);
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error guardando base de datos:', err.message);
  }
}

let db = loadDB();

// Clientes conectados en tiempo real (Server-Sent Events)
const sseClients = new Set();

function broadcast(eventType, payload = {}) {
  const message = JSON.stringify({
    type: eventType,
    timestamp: Date.now(),
    state: getPublicState(),
    ...payload
  });
  for (const client of sseClients) {
    try {
      client.write(`data: ${message}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address, url: `http://${iface.address}:${PORT}` });
      }
    }
  }
  return ips;
}

function getPublicState() {
  return {
    orderSequence: db.orderSequence,
    categories: db.categories,
    tables: db.tables,
    products: db.products,
    orders: db.orders,
    security: {
      allowStaffMenuEdit: db.security?.allowStaffMenuEdit !== false,
      systemLocked: Boolean(db.security?.systemLocked),
      sessionVersion: db.security?.sessionVersion || 1
    },
    network: {
      port: PORT,
      ips: getLocalIPs()
    }
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Payload demasiado grande'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // 1. Endpoint de Tiempo Real (SSE)
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    const initMsg = JSON.stringify({
      type: 'INIT',
      timestamp: Date.now(),
      state: getPublicState()
    });
    res.write(`data: ${initMsg}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. Obtener estado actual
  if (pathname === '/api/state' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, state: getPublicState() });
  }

  try {
    // 2.1 Autenticación por PIN (Evitar acceso al público general)
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const pin = String(body.pin || '').trim();

      if (!db.security) db.security = { ...DEFAULT_DB.security };

      if (pin === db.security.adminPin) {
        return sendJSON(res, 200, {
          ok: true,
          role: 'admin',
          sessionVersion: db.security.sessionVersion || 1,
          adminConfig: {
            staffPin: db.security.staffPin,
            adminPin: db.security.adminPin,
            allowStaffMenuEdit: db.security.allowStaffMenuEdit !== false,
            systemLocked: Boolean(db.security.systemLocked)
          }
        });
      }

      if (db.security.systemLocked) {
        return sendJSON(res, 403, {
          ok: false,
          error: '🔒 El sistema está cerrado temporalmente por el Administrador.'
        });
      }

      if (pin === db.security.staffPin) {
        return sendJSON(res, 200, {
          ok: true,
          role: 'staff',
          sessionVersion: db.security.sessionVersion || 1
        });
      }

      return sendJSON(res, 401, {
        ok: false,
        error: '❌ PIN incorrecto. Acceso exclusivo para personal autorizado de Miski.'
      });
    }

    // 2.2 Configuración de Seguridad (Solo Administrador)
    if (pathname === '/api/admin/security' && req.method === 'PUT') {
      const body = await parseBody(req);
      const currentAdminPin = String(body.currentAdminPin || '').trim();

      if (!db.security) db.security = { ...DEFAULT_DB.security };

      if (currentAdminPin !== db.security.adminPin) {
        return sendJSON(res, 403, { ok: false, error: 'No autorizado. Se requiere PIN de Administrador.' });
      }

      let revokeSessions = Boolean(body.revokeAllSessions);

      if (typeof body.newStaffPin === 'string' && body.newStaffPin.trim().length >= 3) {
        if (body.newStaffPin.trim() !== db.security.staffPin) {
          db.security.staffPin = body.newStaffPin.trim();
          revokeSessions = true;
        }
      }

      if (typeof body.newAdminPin === 'string' && body.newAdminPin.trim().length >= 3) {
        db.security.adminPin = body.newAdminPin.trim();
      }

      if (typeof body.allowStaffMenuEdit === 'boolean') {
        db.security.allowStaffMenuEdit = body.allowStaffMenuEdit;
      }

      if (typeof body.systemLocked === 'boolean') {
        db.security.systemLocked = body.systemLocked;
        if (body.systemLocked) revokeSessions = true;
      }

      if (revokeSessions) {
        db.security.sessionVersion = (db.security.sessionVersion || 1) + 1;
      }

      saveDB(db);
      broadcast('SECURITY_UPDATED', {});

      return sendJSON(res, 200, {
        ok: true,
        sessionVersion: db.security.sessionVersion,
        adminConfig: {
          staffPin: db.security.staffPin,
          adminPin: db.security.adminPin,
          allowStaffMenuEdit: db.security.allowStaffMenuEdit,
          systemLocked: db.security.systemLocked
        },
        state: getPublicState()
      });
    }
    // 3. Crear un nuevo pedido (Mesero -> Cocina)
    if (pathname === '/api/orders' && req.method === 'POST') {
      const body = await parseBody(req);
      const { table, waiter, generalNote, items } = body;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return sendJSON(res, 400, { ok: false, error: 'El pedido debe tener al menos un producto.' });
      }

      // Verificar disponibilidad de stock antes de descontar
      for (const item of items) {
        const product = db.products.find(p => p.id === item.productId);
        if (!product) {
          return sendJSON(res, 400, { ok: false, error: `Producto no encontrado: ${item.name}` });
        }
        if (!product.active) {
          return sendJSON(res, 400, { ok: false, error: `"${product.name}" no está disponible en este momento.` });
        }
        if (product.trackStock && product.stock < item.quantity) {
          return sendJSON(res, 400, {
            ok: false,
            error: `Stock insuficiente para "${product.name}". Quedan ${product.stock} y pediste ${item.quantity}.`
          });
        }
      }

      // Descontar stock de los productos que tengan control de cantidad activo
      for (const item of items) {
        const product = db.products.find(p => p.id === item.productId);
        if (product && product.trackStock) {
          product.stock = Math.max(0, product.stock - Number(item.quantity));
        }
      }

      db.orderSequence = (db.orderSequence || 0) + 1;
      const newOrder = {
        id: 'ord_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        orderNumber: db.orderSequence,
        table: (table || 'Sin Mesa').trim(),
        waiter: (waiter || '').trim(),
        generalNote: (generalNote || '').trim(),
        status: 'pendiente', // 'pendiente' | 'preparando' | 'entregado' | 'cancelado'
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deliveredAt: null,
        items: items.map((item, idx) => ({
          itemId: `item_${idx}_${Date.now()}`,
          productId: item.productId,
          name: item.name,
          quantity: Number(item.quantity) || 1,
          note: (item.note || '').trim(),
          done: false
        }))
      };

      db.orders.unshift(newOrder);
      saveDB(db);
      broadcast('NEW_ORDER', { order: newOrder });
      return sendJSON(res, 201, { ok: true, order: newOrder, state: getPublicState() });
    }

    // 4. Actualizar estado de un pedido en Cocina (preparando, entregado, cancelar, reabrir, o marcar ítem)
    if (pathname.startsWith('/api/orders/') && req.method === 'PUT') {
      const orderId = pathname.replace('/api/orders/', '');
      const body = await parseBody(req);
      const order = db.orders.find(o => o.id === orderId);

      if (!order) {
        return sendJSON(res, 404, { ok: false, error: 'Pedido no encontrado.' });
      }

      // Si se marca un ítem individual como listo/pendiente en cocina
      if (body.toggleItemId) {
        const targetItem = order.items.find(i => i.itemId === body.toggleItemId);
        if (targetItem) {
          targetItem.done = !targetItem.done;
          order.updatedAt = new Date().toISOString();
          saveDB(db);
          broadcast('ORDER_UPDATED', { order });
          return sendJSON(res, 200, { ok: true, order, state: getPublicState() });
        }
      }

      // Cambio de estado del pedido
      if (body.status) {
        const prevStatus = order.status;
        const nextStatus = body.status;

        // Si se cancela un pedido que no estaba cancelado, devolver el stock
        if (nextStatus === 'cancelado' && prevStatus !== 'cancelado') {
          for (const item of order.items) {
            const product = db.products.find(p => p.id === item.productId);
            if (product && product.trackStock) {
              product.stock += Number(item.quantity);
            }
          }
        }
        // Si se reactiva un pedido cancelado, volver a descontar stock
        if (prevStatus === 'cancelado' && nextStatus !== 'cancelado') {
          for (const item of order.items) {
            const product = db.products.find(p => p.id === item.productId);
            if (product && product.trackStock) {
              product.stock = Math.max(0, product.stock - Number(item.quantity));
            }
          }
        }

        order.status = nextStatus;
        order.updatedAt = new Date().toISOString();
        if (nextStatus === 'entregado') {
          order.deliveredAt = new Date().toISOString();
          order.items.forEach(i => { i.done = true; });
        }

        saveDB(db);
        broadcast('ORDER_STATUS_CHANGED', { order, prevStatus, nextStatus });
        return sendJSON(res, 200, { ok: true, order, state: getPublicState() });
      }

      return sendJSON(res, 400, { ok: false, error: 'Acción no reconocida.' });
    }

    // 5. Actualizar stock o configuración de un producto (Inicio de jornada o media jornada)
    if (pathname.startsWith('/api/products/') && req.method === 'PUT') {
      const prodId = pathname.replace('/api/products/', '');
      const body = await parseBody(req);
      const product = db.products.find(p => p.id === prodId);

      if (!product) {
        return sendJSON(res, 404, { ok: false, error: 'Producto no encontrado.' });
      }

      if (typeof body.name === 'string' && body.name.trim()) {
        product.name = body.name.trim();
      }
      if (typeof body.category === 'string' && body.category.trim()) {
        product.category = body.category.trim();
        if (!db.categories.includes(product.category)) {
          db.categories.push(product.category);
        }
      }
      if (typeof body.trackStock === 'boolean') {
        product.trackStock = body.trackStock;
      }
      if (typeof body.active === 'boolean') {
        product.active = body.active;
      }
      if (typeof body.stock === 'number' && !isNaN(body.stock)) {
        product.stock = Math.max(0, Math.round(body.stock));
      }
      if (typeof body.adjustStock === 'number' && !isNaN(body.adjustStock)) {
        product.trackStock = true;
        product.stock = Math.max(0, Math.round((product.stock || 0) + body.adjustStock));
      }

      saveDB(db);
      broadcast('STOCK_UPDATED', { product });
      return sendJSON(res, 200, { ok: true, product, state: getPublicState() });
    }

    // 6. Crear uno o varios productos en el menú (individual o carga rápida por lote)
    if (pathname === '/api/products' && req.method === 'POST') {
      const body = await parseBody(req);

      // Si envían un lote de productos (ej. pegados desde WhatsApp por el encargado)
      if (Array.isArray(body.bulkItems) && body.bulkItems.length > 0) {
        const added = [];
        for (const rawItem of body.bulkItems) {
          const name = (rawItem.name || '').trim();
          if (!name) continue;
          const category = (rawItem.category || 'General').trim();
          const hasStock = rawItem.stock !== undefined && rawItem.stock !== null && rawItem.stock !== '';
          const trackStock = Boolean(rawItem.trackStock ?? hasStock);
          const stock = Math.max(0, Math.round(Number(rawItem.stock) || 0));

          if (!db.categories.includes(category)) {
            db.categories.push(category);
          }

          const newProd = {
            id: 'prod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            name,
            category,
            trackStock,
            stock,
            active: true
          };
          db.products.push(newProd);
          added.push(newProd);
        }
        saveDB(db);
        broadcast('PRODUCTS_BULK_ADDED', { count: added.length });
        return sendJSON(res, 201, { ok: true, added, state: getPublicState() });
      }

      const name = (body.name || '').trim();
      const category = (body.category || 'General').trim();
      const trackStock = Boolean(body.trackStock);
      const stock = Math.max(0, Math.round(Number(body.stock) || 0));

      if (!name) {
        return sendJSON(res, 400, { ok: false, error: 'El nombre del producto es obligatorio.' });
      }

      if (!db.categories.includes(category)) {
        db.categories.push(category);
      }

      const newProduct = {
        id: 'prod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        name,
        category,
        trackStock,
        stock,
        active: true
      };

      db.products.push(newProduct);
      saveDB(db);
      broadcast('PRODUCT_ADDED', { product: newProduct });
      return sendJSON(res, 201, { ok: true, product: newProduct, state: getPublicState() });
    }

    // 7. Eliminar un producto del menú
    if (pathname.startsWith('/api/products/') && req.method === 'DELETE') {
      const prodId = pathname.replace('/api/products/', '');
      const index = db.products.findIndex(p => p.id === prodId);
      if (index === -1) {
        return sendJSON(res, 404, { ok: false, error: 'Producto no encontrado.' });
      }
      const removed = db.products.splice(index, 1)[0];
      saveDB(db);
      broadcast('PRODUCT_DELETED', { productId: prodId, removed });
      return sendJSON(res, 200, { ok: true, state: getPublicState() });
    }

    // 8. Configurar categorías o mesas o reiniciar jornada o limpiar menú
    if (pathname === '/api/pull-latest' && (req.method === 'POST' || req.method === 'GET')) {
      const filesToSync = ['index.html', 'styles.css', 'app.js', 'cloud-config.js', 'manifest.json', 'sw.js'];
      const baseRaw = 'https://raw.githubusercontent.com/camillooi529-debug/miski-app/main/public';
      for (const f of filesToSync) {
        await new Promise((resolve) => {
          https.get(`${baseRaw}/${f}?t=${Date.now()}`, (r) => {
            if (r.statusCode !== 200) { r.resume(); return resolve(); }
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => {
              try { fs.writeFileSync(path.join(PUBLIC_DIR, f), Buffer.concat(chunks)); } catch (e) {}
              resolve();
            });
          }).on('error', () => resolve());
        });
      }
      return sendJSON(res, 200, { ok: true, synced: filesToSync });
    }

    if (pathname === '/api/clear-menu' && req.method === 'POST') {
      db.products = [];
      saveDB(db);
      broadcast('MENU_CLEARED', {});
      return sendJSON(res, 200, { ok: true, state: getPublicState() });
    }

    if (pathname === '/api/reset-day' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.onlyFinished) {
        db.orders = db.orders.filter(o => o.status === 'pendiente' || o.status === 'preparando' || o.status === 'listo');
      } else {
        db.orders = [];
        db.orderSequence = 0;
      }
      if (body.disableAllStockLimits) {
        db.products.forEach(p => { p.trackStock = false; });
      }
      saveDB(db);
      broadcast('DAY_RESET', {});
      return sendJSON(res, 200, { ok: true, state: getPublicState() });
    }

    if (pathname === '/api/tables' && req.method === 'POST') {
      const body = await parseBody(req);
      if (Array.isArray(body.tables) && body.tables.length > 0) {
        db.tables = body.tables.map(t => String(t).trim()).filter(Boolean);
        saveDB(db);
        broadcast('TABLES_UPDATED', {});
      }
      return sendJSON(res, 200, { ok: true, state: getPublicState() });
    }
  } catch (err) {
    console.error('Error en API:', err);
    return sendJSON(res, 500, { ok: false, error: err.message || 'Error interno del servidor' });
  }

  // Servir archivos estáticos del frontend
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  } else {
    // Fallback SPA a index.html
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 - No encontrado');
    }
  }
});

// Ping periódico para mantener vivos los clientes SSE en celulares
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(`: keepalive ${Date.now()}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 15000);

// Auto-KeepAlive 24/7 en la Nube (evita que el servidor gratuito entre en reposo)
setInterval(() => {
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (externalUrl && externalUrl.startsWith('https://')) {
    https.get(`${externalUrl.replace(/\/+$/, '')}/api/state`, (res) => {
      res.resume();
    }).on('error', () => {});
  }
}, 8 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('====================================================');
  console.log('   🍽️  MISKI APP - SISTEMA MESERO Y COCINA LISTO');
  console.log('====================================================');
  console.log(`💻 En esta computadora: http://localhost:${PORT}`);
  if (ips.length > 0) {
    console.log('\n📱 En los teléfonos (conectados al mismo Wi-Fi / Hotspot):');
    ips.forEach(ip => {
      console.log(`   👉 ${ip.url}  (${ip.name})`);
    });
  } else {
    console.log('\n⚠️ Conecta esta PC a un Wi-Fi o Hotspot para ver el link de los teléfonos.');
  }
  console.log('====================================================\n');
});
