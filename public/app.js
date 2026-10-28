// =========================================================
// MISKI APP - LÓGICA EN TIEMPO REAL (MESERO / COCINA / STOCK)
// =========================================================

let appState = {
  orderSequence: 0,
  categories: [],
  tables: [],
  products: [],
  orders: [],
  network: { port: 3000, ips: [] }
};

let currentView = localStorage.getItem('miski_view') || 'waiter';
let currentRole = localStorage.getItem('miski_role') || null; // 'admin' | 'staff' | null
let deviceProfile = localStorage.getItem('miski_device_profile') || null; // 'waiter' | 'kitchen' | 'admin' | null
let currentSessionVersion = Number(localStorage.getItem('miski_session_v') || 0);
let savedAdminPin = localStorage.getItem('miski_admin_pin') || '';
let adminConfigCache = null;

let selectedTable = 'Mesa 1';
let selectedCategory = 'TODOS';
let kitchenFilter = 'active'; // 'active' | 'done'
let cart = []; // [{ productId, name, quantity, note }]
let knownOrderIds = new Set();
let isFirstLoad = true;
let soundEnabled = true;

const QUICK_NOTES = ['Sin cebolla', 'Para llevar', 'Bien cocido', 'Sin picante', 'Sin ensalada'];

// =========================================================
// SONIDO DE CAMPANA PARA COCINA (100% OFFLINE CON WEB AUDIO)
// =========================================================
let audioCtx = null;

function initAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function playKitchenBell() {
  if (!soundEnabled) return;
  try {
    initAudio();
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    // Dos tonos de campana ("Ding - Dong")
    const notes = [880, 659.25, 1046.5];
    notes.forEach((freq, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.16);

      gain.gain.setValueAtTime(0.001, now + idx * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.35, now + idx * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.16 + 0.45);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start(now + idx * 0.16);
      osc.stop(now + idx * 0.16 + 0.48);
    });
  } catch (e) {
    console.warn('No se pudo reproducir sonido:', e);
  }
}

function testSound() {
  initAudio();
  soundEnabled = !soundEnabled;
  const label = document.getElementById('soundBtnLabel');
  if (soundEnabled) {
    if (label) label.textContent = 'Sonido ON';
    playKitchenBell();
    showToast('🔔 Sonido activado (Timbre corto de 1 segundo)');
  } else {
    if (label) label.textContent = 'Silenciado';
    showToast('🔕 Sonido silenciado en este dispositivo');
  }
}

// Activar audio en el primer toque de pantalla (requisito de celulares)
document.addEventListener('click', () => initAudio(), { once: true });

// =========================================================
// CONEXIÓN EN TIEMPO REAL CON EL SERVIDOR O NUBE GOOGLE
// =========================================================
function connectRealtime() {
  if (typeof getActiveFirebaseUrl === 'function' && getActiveFirebaseUrl()) {
    setConnectionStatus(true);
    fetch('/api/state').then(r => r.json()).then(j => {
      if (j.ok && j.state) handleIncomingState(j.state, 'INIT');
    }).catch(() => {});
    return;
  }

  const evtSource = new EventSource('/api/events');

  evtSource.onopen = () => {
    setConnectionStatus(true);
  };

  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.state) {
        handleIncomingState(data.state, data.type, data);
      }
    } catch (err) {
      console.error('Error procesando evento SSE:', err);
    }
  };

  evtSource.onerror = () => {
    setConnectionStatus(false);
    evtSource.close();
    setTimeout(connectRealtime, 3000);
  };
}

// Sincronización continua cada 2.5 segundos
setInterval(async () => {
  try {
    const res = await fetch('/api/state');
    const json = await res.json();
    if (json.ok && json.state) {
      setConnectionStatus(true);
      handleIncomingState(json.state, 'POLL');
    }
  } catch (e) {
    setConnectionStatus(false);
  }
}, 2500);

function setConnectionStatus(online) {
  const dot = document.getElementById('connDot');
  const txt = document.getElementById('connText');
  if (online) {
    dot.classList.remove('offline');
    txt.textContent = 'Sincronizado en vivo';
  } else {
    dot.classList.add('offline');
    txt.textContent = 'Reconectando...';
  }
}

function handleIncomingState(newState, eventType, extra = {}) {
  // Verificar si el Administrador cerró sesiones o cambió el PIN
  const serverSessionV = newState.security?.sessionVersion || 1;
  if (currentRole && currentSessionVersion !== serverSessionV) {
    if (currentRole === 'staff') {
      logoutSession('🔒 El Administrador actualizó los accesos. Ingresa el nuevo PIN.');
    } else {
      currentSessionVersion = serverSessionV;
      localStorage.setItem('miski_session_v', String(serverSessionV));
    }
  }

  if (currentRole === 'staff' && newState.security?.systemLocked) {
    logoutSession('🔒 El sistema fue cerrado temporalmente por el Administrador.');
  }

  // Detectar si llegó un pedido nuevo o si un pedido fue finalizado/entregado
  if (!isFirstLoad && currentRole && Array.isArray(newState.orders)) {
    const newOrders = newState.orders.filter(o => !knownOrderIds.has(o.id) && o.status === 'pendiente');
    if (newOrders.length > 0 && eventType !== 'LOCAL_SUBMIT') {
      // SOLO SONAR Y NOTIFICAR SI ESTE DISPOSITIVO ES COCINA O ADMIN
      if (deviceProfile === 'kitchen' || currentRole === 'admin') {
        playKitchenBell();
        const newest = newOrders[0];
        showToast(`🔔 ¡Nuevo Pedido #${newest.orderNumber} (${newest.table}) en Cocina!`);
      }
    }

    if (eventType === 'ORDER_STATUS_CHANGED' && extra.order) {
      if (extra.nextStatus === 'listo') {
        // SOLO SONAR Y VIBRAR SI ESTE DISPOSITIVO ES MESERO O ADMIN
        if (deviceProfile === 'waiter' || currentRole === 'admin') {
          playKitchenBell();
          if (navigator.vibrate) navigator.vibrate([250, 120, 250]);
          showToast(`🔔 ¡MESERO! Pedido #${extra.order.orderNumber} (${extra.order.table}) LISTO para recoger`);
        }
      } else if (extra.nextStatus === 'entregado') {
        showToast(`✅ Pedido #${extra.order.orderNumber} (${extra.order.table}) entregado y cerrado`);
      }
    }
  }

  if (Array.isArray(newState.orders)) {
    knownOrderIds = new Set(newState.orders.map(o => o.id));
  }
  isFirstLoad = false;

  appState = newState;
  if (!selectedTable && appState.tables.length > 0) {
    selectedTable = appState.tables[0];
  }

  syncAuthUI();
  renderAll();
}

// =========================================================
// AUTENTICACIÓN POR PIN Y PERFILES SEPARADOS (MESERO VS COCINA)
// =========================================================
function syncAuthUI() {
  const overlay = document.getElementById('authOverlay');
  const stepPin = document.getElementById('authStepPin');
  const stepProfile = document.getElementById('authStepProfile');
  const tabWaiter = document.getElementById('tabBtnWaiter');
  const tabKitchen = document.getElementById('tabBtnKitchen');
  const adminTab = document.getElementById('adminTabBtn');
  const roleBadge = document.getElementById('roleBadgeHeader');
  const menuEditorCol = document.getElementById('menuEditorColumn');
  const btnSwitchRole = document.getElementById('tabBtnSwitchRole');
  const btnLogout = document.getElementById('tabBtnLogout');

  if (!currentRole) {
    overlay.classList.add('open');
    if (stepPin) stepPin.style.display = 'block';
    if (stepProfile) stepProfile.style.display = 'none';
    if (roleBadge) roleBadge.textContent = '';
    if (btnSwitchRole) btnSwitchRole.style.display = 'none';
    if (btnLogout) btnLogout.style.display = 'none';
    return;
  }

  // Si es personal y aún no ha elegido si este celular es Mesero o Cocina
  if (currentRole === 'staff' && !deviceProfile) {
    overlay.classList.add('open');
    if (stepPin) stepPin.style.display = 'none';
    if (stepProfile) stepProfile.style.display = 'block';
    if (btnSwitchRole) btnSwitchRole.style.display = 'none';
    if (btnLogout) btnLogout.style.display = 'none';
    return;
  }

  overlay.classList.remove('open');
  if (btnLogout) btnLogout.style.display = 'inline-flex';

  if (currentRole === 'admin') {
    if (tabWaiter) tabWaiter.style.display = 'inline-flex';
    if (tabKitchen) tabKitchen.style.display = 'inline-flex';
    if (adminTab) adminTab.style.display = 'inline-flex';
    if (btnSwitchRole) btnSwitchRole.style.display = 'none';
    if (roleBadge) {
      roleBadge.textContent = '👑 ADMIN';
      roleBadge.style.color = '#fbbf24';
    }
    if (menuEditorCol) menuEditorCol.style.display = 'flex';
  } else {
    if (adminTab) adminTab.style.display = 'none';
    const canEdit = appState.security?.allowStaffMenuEdit !== false;
    if (menuEditorCol) {
      menuEditorCol.style.display = canEdit ? 'flex' : 'none';
    }

    if (btnSwitchRole) {
      btnSwitchRole.style.display = 'inline-flex';
      if (deviceProfile === 'waiter') {
        btnSwitchRole.innerHTML = '👨‍🍳 A Cocina';
        btnSwitchRole.style.color = '#60a5fa';
        btnSwitchRole.style.borderColor = 'rgba(96,165,250,0.4)';
      } else {
        btnSwitchRole.innerHTML = '📝 A Mesero';
        btnSwitchRole.style.color = '#fb923c';
        btnSwitchRole.style.borderColor = 'rgba(249,115,22,0.4)';
      }
    }

    if (deviceProfile === 'waiter') {
      if (tabWaiter) tabWaiter.style.display = 'inline-flex';
      if (tabKitchen) tabKitchen.style.display = 'none';
      if (roleBadge) {
        roleBadge.textContent = '📝 MESERO';
        roleBadge.style.color = '#fb923c';
      }
      if (currentView === 'kitchen' || currentView === 'admin') {
        currentView = 'waiter';
        localStorage.setItem('miski_view', 'waiter');
      }
    } else if (deviceProfile === 'kitchen') {
      if (tabWaiter) tabWaiter.style.display = 'none';
      if (tabKitchen) tabKitchen.style.display = 'inline-flex';
      if (roleBadge) {
        roleBadge.textContent = '👨‍🍳 COCINA';
        roleBadge.style.color = '#60a5fa';
      }
      if (currentView === 'waiter' || currentView === 'admin') {
        currentView = 'kitchen';
        localStorage.setItem('miski_view', 'kitchen');
      }
    }
  }

  document.querySelectorAll('.role-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === currentView);
  });
  document.querySelectorAll('.view-section').forEach(sec => {
    sec.classList.toggle('active', sec.id === `view-${currentView}`);
  });
}

async function handlePinLogin(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('pinLoginInput');
  const errEl = document.getElementById('pinLoginError');
  const pin = (input?.value || '').trim();
  if (!pin) return;

  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();

    if (!data.ok) {
      errEl.textContent = data.error || 'PIN incorrecto';
      errEl.style.display = 'block';
      return;
    }

    currentRole = data.role;
    currentSessionVersion = data.sessionVersion || 1;
    localStorage.setItem('miski_role', currentRole);
    localStorage.setItem('miski_session_v', String(currentSessionVersion));

    if (currentRole === 'admin') {
      deviceProfile = 'admin';
      localStorage.setItem('miski_device_profile', 'admin');
      savedAdminPin = pin;
      localStorage.setItem('miski_admin_pin', pin);
      adminConfigCache = data.adminConfig || null;
      populateAdminInputs();
      initAudio();
      showToast('👑 Bienvenido Administrador');
    } else {
      // Mostrar pantalla para elegir entre Soy Mesero o Soy Cocina
      deviceProfile = null;
      localStorage.removeItem('miski_device_profile');
    }

    if (input) input.value = '';
    syncAuthUI();
    renderAll();
  } catch (err) {
    errEl.textContent = 'Error de conexión con el servidor';
    errEl.style.display = 'block';
  }
}

function selectDeviceProfile(profile) {
  deviceProfile = profile;
  localStorage.setItem('miski_device_profile', profile);

  // Desbloquear parlante del navegador al hacer clic en el botón del perfil
  initAudio();
  soundEnabled = true;

  if (profile === 'kitchen') {
    currentView = 'kitchen';
    localStorage.setItem('miski_view', 'kitchen');
    playKitchenBell();
    showToast('👨‍🍳 Modo Cocina Activo — Campana de pedidos encendida 🔔');
  } else {
    currentView = 'waiter';
    localStorage.setItem('miski_view', 'waiter');
    showToast('📝 Modo Mesero Activo — Listo para tomar pedidos');
  }

  syncAuthUI();
  renderAll();
}

function quickToggleStaffRole() {
  if (deviceProfile === 'waiter') {
    selectDeviceProfile('kitchen');
  } else {
    selectDeviceProfile('waiter');
  }
}

function logoutSession(customMsg) {
  currentRole = null;
  deviceProfile = null;
  savedAdminPin = '';
  localStorage.removeItem('miski_role');
  localStorage.removeItem('miski_device_profile');
  localStorage.removeItem('miski_admin_pin');
  localStorage.removeItem('miski_view');

  // Si había algún parámetro en la URL (?pin=... o ?role=...), removerlo
  if (window.location.search) {
    try {
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (e) {}
  }

  const pinInput = document.getElementById('pinLoginInput');
  if (pinInput) pinInput.value = '';

  syncAuthUI();
  showToast('🔒 Sesión cerrada');

  if (customMsg) {
    const errEl = document.getElementById('pinLoginError');
    if (errEl) {
      errEl.textContent = customMsg;
      errEl.style.display = 'block';
    }
  }

  setTimeout(() => {
    const input = document.getElementById('pinLoginInput');
    if (input) input.focus();
  }, 100);
}

// =========================================================
// NAVEGACIÓN ENTRE VISTAS (MESERO / COCINA / STOCK / ADMIN)
// =========================================================
function switchView(viewName) {
  if (viewName === 'admin' && currentRole !== 'admin') {
    viewName = deviceProfile === 'kitchen' ? 'kitchen' : 'waiter';
  }
  if (currentRole === 'staff') {
    if (deviceProfile === 'waiter' && viewName === 'kitchen') viewName = 'waiter';
    if (deviceProfile === 'kitchen' && viewName === 'waiter') viewName = 'kitchen';
  }
  currentView = viewName;
  localStorage.setItem('miski_view', viewName);

  document.querySelectorAll('.role-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  document.querySelectorAll('.view-section').forEach(sec => {
    sec.classList.toggle('active', sec.id === `view-${viewName}`);
  });

  renderAll();
}

function renderAll() {
  updateBadges();
  renderWaiterTables();
  renderCategories();
  renderWaiterProducts();
  renderCart();
  renderWaiterActiveOrders();
  renderKitchenOrders();
  renderStockManager();
  renderAdminPanel();
}

function updateBadges() {
  const activeOrders = appState.orders.filter(
    o => o.status === 'pendiente' || o.status === 'preparando' || o.status === 'listo'
  );
  const doneOrders = appState.orders.filter(o => o.status === 'entregado');

  const kBadge = document.getElementById('kitchenBadge');
  if (activeOrders.length > 0) {
    kBadge.style.display = 'inline-block';
    kBadge.textContent = activeOrders.length;
  } else {
    kBadge.style.display = 'none';
  }

  document.getElementById('kCountActive').textContent = activeOrders.length;
  document.getElementById('kCountDone').textContent = doneOrders.length;
  document.getElementById('waiterActiveCount').textContent = `${activeOrders.length} activos`;
}

// =========================================================
// 1. LÓGICA DE MESERO (MESAS, MENÚ, STOCK EN VIVO Y CARRITO)
// =========================================================
function renderWaiterTables() {
  const container = document.getElementById('tablesGrid');
  if (!container) return;

  const activeTables = new Set(
    appState.orders
      .filter(o => o.status === 'pendiente' || o.status === 'preparando' || o.status === 'listo')
      .map(o => o.table)
  );

  container.innerHTML = appState.tables.map(t => {
    const isSelected = selectedTable === t;
    const hasOrder = activeTables.has(t);
    return `
      <button
        type="button"
        class="table-btn ${isSelected ? 'selected' : ''} ${hasOrder ? 'has-active' : ''}"
        onclick="selectTable('${escapeHtml(t)}')"
      >
        ${escapeHtml(t)} ${hasOrder ? '🔥' : ''}
      </button>
    `;
  }).join('');

  document.getElementById('selectedTableDisplay').textContent = selectedTable;
  document.getElementById('cartTableBadge').textContent = selectedTable;
}

function selectTable(tableName) {
  selectedTable = tableName;
  document.getElementById('customTableInput').value = '';
  renderWaiterTables();
}

function onCustomTableInput(val) {
  if (val.trim()) {
    selectedTable = val.trim();
  } else if (appState.tables.length > 0) {
    selectedTable = appState.tables[0];
  }
  renderWaiterTables();
}

function renderCategories() {
  const pillsContainer = document.getElementById('categoryPills');
  const datalist = document.getElementById('categorySuggestions');
  if (!pillsContainer) return;

  const cats = ['TODOS', ...appState.categories];
  pillsContainer.innerHTML = cats.map(c => `
    <button
      type="button"
      class="cat-pill ${selectedCategory === c ? 'active' : ''}"
      onclick="selectCategory('${escapeHtml(c)}')"
    >
      ${escapeHtml(c)}
    </button>
  `).join('');

  if (datalist) {
    datalist.innerHTML = appState.categories.map(c => `<option value="${escapeHtml(c)}">`).join('');
  }
}

function selectCategory(cat) {
  selectedCategory = cat;
  renderCategories();
  renderWaiterProducts();
}

function getCartQtyForProduct(productId) {
  return cart
    .filter(item => item.productId === productId)
    .reduce((sum, item) => sum + item.quantity, 0);
}

function renderWaiterProducts() {
  const grid = document.getElementById('waiterProductsGrid');
  if (!grid) return;

  const query = (document.getElementById('searchProductInput')?.value || '').toLowerCase().trim();

  const filtered = appState.products.filter(p => {
    if (!p.active) return false;
    const matchCat = selectedCategory === 'TODOS' || p.category === selectedCategory;
    const matchSearch = !query || p.name.toLowerCase().includes(query) || p.category.toLowerCase().includes(query);
    return matchCat && matchSearch;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">No se encontraron productos en esta categoría.</div>`;
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const inCartQty = getCartQtyForProduct(p.id);
    const remainingAfterCart = p.trackStock ? Math.max(0, p.stock - inCartQty) : Infinity;
    const isOut = p.trackStock && p.stock <= 0;
    const canAddMore = !p.trackStock || remainingAfterCart > 0;

    let badgeHtml = '';
    if (!p.trackStock) {
      badgeHtml = `<span class="stock-badge free">♾️ Disponible</span>`;
    } else if (p.stock <= 0) {
      badgeHtml = `<span class="stock-badge Empty">⛔ AGOTADO (0)</span>`;
    } else if (p.stock <= 5) {
      badgeHtml = `<span class="stock-badge Low">⚠️ Quedan: ${p.stock}</span>`;
    } else {
      badgeHtml = `<span class="stock-badge Plenty">✅ Quedan: ${p.stock}</span>`;
    }

    return `
      <div
        class="product-card ${inCartQty > 0 ? 'in-cart' : ''} ${isOut ? 'out-of-stock' : ''}"
        onclick="${canAddMore && inCartQty === 0 ? `addToCart('${p.id}')` : ''}"
      >
        <div class="prod-info-col">
          <div class="prod-name">${escapeHtml(p.name)}</div>
          <div class="prod-meta-row">
            ${p.price ? `<span style="font-weight:900; color:var(--miski-gold); font-size:0.86rem; margin-right:4px;">$${Number(p.price).toLocaleString('es-CO')}</span>` : ''}
            ${badgeHtml}
            <span class="prod-cat-tag">· ${escapeHtml(p.category)}</span>
          </div>
        </div>

        <div class="prod-action-col">
          ${
            inCartQty > 0
              ? `
                <div class="inline-qty-bar" onclick="event.stopPropagation()">
                  <button type="button" class="inline-qty-btn" onclick="removeOneFromCart('${p.id}')">−</button>
                  <span class="inline-qty-val">${inCartQty}</span>
                  <button type="button" class="inline-qty-btn" ${!canAddMore ? 'disabled style="opacity:0.4"' : ''} onclick="addToCart('${p.id}')">+</button>
                </div>
              `
              : `
                <button
                  type="button"
                  class="btn-add-prod"
                  ${!canAddMore ? 'disabled' : ''}
                  onclick="event.stopPropagation(); addToCart('${p.id}')"
                >
                  ${isOut ? 'Agotado' : '+ Agregar'}
                </button>
              `
          }
        </div>
      </div>
    `;
  }).join('');
}

function removeOneFromCart(productId) {
  const idx = cart.findIndex(item => item.productId === productId);
  if (idx === -1) return;
  changeCartQty(idx, -1);
}

function addToCart(productId) {
  const product = appState.products.find(p => p.id === productId);
  if (!product) return;

  const currentQty = getCartQtyForProduct(productId);
  if (product.trackStock && currentQty >= product.stock) {
    showToast(`⚠️ Solo quedan ${product.stock} unidades de "${product.name}"`);
    return;
  }

  const existing = cart.find(item => item.productId === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      productId: product.id,
      name: product.name,
      price: Number(product.price) || 0,
      quantity: 1,
      note: ''
    });
  }

  renderWaiterProducts();
  renderCart();
}

function changeCartQty(index, delta) {
  const item = cart[index];
  if (!item) return;

  const product = appState.products.find(p => p.id === item.productId);
  const nextQty = item.quantity + delta;

  if (nextQty <= 0) {
    cart.splice(index, 1);
  } else {
    if (product && product.trackStock && nextQty > product.stock) {
      showToast(`⚠️ Solo quedan ${product.stock} disponibles de "${product.name}"`);
      return;
    }
    item.quantity = nextQty;
  }

  renderWaiterProducts();
  renderCart();
}

function updateCartItemNote(index, val) {
  if (cart[index]) {
    cart[index].note = val;
  }
}

function appendQuickNote(index, noteText) {
  if (!cart[index]) return;
  const current = cart[index].note.trim();
  if (current.toLowerCase().includes(noteText.toLowerCase())) return;
  cart[index].note = current ? `${current}, ${noteText}` : noteText;
  renderCart();
}

function clearCart() {
  cart = [];
  const genNote = document.getElementById('generalOrderNote');
  if (genNote) genNote.value = '';
  renderWaiterProducts();
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cartItemsContainer');
  const sendBtn = document.getElementById('btnSendOrder');
  const mobileBar = document.getElementById('mobileCartBar');
  const mobileText = document.getElementById('mobileCartText');

  if (!container) return;

  const totalItems = cart.reduce((acc, i) => acc + i.quantity, 0);

  if (cart.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:26px 12px;">
        Todavía no has seleccionado platos.<br/>
        <small>Toca cualquier producto del menú para agregarlo.</small>
      </div>
    `;
    sendBtn.disabled = true;
    mobileBar.classList.remove('visible');
    return;
  }

  const totalMoney = cart.reduce((acc, i) => acc + (Number(i.price || 0) * i.quantity), 0);
  const totalFormatted = totalMoney > 0 ? `$${totalMoney.toLocaleString('es-CO')}` : '';

  sendBtn.disabled = false;
  sendBtn.innerHTML = `🚀 ENVIAR PEDIDO A COCINA ${totalFormatted ? `(${totalFormatted})` : ''}`;
  mobileBar.classList.add('visible');
  mobileText.textContent = `🛒 ${totalItems} plato(s) ${totalFormatted ? `· ${totalFormatted}` : ''} para ${selectedTable}`;

  container.innerHTML = cart.map((item, idx) => `
    <div class="cart-item">
      <div class="cart-item-top">
        <div>
          <span class="cart-item-title">${escapeHtml(item.name)}</span>
          ${item.price ? `<div style="font-size:0.75rem; color:var(--miski-gold); font-weight:800;">$${Number(item.price).toLocaleString('es-CO')} c/u ${item.quantity > 1 ? `· Subtotal: $${(item.price * item.quantity).toLocaleString('es-CO')}` : ''}</div>` : ''}
        </div>
        <div class="qty-controls">
          <button type="button" class="qty-btn" onclick="changeCartQty(${idx}, -1)">−</button>
          <span class="qty-num">${item.quantity}</span>
          <button type="button" class="qty-btn" onclick="changeCartQty(${idx}, 1)">+</button>
        </div>
      </div>

      <input
        type="text"
        class="cart-item-note"
        placeholder="Nota de cocina (ej. sin cebolla, término medio)..."
        value="${escapeHtml(item.note)}"
        oninput="updateCartItemNote(${idx}, this.value)"
      />

      <div class="quick-notes">
        ${QUICK_NOTES.map(qn => `
          <button type="button" class="quick-note-chip" onclick="appendQuickNote(${idx}, '${qn}')">
            + ${qn}
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function scrollToCart() {
  const el = document.getElementById('cartSection');
  if (el) el.scrollIntoView({ behavior: 'smooth' });
}

async function submitOrderToKitchen() {
  if (cart.length === 0) return;

  const sendBtn = document.getElementById('btnSendOrder');
  const generalNote = document.getElementById('generalOrderNote')?.value || '';

  sendBtn.disabled = true;
  sendBtn.textContent = '⏳ Enviando a Cocina...';

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: selectedTable,
        generalNote,
        items: cart
      })
    });

    const data = await res.json();
    if (!data.ok) {
      showToast(`❌ ${data.error || 'No se pudo enviar el pedido'}`);
      sendBtn.disabled = false;
      sendBtn.textContent = '🚀 ENVIAR PEDIDO A COCINA';
      return;
    }

    clearCart();
    if (data.state) handleIncomingState(data.state, 'LOCAL_SUBMIT');
    showToast(`✅ ¡Pedido #${data.order.orderNumber} (${data.order.table}) enviado a Cocina!`);
  } catch (err) {
    showToast('❌ Error de red al enviar el pedido');
  } finally {
    sendBtn.textContent = '🚀 ENVIAR PEDIDO A COCINA';
    renderCart();
  }
}

function renderWaiterActiveOrders() {
  const list = document.getElementById('waiterActiveOrdersList');
  const readyBanners = document.getElementById('waiterReadyBanners');
  if (!list) return;

  const readyToPick = appState.orders.filter(o => o.status === 'listo');
  const active = appState.orders.filter(
    o => o.status === 'pendiente' || o.status === 'preparando' || o.status === 'listo'
  );
  const delivered = appState.orders.filter(o => o.status === 'entregado').slice(0, 8);

  // Mostrar Banner Verde Grande arriba en el celular del Mesero cuando hay pedidos listos para recoger
  if (readyBanners) {
    if (readyToPick.length > 0) {
      readyBanners.innerHTML = readyToPick.map(o => `
        <div class="ready-pickup-banner">
          <div>
            <div style="font-size:1.05rem; font-weight:900;">
              🔔 ¡PEDIDO #${o.orderNumber} (${escapeHtml(o.table)}) LISTO EN COCINA!
            </div>
            <div style="font-size:0.86rem; opacity:0.95; margin-top:2px;">
              Ve por: ${o.items.map(i => `<b>${i.quantity}x</b> ${escapeHtml(i.name)}`).join(' · ')}
            </div>
          </div>
          <button
            type="button"
            class="btn-icon"
            style="background:#fff; color:#059669; font-weight:900; border:none; padding:10px 14px; white-space:nowrap;"
            onclick="updateOrderStatus('${o.id}', 'entregado')"
          >
            ✅ Ya lo recogí / Entregado
          </button>
        </div>
      `).join('');
    } else {
      readyBanners.innerHTML = '';
    }
  }

  let html = '';

  if (active.length === 0) {
    html += `<div style="color:var(--text-muted); font-size:0.86rem; padding:8px 0;">No hay pedidos pendientes en cocina en este momento.</div>`;
  } else {
    html += active.map(o => {
      const doneCount = o.items.filter(i => i.done).length;
      const totalCount = o.items.length;
      const progressText = doneCount > 0 ? ` (${doneCount}/${totalCount} listos)` : '';

      let statusBadge = '';
      if (o.status === 'listo') {
        statusBadge = `
          <div style="display:flex; align-items:center; gap:6px;">
            <span class="stock-badge Plenty">🔔 ¡LISTO PARA RECOGER!</span>
            <button class="btn-icon" style="background:var(--success); color:#fff; border:none; padding:6px 10px;" onclick="updateOrderStatus('${o.id}', 'entregado')">
              ✅ Entregado
            </button>
          </div>
        `;
      } else if (o.status === 'preparando') {
        statusBadge = `<span class="stock-badge free">👨‍🍳 Preparando${progressText}</span>`;
      } else {
        statusBadge = `<span class="stock-badge Low">⏳ En Cocina${progressText}</span>`;
      }

      return `
        <div style="background:var(--bg-dark); border:1px solid ${o.status === 'listo' ? '#22c55e' : 'var(--border)'}; border-radius:10px; padding:10px 12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:800; font-size:0.95rem;">
              #${o.orderNumber} — ${escapeHtml(o.table)}
              <span style="color:var(--text-muted); font-weight:500; font-size:0.8rem; margin-left:6px;">(${formatElapsed(o.createdAt)})</span>
            </div>
            <div style="font-size:0.83rem; color:var(--text-muted); margin-top:3px;">
              ${o.items.map(i => `${i.done || o.status === 'listo' ? '✅' : '⬜'} <b>${i.quantity}x</b> ${escapeHtml(i.name)}`).join(' · ')}
            </div>
          </div>
          ${statusBadge}
        </div>
      `;
    }).join('');
  }

  if (delivered.length > 0) {
    html += `
      <div class="section-label" style="margin-top:16px; margin-bottom:8px;">
        <span>✅ Últimos Pedidos Finalizados y Entregados</span>
        <span style="color:#34d399;">${delivered.length} completados</span>
      </div>
      ${delivered.map(o => `
        <div style="background:rgba(16, 185, 129, 0.08); border:1px solid rgba(16, 185, 129, 0.35); border-radius:10px; padding:9px 12px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div>
            <div style="font-weight:800; font-size:0.92rem; color:#ecfdf5;">
              #${o.orderNumber} — ${escapeHtml(o.table)}
              <span style="color:#34d399; font-weight:600; font-size:0.78rem; margin-left:6px;">Entregado a las ${formatTime(o.deliveredAt)}</span>
            </div>
            <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">
              ${o.items.map(i => `✅ <b>${i.quantity}x</b> ${escapeHtml(i.name)}`).join(' · ')}
            </div>
          </div>
          <span class="stock-badge Plenty">✅ ENTREGADO</span>
        </div>
      `).join('')}
    `;
  }

  list.innerHTML = html;
}

// =========================================================
// 2. LÓGICA DE COCINA (PANTALLA KDS Y FINALIZAR PEDIDO)
// =========================================================
function setKitchenFilter(filter) {
  kitchenFilter = filter;
  document.getElementById('kFilterActive').classList.toggle('active', filter === 'active');
  document.getElementById('kFilterDone').classList.toggle('active', filter === 'done');
  renderKitchenOrders();
}

function renderKitchenOrders() {
  const grid = document.getElementById('kitchenOrdersGrid');
  if (!grid) return;

  let ordersToShow = [];
  if (kitchenFilter === 'active') {
    // Mostrar los más antiguos primero para despachar en orden de llegada
    ordersToShow = appState.orders
      .filter(o => o.status === 'pendiente' || o.status === 'preparando' || o.status === 'listo')
      .slice()
      .reverse();
  } else {
    ordersToShow = appState.orders.filter(o => o.status === 'entregado');
  }

  if (ordersToShow.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <div style="font-size:2.2rem; margin-bottom:8px;">👨‍🍳</div>
        <div style="font-weight:800; font-size:1.05rem; color:var(--text-main);">
          ${kitchenFilter === 'active' ? '¡Todo al día! No hay pedidos pendientes en cocina.' : 'Aún no hay pedidos finalizados hoy.'}
        </div>
        <div style="font-size:0.85rem; margin-top:4px;">
          Cuando un mesero envíe un pedido, aparecerá aquí al instante con sonido de alerta.
        </div>
      </div>
    `;
    return;
  }

  grid.innerHTML = ordersToShow.map(order => {
    const isPending = order.status === 'pendiente';
    const isPrep = order.status === 'preparando';
    const isReady = order.status === 'listo';
    const isDone = order.status === 'entregado';

    return `
      <div class="order-card status-${order.status}">
        <div>
          <div class="order-header">
            <div>
              <div class="order-table-title">#${order.orderNumber} · ${escapeHtml(order.table)}</div>
              <div class="order-meta">
                Hora: ${formatTime(order.createdAt)}
                ${isPrep ? ' · <b style="color:#60a5fa;">👨‍🍳 PREPARANDO</b>' : ''}
                ${isReady ? ' · <b style="color:#4ade80;">🔔 ESPERANDO AL MESERO</b>' : ''}
                ${isDone ? ` · <b style="color:#34d399;">✅ ENTREGADO (${formatTime(order.deliveredAt)})</b>` : ''}
              </div>
            </div>
            <div class="order-timer">${formatElapsed(order.createdAt)}</div>
          </div>

          <div class="order-body">
            ${
              order.generalNote
                ? `<div class="order-general-note">⚠️ NOTA: ${escapeHtml(order.generalNote)}</div>`
                : ''
            }

            <ul class="order-items-list">
              ${order.items.map(item => `
                <li
                  class="kitchen-item ${item.done ? 'item-done' : ''}"
                  onclick="toggleKitchenItem('${order.id}', '${item.itemId}')"
                  title="Toca para marcar plato como listo"
                >
                  <div class="k-item-row">
                    <span class="k-item-qty">${item.quantity}</span>
                    <span class="k-item-name">${escapeHtml(item.name)}</span>
                    <span class="k-item-check">${item.done ? '✅' : '⬜'}</span>
                  </div>
                  ${
                    item.note
                      ? `<div class="k-item-note">📝 ${escapeHtml(item.note)}</div>`
                      : ''
                  }
                </li>
              `).join('')}
            </ul>
          </div>
        </div>

        <div class="order-actions" style="flex-wrap:wrap;">
          ${
            !isDone
              ? `
                ${
                  isPending
                    ? `<button class="btn-k-action btn-k-prep" onclick="updateOrderStatus('${order.id}', 'preparando')">
                         👨‍🍳 Preparando
                       </button>`
                    : ''
                }
                ${
                  !isReady
                    ? `<button class="btn-k-action" style="background:#f59e0b; color:#fff;" onclick="updateOrderStatus('${order.id}', 'listo')">
                         🔔 ¡Listo! Llamar Mesero
                       </button>`
                    : ''
                }
                <button class="btn-k-action btn-k-finish" onclick="updateOrderStatus('${order.id}', 'entregado')">
                  ✅ Entregado
                </button>
                <button class="btn-k-action btn-k-cancel" onclick="cancelOrderPrompt('${order.id}', ${order.orderNumber})" title="Cancelar pedido y devolver stock">
                  🗑️
                </button>
              `
              : `
                <button class="btn-k-action btn-k-prep" onclick="updateOrderStatus('${order.id}', 'preparando')">
                  ↩️ Reabrir a Cocina
                </button>
              `
          }
        </div>
      </div>
    `;
  }).join('');
}

async function toggleKitchenItem(orderId, itemId) {
  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toggleItemId: itemId })
    });
    const data = await res.json();
    if (data.ok && data.state) {
      handleIncomingState(data.state, 'LOCAL_ITEM_TOGGLE');
    }
  } catch (e) {
    showToast('❌ Error al actualizar plato');
  }
}

async function updateOrderStatus(orderId, nextStatus) {
  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus })
    });
    const data = await res.json();
    if (data.ok && data.state) {
      handleIncomingState(data.state, 'LOCAL_STATUS');
      if (nextStatus === 'entregado') {
        showToast(`✅ Pedido #${data.order.orderNumber} (${data.order.table}) finalizado y entregado`);
      }
    }
  } catch (e) {
    showToast('❌ Error al cambiar estado del pedido');
  }
}

function cancelOrderPrompt(orderId, orderNumber) {
  if (confirm(`¿Seguro que deseas cancelar el Pedido #${orderNumber}? Las cantidades se devolverán al stock automáticamente.`)) {
    updateOrderStatus(orderId, 'cancelado');
  }
}

// Actualizar cronómetros de cocina cada 15 segundos
setInterval(() => {
  if (currentView === 'kitchen' || currentView === 'waiter') {
    renderKitchenOrders();
    renderWaiterActiveOrders();
  }
}, 15000);

// =========================================================
// 3. LÓGICA DE CONTROL DE STOCK Y MENÚ (INICIO Y MEDIA JORNADA)
// =========================================================
function renderStockManager() {
  const container = document.getElementById('stockProductsList');
  if (!container) return;

  if (appState.products.length === 0) {
    container.innerHTML = `<div class="empty-state">No hay platos registrados. Agrega el primero en el formulario.</div>`;
    return;
  }

  container.innerHTML = appState.products.map(p => {
    let statusBadge = '';
    if (!p.trackStock) {
      statusBadge = `<span class="stock-badge free">♾️ Sin límite (Opcional)</span>`;
    } else if (p.stock <= 0) {
      statusBadge = `<span class="stock-badge Empty">⛔ AGOTADO (0)</span>`;
    } else if (p.stock <= 5) {
      statusBadge = `<span class="stock-badge Low">⚠️ Quedan: ${p.stock}</span>`;
    } else {
      statusBadge = `<span class="stock-badge Plenty">✅ Quedan: ${p.stock}</span>`;
    }

    return `
      <div class="stock-row">
        <div class="stock-row-info">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span class="stock-row-title">${escapeHtml(p.name)}</span>
            ${statusBadge}
          </div>
          <div class="prod-cat-tag">${escapeHtml(p.category)}</div>
        </div>

        <div class="stock-controls-group">
          <button
            type="button"
            class="toggle-mode-btn ${p.trackStock ? 'tracked' : ''}"
            onclick="toggleProductStockMode('${p.id}', ${!p.trackStock})"
            title="Activar o desactivar límite de cantidad para hoy"
          >
            ${p.trackStock ? '🔢 Con Cantidad' : '♾️ Libre (Activar Cantidad)'}
          </button>

          ${
            p.trackStock
              ? `
                <div class="quick-stock-btns">
                  <button type="button" class="btn-stock-adj minus" onclick="adjustProductStock('${p.id}', -1)">-1</button>
                  <input
                    type="number"
                    class="stock-Direct-input"
                    value="${p.stock}"
                    min="0"
                    onchange="setExactProductStock('${p.id}', this.value)"
                    title="Escribe la cantidad exacta disponible"
                  />
                  <button type="button" class="btn-stock-adj plus" onclick="adjustProductStock('${p.id}', 1)">+1</button>
                  <button type="button" class="btn-stock-adj plus" onclick="adjustProductStock('${p.id}', 5)">+5</button>
                  <button type="button" class="btn-stock-adj plus" onclick="adjustProductStock('${p.id}', 10)">+10</button>
                </div>
              `
              : ''
          }

          <button
            type="button"
            class="btn-icon"
            style="border-color:var(--border);"
            onclick="editProductPrompt('${p.id}')"
            title="Editar nombre o categoría"
          >
            ✏️
          </button>

          <button
            type="button"
            class="btn-icon"
            style="color:var(--danger); border-color:transparent; background:rgba(239,68,68,0.1);"
            onclick="deleteProductPrompt('${p.id}', '${escapeHtml(p.name)}')"
            title="Eliminar plato del menú"
          >
            🗑️
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function editProductPrompt(prodId) {
  const product = appState.products.find(p => p.id === prodId);
  if (!product) return;

  const newName = prompt('Editar nombre del plato:', product.name);
  if (newName === null || !newName.trim()) return;

  const newCat = prompt('Categoría del plato:', product.category);
  if (newCat === null || !newCat.trim()) return;

  try {
    const res = await fetch(`/api/products/${prodId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), category: newCat.trim() })
    });
    const data = await res.json();
    if (data.ok && data.state) {
      handleIncomingState(data.state, 'PROD_EDIT');
      showToast(`✏️ Plato actualizado a "${data.product.name}"`);
    }
  } catch (e) {
    showToast('❌ Error al editar plato');
  }
}

async function handleBulkAddProducts() {
  const txtEl = document.getElementById('bulkProductsText');
  const catEl = document.getElementById('bulkDefaultCategory');
  const raw = (txtEl?.value || '').trim();
  const defaultCategory = (catEl?.value || 'Platos Fuertes').trim();

  if (!raw) {
    showToast('⚠️ Escribe o pega al menos un plato en la lista');
    return;
  }

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const bulkItems = lines.map(line => {
    // Soporta formato "Nombre del plato, 20" o "Nombre del plato"
    const parts = line.split(',');
    if (parts.length >= 2) {
      const maybeQty = parseInt(parts[parts.length - 1].trim(), 10);
      if (!isNaN(maybeQty)) {
        const name = parts.slice(0, -1).join(',').trim();
        return { name, category: defaultCategory, trackStock: true, stock: maybeQty };
      }
    }
    return { name: line, category: defaultCategory, trackStock: false, stock: 0 };
  });

  try {
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bulkItems })
    });
    const data = await res.json();
    if (data.ok && data.state) {
      txtEl.value = '';
      handleIncomingState(data.state, 'BULK_ADD');
      showToast(`⚡ ¡${data.added.length} platos agregados al menú!`);
    }
  } catch (e) {
    showToast('❌ Error al cargar la lista de platos');
  }
}

async function clearAllMenuPrompt() {
  if (!confirm('¿Borrar todos los platos actuales para cargar un menú limpio desde cero?')) return;
  try {
    const res = await fetch('/api/clear-menu', { method: 'POST' });
    const data = await res.json();
    if (data.ok && data.state) {
      handleIncomingState(data.state, 'CLEAR_MENU');
      showToast('🗑️ Menú vaciado. Listo para agregar los nuevos platos.');
    }
  } catch (e) {
    showToast('❌ Error al vaciar el menú');
  }
}

async function toggleProductStockMode(prodId, enableTrack) {
  const product = appState.products.find(p => p.id === prodId);
  const initialStock = enableTrack && product && product.stock === 0 ? 20 : (product ? product.stock : 0);

  try {
    const res = await fetch(`/api/products/${prodId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackStock: enableTrack, stock: initialStock })
    });
    const data = await res.json();
    if (data.ok && data.state) {
      handleIncomingState(data.state, 'STOCK_MODE');
      showToast(
        enableTrack
          ? `🔢 Control de cantidad activado para "${data.product.name}"`
          : `♾️ "${data.product.name}" ahora tiene venta libre sin límite`
      );
    }
  } catch (e) {
    showToast('❌ Error actualizando modo de stock');
  }
}

async function adjustProductStock(prodId, delta) {
  try {
    const res = await fetch(`/api/products/${prodId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adjustStock: delta })
    });
    const data = await res.json();
    if (data.ok && data.state) {
      handleIncomingState(data.state, 'STOCK_ADJ');
    }
  } catch (e) {
    showToast('❌ Error al ajustar stock');
  }
}

async function setExactProductStock(prodId, val) {
  const num = Math.max(0, parseInt(val, 10) || 0);
  try {
    const res = await fetch(`/api/products/${prodId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stock: num, trackStock: true })
    });
    const data = await res.json();
    if (data.ok && data.state) {
      handleIncomingState(data.state, 'STOCK_SET');
      showToast(`📦 Stock de "${data.product.name}" actualizado a ${data.product.stock}`);
    }
  } catch (e) {
    showToast('❌ Error al guardar cantidad');
  }
}

async function handleAddProduct(e) {
  e.preventDefault();
  const nameInput = document.getElementById('newProdName');
  const catInput = document.getElementById('newProdCategory');
  const trackInput = document.getElementById('newProdTrackStock');
  const stockInput = document.getElementById('newProdStock');

  const name = nameInput.value.trim();
  const category = catInput.value.trim() || 'General';
  const trackStock = trackInput.checked;
  const stock = parseInt(stockInput.value, 10) || 0;

  if (!name) return;

  try {
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category, trackStock, stock })
    });
    const data = await res.json();
    if (data.ok && data.state) {
      nameInput.value = '';
      handleIncomingState(data.state, 'PROD_ADD');
      showToast(`✅ "${data.product.name}" agregado al menú`);
    }
  } catch (err) {
    showToast('❌ No se pudo agregar el producto');
  }
}

async function deleteProductPrompt(prodId, prodName) {
  if (!confirm(`¿Eliminar "${prodName}" del menú?`)) return;
  try {
    const res = await fetch(`/api/products/${prodId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok && data.state) {
      handleIncomingState(data.state, 'PROD_DEL');
      showToast(`🗑️ "${prodName}" eliminado del menú`);
    }
  } catch (e) {
    showToast('❌ Error al eliminar producto');
  }
}

async function resetShiftOrders() {
  if (!confirm('¿Iniciar nueva jornada? Se limpiará el historial de pedidos entregados y el contador volverá a #1 (tu menú se mantiene intacto).')) {
    return;
  }
  try {
    const res = await fetch('/api/reset-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onlyFinished: false })
    });
    const data = await res.json();
    if (data.ok && data.state) {
      handleIncomingState(data.state, 'RESET');
      showToast('🌅 ¡Nueva jornada iniciada!');
    }
  } catch (e) {
    showToast('❌ Error al reiniciar jornada');
  }
}

// =========================================================
// MODAL DE CONEXIÓN PARA TELÉFONOS Y PC (CON WHATSAPP Y QR)
// =========================================================
function openConnectModal() {
  const modal = document.getElementById('connectModal');
  const container = document.getElementById('networkLinksContainer');
  modal.classList.add('open');

  const currentOrigin = window.location.origin;
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const ips = appState.network?.ips || [];

  // Elegir la mejor URL para compartir con otros dispositivos
  let shareUrls = [];
  if (!isLocalhost) {
    // Si ya están entrando desde un link en la nube o desde una IP en el celular
    shareUrls.push({ label: 'Enlace Directo (Cualquier Red / Internet)', url: currentOrigin });
  } else if (ips.length > 0) {
    ips.forEach(ip => {
      shareUrls.push({ label: `Red Wi-Fi Local (${ip.name})`, url: ip.url });
    });
  } else {
    shareUrls.push({ label: 'Enlace en este dispositivo', url: currentOrigin });
  }

  container.innerHTML = shareUrls.map(item => {
    const waText = encodeURIComponent(`🍽️ *Miski App - Toma de Pedidos y Cocina*\nEntra aquí desde tu celular:\n👉 ${item.url}`);
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(item.url)}`;

    return `
      <div style="background:var(--bg-dark); border:1.5px solid var(--primary); padding:14px; border-radius:12px; display:flex; flex-direction:column; gap:10px;">
        <div>
          <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700;">${escapeHtml(item.label)}</div>
          <div style="font-size:1.05rem; font-weight:900; color:#fff; word-break:break-all; user-select:all; margin-top:2px;">
            ${escapeHtml(item.url)}
          </div>
        </div>

        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn-icon" style="flex:1; justify-content:center; background:var(--primary); color:#fff; border:none;" onclick="copyText('${escapeHtml(item.url)}')">
            📋 Copiar Link
          </button>
          <a
            href="https://wa.me/?text=${waText}"
            target="_blank"
            rel="noopener"
            class="btn-icon"
            style="flex:1; justify-content:center; background:#16a34a; color:#fff; border:none; text-decoration:none;"
          >
            💬 Enviar por WhatsApp
          </a>
        </div>

        <div style="text-align:center; background:#fff; padding:10px; border-radius:10px; width:fit-content; margin:4px auto 0;">
          <img
            src="${qrApiUrl}"
            alt="Código QR"
            width="150"
            height="150"
            style="display:block;"
            onerror="this.parentElement.style.display='none'"
          />
          <div style="color:#0f172a; font-size:0.72rem; font-weight:800; margin-top:4px;">Escanear con cámara</div>
        </div>
      </div>
    `;
  }).join('');
}

function closeConnectModal() {
  document.getElementById('connectModal').classList.remove('open');
}

function copyText(txt) {
  navigator.clipboard?.writeText(txt);
  showToast(`📋 Enlace copiado: ${txt}`);
}

// =========================================================
// UTILIDADES
// =========================================================
function showToast(msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3600);
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatElapsed(isoStr) {
  if (!isoStr) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000));
  if (diffSec < 60) return 'Hace instantes';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `Hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  return `Hace ${hrs}h ${mins % 60}m`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =========================================================
// 4. LÓGICA DEL PANEL DE ADMINISTRADOR EXCLUSIVO
// =========================================================
function populateAdminInputs() {
  if (!adminConfigCache) return;
  const staffEl = document.getElementById('adminStaffPinInput');
  const masterEl = document.getElementById('adminMasterPinInput');
  const allowEl = document.getElementById('adminAllowMenuEdit');
  const lockEl = document.getElementById('adminLockSystem');

  if (staffEl) staffEl.value = adminConfigCache.staffPin || '1234';
  if (masterEl) masterEl.value = adminConfigCache.adminPin || '9999';
  if (allowEl) allowEl.checked = adminConfigCache.allowStaffMenuEdit !== false;
  if (lockEl) lockEl.checked = Boolean(adminConfigCache.systemLocked);
}

async function saveAdminSecurity(e) {
  if (e) e.preventDefault();
  const newStaffPin = document.getElementById('adminStaffPinInput')?.value.trim();
  const newAdminPin = document.getElementById('adminMasterPinInput')?.value.trim();
  const allowStaffMenuEdit = document.getElementById('adminAllowMenuEdit')?.checked;
  const systemLocked = document.getElementById('adminLockSystem')?.checked;

  try {
    const res = await fetch('/api/admin/security', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentAdminPin: savedAdminPin || '9999',
        newStaffPin,
        newAdminPin,
        allowStaffMenuEdit,
        systemLocked
      })
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(`❌ ${data.error || 'Error guardando seguridad'}`);
      return;
    }

    savedAdminPin = newAdminPin;
    localStorage.setItem('miski_admin_pin', savedAdminPin);
    adminConfigCache = data.adminConfig;
    if (data.state) handleIncomingState(data.state, 'ADMIN_SEC');
    showToast('✅ Configuración de seguridad y accesos actualizada');
  } catch (err) {
    showToast('❌ Error de red al guardar seguridad');
  }
}

async function revokeAllDevicesNow() {
  if (!confirm('¿Expulsar inmediatamente a todos los teléfonos conectados? Tendrán que volver a ingresar el PIN para entrar.')) {
    return;
  }
  try {
    const res = await fetch('/api/admin/security', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentAdminPin: savedAdminPin || '9999',
        revokeAllSessions: true
      })
    });
    const data = await res.json();
    if (data.ok) {
      if (data.state) handleIncomingState(data.state, 'ADMIN_REVOKE');
      showToast('🚫 Todos los dispositivos han sido cerrados. Se requiere PIN nuevamente.');
    }
  } catch (err) {
    showToast('❌ Error al expulsar dispositivos');
  }
}

function renderAdminPanel() {
  if (currentRole !== 'admin') return;

  const statsEl = document.getElementById('adminSummaryStats');
  const reportEl = document.getElementById('adminDishesReport');
  if (!statsEl || !reportEl) return;

  const totalOrders = appState.orders.length;
  const deliveredOrders = appState.orders.filter(o => o.status === 'entregado').length;
  const activeOrders = appState.orders.filter(o => o.status === 'pendiente' || o.status === 'preparando').length;
  const cancelledOrders = appState.orders.filter(o => o.status === 'cancelado').length;

  statsEl.innerHTML = `
    <div style="background:var(--bg-dark); padding:12px 14px; border-radius:10px; border:1px solid var(--border); display:flex; justify-content:space-between;">
      <span style="color:var(--text-muted);">Total Pedidos Hoy:</span>
      <b style="font-size:1.1rem;">${totalOrders}</b>
    </div>
    <div style="background:var(--bg-dark); padding:12px 14px; border-radius:10px; border:1px solid var(--border); display:flex; justify-content:space-between;">
      <span style="color:var(--text-muted);">✅ Entregados por Cocina:</span>
      <b style="font-size:1.1rem; color:#34d399;">${deliveredOrders}</b>
    </div>
    <div style="background:var(--bg-dark); padding:12px 14px; border-radius:10px; border:1px solid var(--border); display:flex; justify-content:space-between;">
      <span style="color:var(--text-muted);">🔥 En Curso Ahora:</span>
      <b style="font-size:1.1rem; color:#fbbf24;">${activeOrders}</b>
    </div>
    <div style="background:var(--bg-dark); padding:12px 14px; border-radius:10px; border:1px solid var(--border); display:flex; justify-content:space-between;">
      <span style="color:var(--text-muted);">🗑️ Cancelados:</span>
      <b style="font-size:1.1rem; color:#f87171;">${cancelledOrders}</b>
    </div>
  `;

  // Calcular conteo por plato (excluyendo cancelados)
  const countsMap = {};
  appState.orders
    .filter(o => o.status !== 'cancelado')
    .forEach(order => {
      order.items.forEach(item => {
        countsMap[item.name] = (countsMap[item.name] || 0) + Number(item.quantity || 1);
      });
    });

  const sortedDishes = Object.entries(countsMap).sort((a, b) => b[1] - a[1]);

  if (sortedDishes.length === 0) {
    reportEl.innerHTML = `<div style="color:var(--text-muted); font-size:0.88rem; padding:10px 0;">Aún no se han registrado platos vendidos en esta jornada.</div>`;
  } else {
    reportEl.innerHTML = sortedDishes.map(([dishName, qty]) => `
      <div style="background:var(--bg-dark); border:1px solid var(--border); padding:10px 14px; border-radius:10px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:700;">${escapeHtml(dishName)}</span>
        <span class="stock-badge Plenty" style="font-size:0.9rem;">${qty} despachados</span>
      </div>
    `).join('');
  }
}

function saveFirebaseCloudUrl() {
  const input = document.getElementById('firebaseDbUrlInput');
  const val = (input?.value || '').trim().replace(/\/+$/, '');
  window.MISKI_FIREBASE_DB_URL = val;
  if (val) {
    localStorage.setItem('miski_firebase_db_url', val);
    showToast('☁️ ¡Conectado a Google Firebase 24/7!');
    connectRealtime();
  } else {
    localStorage.removeItem('miski_firebase_db_url');
    showToast('💻 Usando modo servidor local');
  }
}

// =========================================================
// INSTALACIÓN DE APP EN CELULARES (PWA / WEBAPK) Y DETECCIÓN DE MODO ESCRITORIO
// =========================================================
let deferredInstallPrompt = null;

function isInstalledStandaloneApp() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function checkMobileDesktopModeAndScale() {
  const smallPhysicalScreen = Math.min(window.screen.width || 1000, window.screen.height || 1000) <= 550;
  const isMobileUA = /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent || '');
  const isTouchPhone = navigator.maxTouchPoints > 0 && (smallPhysicalScreen || isMobileUA);

  const currentZoom = parseFloat(document.documentElement.style.zoom) || 1;
  const unzoomedWidth = Math.round(window.innerWidth * currentZoom);

  // Si es un teléfono físico pero Chrome tiene activado "Sitio para computadora" (ancho real > 680px)
  if (isTouchPhone && unzoomedWidth > 680) {
    document.body.classList.add('force-mobile');
    const targetWidth = 390;
    const scaleFactor = Math.max(1.8, Math.min(2.7, unzoomedWidth / targetWidth));
    if (Math.abs(currentZoom - scaleFactor) > 0.05) {
      document.documentElement.style.zoom = scaleFactor.toFixed(2);
    }
  } else if (!isTouchPhone || unzoomedWidth <= 680) {
    document.body.classList.remove('force-mobile');
    if (document.documentElement.style.zoom) {
      document.documentElement.style.zoom = '';
    }
  }

  // Ocultar botón de instalar si ya está dentro de la App instalada
  const installBtn = document.getElementById('installAppBtn');
  const authInstallBanner = document.getElementById('authInstallBanner');
  if (isInstalledStandaloneApp()) {
    if (installBtn) installBtn.style.display = 'none';
    if (authInstallBanner) authInstallBanner.style.display = 'none';
  } else {
    if (installBtn) installBtn.style.display = 'inline-flex';
    if (authInstallBanner) authInstallBanner.style.display = 'block';
  }
}

window.addEventListener('resize', checkMobileDesktopModeAndScale);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js?v=20').catch(() => {});
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const installBtn = document.getElementById('installAppBtn');
  if (installBtn && !isInstalledStandaloneApp()) {
    installBtn.style.display = 'inline-flex';
  }
});

async function installPWA() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      showToast('📲 ¡Instalando Miski App en tu teléfono!');
    }
    deferredInstallPrompt = null;
  } else {
    openInstallHelpModal();
  }
}

function openInstallHelpModal() {
  if (deferredInstallPrompt) {
    installPWA();
    return;
  }
  const modal = document.getElementById('installGuideModal');
  if (modal) modal.classList.add('open');
}

function closeInstallHelpModal() {
  const modal = document.getElementById('installGuideModal');
  if (modal) modal.classList.remove('open');
}

// Inicializar vista guardada y conectar
window.addEventListener('DOMContentLoaded', async () => {
  checkMobileDesktopModeAndScale();
  const params = new URLSearchParams(window.location.search);

  // Si abren localhost en la PC teniendo internet y no forzaron ?local=1, redirigir a la Nube oficial
  // para que la PC y los celulares vean exactamente los mismos pedidos siempre.
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (isLocal && navigator.onLine && !params.get('local')) {
    const cloudTarget = 'https://miski-app-pedidos.onrender.com' + window.location.search;
    window.location.replace(cloudTarget);
    return;
  }

  const autoDb = params.get('db');
  if (autoDb && autoDb.startsWith('https://')) {
    window.MISKI_FIREBASE_DB_URL = autoDb.trim().replace(/\/+$/, '');
    localStorage.setItem('miski_firebase_db_url', window.MISKI_FIREBASE_DB_URL);
  }
  const fbInput = document.getElementById('firebaseDbUrlInput');
  if (fbInput) fbInput.value = window.MISKI_FIREBASE_DB_URL || '';

  const autoPin = params.get('pin');
  if (autoPin) {
    const input = document.getElementById('pinLoginInput');
    if (input) input.value = autoPin;
    await handlePinLogin();
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (currentRole === 'admin' && savedAdminPin) {
    const input = document.getElementById('pinLoginInput');
    if (input) input.value = savedAdminPin;
    await handlePinLogin();
  }
  syncAuthUI();
  switchView(currentView);
  connectRealtime();
});
