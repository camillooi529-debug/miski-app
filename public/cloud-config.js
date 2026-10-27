// ============================================================================
// MISKI APP - MOTOR HÍBRIDO GOOGLE FIREBASE 24/7 + SERVIDOR LOCAL
// Permite que la app funcione 24/7 con la PC apagada en Google Firebase
// y también en modo 100% local cuando se abre en una PC sin internet.
// ============================================================================

window.MISKI_FIREBASE_DB_URL = localStorage.getItem('miski_firebase_db_url') || '';

const DEFAULT_CLOUD_DB = {
  orderSequence: 0,
  security: {
    staffPin: '1234',
    adminPin: '9999',
    allowStaffMenuEdit: true,
    systemLocked: false,
    sessionVersion: 1
  },
  categories: ['Platos Fuertes', 'Entradas', 'Bebidas', 'Extras / Porciones'],
  tables: [
    'Mesa 1', 'Mesa 2', 'Mesa 3', 'Mesa 4', 'Mesa 5',
    'Mesa 6', 'Mesa 7', 'Mesa 8', 'Barra', 'Para Llevar'
  ],
  products: [
    { id: 'prod_1', name: 'Plato Especial Miski', category: 'Platos Fuertes', trackStock: true, stock: 20, active: true },
    { id: 'prod_2', name: 'Pollo a la Plancha con Guarnición', category: 'Platos Fuertes', trackStock: true, stock: 15, active: true },
    { id: 'prod_3', name: 'Lomo Saltado Clásico', category: 'Platos Fuertes', trackStock: false, stock: 0, active: true },
    { id: 'prod_4', name: 'Sopa / Entrada del Día', category: 'Entradas', trackStock: true, stock: 25, active: true },
    { id: 'prod_5', name: 'Chicha Morada / Limonada (Vaso)', category: 'Bebidas', trackStock: true, stock: 30, active: true },
    { id: 'prod_6', name: 'Jarra de Refresco Familiar', category: 'Bebidas', trackStock: true, stock: 10, active: true }
  ],
  orders: []
};

function getActiveFirebaseUrl() {
  const url = (window.MISKI_FIREBASE_DB_URL || '').trim().replace(/\/+$/, '');
  return url && url.startsWith('https://') ? url : '';
}

async function fetchCloudDB(baseUrl) {
  const res = await window._nativeFetch(`${baseUrl}/miski_db.json?t=${Date.now()}`);
  const data = await res.json();
  if (!data || typeof data !== 'object') {
    await saveCloudDB(baseUrl, DEFAULT_CLOUD_DB);
    return JSON.parse(JSON.stringify(DEFAULT_CLOUD_DB));
  }
  return {
    ...DEFAULT_CLOUD_DB,
    ...data,
    security: { ...DEFAULT_CLOUD_DB.security, ...(data.security || {}) },
    categories: Array.isArray(data.categories) ? data.categories : DEFAULT_CLOUD_DB.categories,
    tables: Array.isArray(data.tables) ? data.tables : DEFAULT_CLOUD_DB.tables,
    products: Array.isArray(data.products) ? data.products : [],
    orders: Array.isArray(data.orders) ? data.orders.map(o => ({
      ...o,
      items: Array.isArray(o.items) ? o.items : []
    })) : []
  };
}

async function saveCloudDB(baseUrl, dbObj) {
  await window._nativeFetch(`${baseUrl}/miski_db.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dbObj)
  });
}

function formatCloudPublicState(db) {
  return {
    orderSequence: db.orderSequence || 0,
    categories: db.categories || [],
    tables: db.tables || [],
    products: db.products || [],
    orders: db.orders || [],
    security: {
      allowStaffMenuEdit: db.security?.allowStaffMenuEdit !== false,
      systemLocked: Boolean(db.security?.systemLocked),
      sessionVersion: db.security?.sessionVersion || 1
    },
    network: {
      port: 443,
      ips: [{ name: 'Nube Google 24/7', address: window.location.host, url: window.location.origin }]
    }
  };
}

function makeJsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Interceptar llamadas /api/... cuando hay una base de datos Firebase activa
window._nativeFetch = window.fetch.bind(window);

window.fetch = async function (input, init = {}) {
  const urlStr = typeof input === 'string' ? input : input.url;
  const fbUrl = getActiveFirebaseUrl();

  if (!fbUrl || !urlStr.startsWith('/api/')) {
    return window._nativeFetch(input, init);
  }

  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : {};
  const db = await fetchCloudDB(fbUrl);

  // 1. GET /api/state
  if (urlStr === '/api/state' && method === 'GET') {
    return makeJsonResponse({ ok: true, state: formatCloudPublicState(db) });
  }

  // 2. POST /api/auth/login
  if (urlStr === '/api/auth/login' && method === 'POST') {
    const pin = String(body.pin || '').trim();
    if (pin === db.security.adminPin) {
      return makeJsonResponse({
        ok: true,
        role: 'admin',
        sessionVersion: db.security.sessionVersion || 1,
        adminConfig: db.security
      });
    }
    if (db.security.systemLocked) {
      return makeJsonResponse({ ok: false, error: '🔒 El sistema está cerrado temporalmente por el Administrador.' }, 403);
    }
    if (pin === db.security.staffPin) {
      return makeJsonResponse({
        ok: true,
        role: 'staff',
        sessionVersion: db.security.sessionVersion || 1
      });
    }
    return makeJsonResponse({ ok: false, error: '❌ PIN incorrecto. Acceso exclusivo para personal autorizado.' }, 401);
  }

  // 3. PUT /api/admin/security
  if (urlStr === '/api/admin/security' && method === 'PUT') {
    if (String(body.currentAdminPin || '').trim() !== db.security.adminPin) {
      return makeJsonResponse({ ok: false, error: 'No autorizado.' }, 403);
    }
    let revoke = Boolean(body.revokeAllSessions);
    if (typeof body.newStaffPin === 'string' && body.newStaffPin.trim().length >= 3) {
      if (body.newStaffPin.trim() !== db.security.staffPin) {
        db.security.staffPin = body.newStaffPin.trim();
        revoke = true;
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
      if (body.systemLocked) revoke = true;
    }
    if (revoke) {
      db.security.sessionVersion = (db.security.sessionVersion || 1) + 1;
    }
    await saveCloudDB(fbUrl, db);
    return makeJsonResponse({
      ok: true,
      sessionVersion: db.security.sessionVersion,
      adminConfig: db.security,
      state: formatCloudPublicState(db)
    });
  }

  // 4. POST /api/orders
  if (urlStr === '/api/orders' && method === 'POST') {
    const { table, waiter, generalNote, items } = body;
    for (const item of items || []) {
      const product = db.products.find(p => p.id === item.productId);
      if (!product) return makeJsonResponse({ ok: false, error: `Producto no encontrado: ${item.name}` }, 400);
      if (product.trackStock && product.stock < item.quantity) {
        return makeJsonResponse({
          ok: false,
          error: `Stock insuficiente para "${product.name}". Quedan ${product.stock}.`
        }, 400);
      }
    }
    for (const item of items || []) {
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
      status: 'pendiente',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deliveredAt: null,
      items: (items || []).map((item, idx) => ({
        itemId: `item_${idx}_${Date.now()}`,
        productId: item.productId,
        name: item.name,
        quantity: Number(item.quantity) || 1,
        note: (item.note || '').trim(),
        done: false
      }))
    };
    db.orders.unshift(newOrder);
    await saveCloudDB(fbUrl, db);
    return makeJsonResponse({ ok: true, order: newOrder, state: formatCloudPublicState(db) }, 201);
  }

  // 5. PUT /api/orders/:id
  if (urlStr.startsWith('/api/orders/') && method === 'PUT') {
    const orderId = urlStr.replace('/api/orders/', '');
    const order = db.orders.find(o => o.id === orderId);
    if (!order) return makeJsonResponse({ ok: false, error: 'Pedido no encontrado' }, 404);

    if (body.toggleItemId) {
      const targetItem = order.items.find(i => i.itemId === body.toggleItemId);
      if (targetItem) targetItem.done = !targetItem.done;
    }
    if (body.status) {
      const prev = order.status;
      const next = body.status;
      if (next === 'cancelado' && prev !== 'cancelado') {
        order.items.forEach(item => {
          const p = db.products.find(pr => pr.id === item.productId);
          if (p && p.trackStock) p.stock += Number(item.quantity);
        });
      }
      order.status = next;
      if (next === 'entregado') {
        order.deliveredAt = new Date().toISOString();
        order.items.forEach(i => { i.done = true; });
      }
    }
    order.updatedAt = new Date().toISOString();
    await saveCloudDB(fbUrl, db);
    return makeJsonResponse({ ok: true, order, state: formatCloudPublicState(db) });
  }

  // 6. POST /api/products
  if (urlStr === '/api/products' && method === 'POST') {
    if (Array.isArray(body.bulkItems)) {
      const added = [];
      for (const rawItem of body.bulkItems) {
        const name = (rawItem.name || '').trim();
        if (!name) continue;
        const category = (rawItem.category || 'General').trim();
        if (!db.categories.includes(category)) db.categories.push(category);
        const newProd = {
          id: 'prod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name,
          category,
          trackStock: Boolean(rawItem.trackStock),
          stock: Math.max(0, Math.round(Number(rawItem.stock) || 0)),
          active: true
        };
        db.products.push(newProd);
        added.push(newProd);
      }
      await saveCloudDB(fbUrl, db);
      return makeJsonResponse({ ok: true, added, state: formatCloudPublicState(db) }, 201);
    }

    const name = (body.name || '').trim();
    const category = (body.category || 'General').trim();
    if (!db.categories.includes(category)) db.categories.push(category);
    const newProduct = {
      id: 'prod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      name,
      category,
      trackStock: Boolean(body.trackStock),
      stock: Math.max(0, Math.round(Number(body.stock) || 0)),
      active: true
    };
    db.products.push(newProduct);
    await saveCloudDB(fbUrl, db);
    return makeJsonResponse({ ok: true, product: newProduct, state: formatCloudPublicState(db) }, 201);
  }

  // 7. PUT /api/products/:id
  if (urlStr.startsWith('/api/products/') && method === 'PUT') {
    const prodId = urlStr.replace('/api/products/', '');
    const product = db.products.find(p => p.id === prodId);
    if (!product) return makeJsonResponse({ ok: false, error: 'No encontrado' }, 404);

    if (typeof body.name === 'string' && body.name.trim()) product.name = body.name.trim();
    if (typeof body.category === 'string' && body.category.trim()) {
      product.category = body.category.trim();
      if (!db.categories.includes(product.category)) db.categories.push(product.category);
    }
    if (typeof body.trackStock === 'boolean') product.trackStock = body.trackStock;
    if (typeof body.stock === 'number' && !isNaN(body.stock)) product.stock = Math.max(0, Math.round(body.stock));
    if (typeof body.adjustStock === 'number' && !isNaN(body.adjustStock)) {
      product.trackStock = true;
      product.stock = Math.max(0, Math.round((product.stock || 0) + body.adjustStock));
    }
    await saveCloudDB(fbUrl, db);
    return makeJsonResponse({ ok: true, product, state: formatCloudPublicState(db) });
  }

  // 8. DELETE /api/products/:id
  if (urlStr.startsWith('/api/products/') && method === 'DELETE') {
    const prodId = urlStr.replace('/api/products/', '');
    db.products = db.products.filter(p => p.id !== prodId);
    await saveCloudDB(fbUrl, db);
    return makeJsonResponse({ ok: true, state: formatCloudPublicState(db) });
  }

  // 9. POST /api/clear-menu & /api/reset-day
  if (urlStr === '/api/clear-menu' && method === 'POST') {
    db.products = [];
    await saveCloudDB(fbUrl, db);
    return makeJsonResponse({ ok: true, state: formatCloudPublicState(db) });
  }

  if (urlStr === '/api/reset-day' && method === 'POST') {
    db.orders = [];
    db.orderSequence = 0;
    await saveCloudDB(fbUrl, db);
    return makeJsonResponse({ ok: true, state: formatCloudPublicState(db) });
  }

  return window._nativeFetch(input, init);
};
