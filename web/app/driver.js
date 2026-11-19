/* РУХ — driver web app: onboarding, online/offline, offers with timer,
 * order execution (incl. delivery codes), earnings, stats, quests, settings. */
import {
  $, api, dt, el, esc, guard, km, mins, money, money2, Realtime,
  STATUS_LABELS, STATUS_TONE, time, toast, token,
} from './api.js';
import { MapView } from './map.js';

const state = {
  user: null,
  profile: null,
  me: null,
  screen: 'loading',
  tab: 'work',
  offers: [],
  activeOrders: [],
  stats: null,
  earnings: null,
  transactions: [],
  reviews: [],
  cities: [],
  classes: [],
  map: null,
  rt: null,
  watchId: null,
  tick: null,
  offerTimers: {},
  order: null,
  geoError: '',
};

const screenEl = $('#screen');
const footerEl = $('#footer');
const tabbarEl = $('#tabbar');

/* ------------------------------------------------------------------- boot -- */
async function boot() {
  if (!token.get()) { state.screen = 'auth'; return render(); }
  try {
    await loadAll();
  } catch {
    token.clear();
    state.screen = 'auth';
  }
  render();
}

const loadAll = guard(async () => {
  state.me = await api.get('/api/me');
  state.user = state.me;
  state.cities = (await api.get('/api/cities')).items;
  state.classes = (await api.get('/api/catalog?cityId=city_kyiv')).classes;
  try {
    const driver = await api.get('/api/driver/me');
    state.me = { ...state.me, driver: driver.profile, vehicles: driver.vehicles, documents: driver.documents };
    state.profile = driver.profile;
    state.activeOrders = driver.activeOrders;
    if (['loading', 'auth', 'register'].includes(state.screen)) state.screen = 'work';
    connectRealtime();
    await Promise.all([loadOffers(), loadStats(), loadEarnings(), loadReviews()]);
    startLocation();
    startTicker();
  } catch (error) {
    if (error?.status === 404) state.screen = 'register';
    else throw error;
  }
});

function connectRealtime() {
  if (state.rt) return;
  state.rt = new Realtime(async (msg) => {
    if (msg.event === 'offer.new' || msg.event === 'order.offered') {
      beep();
      await loadOffers();
      if (state.screen === 'work') render();
    }
    if (msg.event === 'offer.expired') {
      await loadOffers();
      if (state.screen === 'work') render();
    }
    if (msg.event === 'order.updated' || msg.event === 'order.assigned') {
      const order = msg.payload;
      if (state.screen === 'order' && order?.id === state.order?.id) {
        state.order = order;
        render();
      } else {
        await refreshDriverState();
        if (state.screen === 'work') render();
      }
    }
    if (msg.event === 'wallet.updated' || msg.event === 'notification') {
      if (msg.event === 'notification') toast(`${msg.payload.title}${msg.payload.body ? ` · ${msg.payload.body}` : ''}`);
      loadEarnings();
    }
    if (msg.event === 'driver.location' && state.lastPosition) {
      state.map?.upsertMarker({ id: 'me', ...state.lastPosition, kind: 'driver', label: 'Я' });
    }
  });
  state.rt.connect();
}

/** Short beep for a new offer (WebAudio, no asset needed). */
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 220);
  } catch { /* audio is best-effort */ }
}

const refreshDriverState = guard(async () => {
  const driver = await api.get('/api/driver/me');
  state.profile = driver.profile;
  state.activeOrders = driver.activeOrders;
  state.me = { ...state.me, driver: driver.profile, vehicles: driver.vehicles, documents: driver.documents };
});

const loadOffers = guard(async () => {
  const res = await api.get('/api/driver/offers');
  state.offers = res.items;
  renderOffers();
});

const loadStats = guard(async () => {
  state.stats = await api.get('/api/driver/stats');
});

const loadEarnings = guard(async () => {
  state.earnings = await api.get('/api/driver/earnings?days=14');
  state.transactions = (await api.get('/api/driver/transactions')).items;
});

const loadReviews = guard(async () => {
  state.reviews = (await api.get('/api/driver/reviews')).items;
});

function startLocation() {
  if (state.watchId || !navigator.geolocation) return;
  state.watchId = navigator.geolocation.watchPosition(
    guard(async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      state.lastPosition = { lat, lng };
      state.geoError = '';
      await api.post('/api/driver/location', { lat, lng });
      state.map?.upsertMarker({ id: 'me', lat, lng, kind: 'driver', label: 'Я' });
    }),
    (err) => { state.geoError = err.message; renderGeoState(); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
  // fallback ping with the last known position so the driver stays visible
  setInterval(guard(async () => {
    if (state.lastPosition) await api.post('/api/driver/location', state.lastPosition);
  }), 20000);
}

function startTicker() {
  if (state.tick) return;
  state.tick = setInterval(guard(async () => {
    await loadOffers();
    if (state.screen === 'work' || state.screen === 'order') render();
  }), 4000);
}

function renderGeoState() {
  const node = $('#geoState');
  if (node) node.textContent = state.geoError ? `GPS: ${state.geoError}` : 'GPS активний';
}

/* ------------------------------------------------------------------- auth -- */
function renderAuth() {
  screenEl.innerHTML = `
    <div class="col" style="gap:14px;padding-top:10px">
      <h1>РУХ Водій</h1>
      <p class="muted">Онлайн-замовлення, авто-прийняття, виплати. Доступ до роботи — після перевірки документів.</p>
      <div class="card col">
        <div class="field"><label class="label">Телефон</label>
          <input class="input" id="phoneInput" value="+380671000101" inputmode="tel" /></div>
        <div class="field hide" id="codeField"><label class="label">Код</label>
          <input class="input" id="codeInput" inputmode="numeric" />
          <small class="muted" id="codeHint"></small></div>
        <button class="btn primary block" id="authBtn">Отримати код</button>
      </div>
      <div class="card col tight">
        <div class="label">Демо-вхід</div>
        <div class="row wrap">
          <button class="chip" data-phone="+380671000101">Іван (авто-прийняття)</button>
          <button class="chip" data-phone="+380671000102">Олександр</button>
          <button class="chip" data-phone="+380671000103">Марія</button>
          <button class="chip" data-phone="+380671000105">Сергій (доставка)</button>
        </div>
      </div>
    </div>`;
  tabbarEl.innerHTML = '';
  footerEl.classList.add('hide');

  let stage = 'phone';
  $('#authBtn').onclick = guard(async () => {
    const phone = $('#phoneInput').value.trim();
    if (stage === 'phone') {
      const res = await api.post('/api/auth/request-otp', { phone });
      stage = 'code';
      $('#codeField').classList.remove('hide');
      $('#codeInput').value = res.demoCode;
      $('#codeHint').textContent = `Демо-код: ${res.demoCode}`;
      $('#authBtn').textContent = 'Увійти';
      return;
    }
    const res = await api.post('/api/auth/verify-otp', { phone, code: $('#codeInput').value.trim() });
    token.set(res.token);
    await boot();
  });
  screenEl.querySelectorAll('[data-phone]').forEach((btn) => {
    btn.onclick = guard(async () => {
      const res = await api.post('/api/auth/demo-login', { role: 'driver', phone: btn.dataset.phone });
      token.set(res.token);
      await boot();
    });
  });
}

/* --------------------------------------------------------------- register -- */
function renderRegister() {
  footerEl.classList.add('hide');
  screenEl.innerHTML = `
    <h1>Реєстрація водія</h1>
    <div class="card col">
      <div class="field"><label class="label">Місто</label>
        <select class="select" id="regCity">
          ${state.cities.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select></div>
      <div class="field"><label class="label">Класи, які ви обслуговуєте</label>
        <div class="row wrap" id="regClasses">
          ${state.classes.filter((c) => c.kind === 'ride').map((c) => `<button class="chip" data-class="${c.code}">${esc(c.name)}</button>`).join('')}
        </div></div>
      <div class="row" style="gap:8px">
        <input class="input" id="regMake" placeholder="Марка" />
        <input class="input" id="regModel" placeholder="Модель" />
      </div>
      <div class="row" style="gap:8px">
        <input class="input" id="regYear" placeholder="Рік" inputmode="numeric" />
        <input class="input" id="regColor" placeholder="Колір" />
      </div>
      <input class="input" id="regPlate" placeholder="Держномер" />
      <div class="label">Документи (посилання на файли)</div>
      <input class="input" id="docLicense" placeholder="Посвідчення водія: URL" value="/uploads/license/new.jpg" />
      <input class="input" id="docRegistration" placeholder="Техпаспорт: URL" value="/uploads/reg/new.jpg" />
      <button class="btn primary" id="regSubmit">Надіслати на перевірку</button>
      <small class="muted">Після схвалення адміністратором ви зможете вийти на лінію.</small>
    </div>`;
  const chosen = new Set();
  screenEl.querySelectorAll('[data-class]').forEach((chip) => {
    chip.onclick = () => {
      const code = chip.dataset.class;
      if (chosen.has(code)) chosen.delete(code); else chosen.add(code);
      chip.classList.toggle('active');
    };
  });
  $('#regSubmit').onclick = guard(async () => {
    if (!chosen.size) return toast('Оберіть хоча б один клас', 'err');
    await api.post('/api/driver/register', {
      cityId: $('#regCity').value,
      classes: Array.from(chosen),
      vehicle: {
        make: $('#regMake').value.trim(), model: $('#regModel').value.trim(),
        year: Number($('#regYear').value) || null, color: $('#regColor').value.trim(),
        plate: $('#regPlate').value.trim(),
      },
      documents: [
        { type: 'license', fileUrl: $('#docLicense').value.trim() },
        { type: 'vehicle_registration', fileUrl: $('#docRegistration').value.trim() },
      ],
    });
    toast('Заявку надіслано на перевірку');
    await boot();
  });
  tabbarEl.innerHTML = '';
}

/* ------------------------------------------------------------------- work -- */
function renderWork() {
  footerEl.classList.add('hide');
  const profile = state.profile ?? {};
  const isOnline = ['online', 'busy'].includes(profile.work_status);
  const verified = profile.status === 'verified';

  screenEl.innerHTML = `
    <div class="card col tight">
      <div class="row between">
        <div>
          <div class="label">Статус</div>
          <div style="font-size:19px;font-weight:800;color:${isOnline ? 'var(--green)' : 'var(--muted)'}">
            ${isOnline ? 'На лінії' : verified ? 'Офлайн' : 'Не верифіковано'}</div>
          <small class="muted" id="geoState">GPS…</small>
        </div>
        <button class="btn ${isOnline ? 'danger' : 'primary'}" id="toggleOnline" ${verified ? '' : 'disabled'}>
          ${isOnline ? 'Вийти офлайн' : 'Вийти на лінію'}</button>
      </div>
      <div class="row wrap" style="gap:6px">
        <span class="chip ${profile.auto_accept ? 'active' : ''}">${profile.auto_accept ? '⚡ Авто-прийняття' : '🖐 Ручний режим'}</span>
        <span class="chip">Радіус ${profile.accept_radius_km ?? 5} км</span>
        <span class="chip">Мін. ціна ${money(profile.min_price_cents ?? 0)}</span>
        <span class="chip">Комісія ${profile.commission_pct ?? 15}%</span>
      </div>
    </div>

    <div id="driverMap" style="height:190px"></div>

    <div class="col" style="gap:8px">
      <div class="row between"><h2 style="margin:0">Вхідні замовлення</h2><small class="muted">${state.offers.length}</small></div>
      <div id="offersBox" class="col" style="gap:8px"></div>
    </div>

    ${state.activeOrders.length ? `<div class="card col tight">
      <div class="label">Активне замовлення</div>
      ${state.activeOrders.map((o) => `<div class="list-row" data-open-order="${o.id}">
        <span class="pill ${STATUS_TONE[o.status]}">${STATUS_LABELS[o.status]}</span>
        <div class="grow nowrap">№${o.number} · ${money(o.quoted_price_cents)}</div><span>→</span></div>`).join('')}
    </div>` : ''}

    <div class="grid c3">
      <div class="card tight"><div class="kpi-label">Рейтинг</div><div class="kpi-value">${profile.rating ?? '—'}</div></div>
      <div class="card tight"><div class="kpi-label">Прийняття</div><div class="kpi-value">${state.stats?.acceptanceRate ?? 0}%</div></div>
      <div class="card tight"><div class="kpi-label">Замовлень</div><div class="kpi-value">${profile.orders_completed ?? 0}</div></div>
    </div>

    ${state.stats?.quests?.length ? `<div class="card col tight">
      <div class="label">Бонусні завдання</div>
      ${state.stats.quests.map((q) => `<div class="col" style="gap:4px">
        <div class="row between"><span style="font-size:13px">${esc(q.title)}</span>
          <small class="muted">${q.progress}/${q.target_orders} · ${money(q.bonus_cents)}</small></div>
        <div class="progress"><i style="width:${Math.min(100, (q.progress / q.target_orders) * 100)}%"></i></div>
      </div>`).join('')}
    </div>` : ''}
  `;

  const city = state.cities.find((c) => c.id === profile.city_id);
  state.map = new MapView($('#driverMap'), {
    center: state.lastPosition ?? { lat: city?.lat ?? 50.45, lng: city?.lng ?? 30.52 },
    zoom: 1.8,
  });
  const mapMarkers = state.offers
    .map((offer, i) => (offer.order?.points?.[0]
      ? { id: `offer-${i}`, ...offer.order.points[0], kind: 'pickup', label: money(offer.price_cents) }
      : null))
    .filter(Boolean);
  if (state.lastPosition) mapMarkers.push({ id: 'me', ...state.lastPosition, kind: 'driver', label: 'Я' });
  state.map.setMarkers(mapMarkers);
  if (mapMarkers.length === 1) state.map.setCenter(mapMarkers[0].lat, mapMarkers[0].lng);
  renderOffers();
  renderGeoState();

  $('#toggleOnline').onclick = guard(async () => {
    if (isOnline) await api.post('/api/driver/offline', {});
    else await api.post('/api/driver/online', state.lastPosition ?? {});
    await loadAll();
    render();
  });

  screenEl.querySelectorAll('[data-open-order]').forEach((row) => {
    row.onclick = () => openOrder(row.dataset.openOrder);
  });
}

function renderOffers() {
  const box = $('#offersBox');
  if (!box) return;
  if (!state.offers.length) {
    box.innerHTML = `<small class="muted">Очікуємо замовлення… Переконайтесь, що ви на лінії та GPS активний.</small>`;
    return;
  }
  box.innerHTML = state.offers.map((offer) => {
    const order = offer.order;
    const pickup = order.points?.[0];
    const dropoff = order.points?.at(-1);
    return `
      <div class="card col tight offer-card">
        <div class="row between">
          <span class="pill lime">Пропозиція · ${Math.round(offer.secondsLeft)} с</span>
          <b>${money(offer.price_cents)}</b>
        </div>
        <div class="col" style="gap:2px">
          <div class="row" style="gap:6px"><span>🟢</span><small class="nowrap">${esc(pickup?.address ?? '')}</small></div>
          <div class="row" style="gap:6px"><span>🟣</span><small class="nowrap">${esc(dropoff?.address ?? '')}</small></div>
        </div>
        <div class="row between"><small class="muted">До клієнта ${km(offer.distance_to_pickup_m)} · ${mins(offer.eta_to_pickup_s)}</small>
          <small class="muted">${km(order.distance_m)} поїздка</small></div>
        <div class="row" style="gap:8px">
          <button class="btn primary grow" data-accept="${offer.id}">Прийняти</button>
          <button class="btn grow" data-decline="${offer.id}">Відхилити</button>
        </div>
      </div>`;
  }).join('');
  box.querySelectorAll('[data-accept]').forEach((btn) => {
    btn.onclick = guard(async () => {
      const res = await api.post(`/api/driver/offers/${btn.dataset.accept}/accept`, {});
      toast('Замовлення прийнято');
      state.offers = [];
      await loadAll();
      openOrder(res.order.id);
    });
  });
  box.querySelectorAll('[data-decline]').forEach((btn) => {
    btn.onclick = guard(async () => {
      await api.post(`/api/driver/offers/${btn.dataset.decline}/decline`, {});
      await loadOffers();
      render();
    });
  });
}

/* ------------------------------------------------------------------ order -- */
const openOrder = guard(async (orderId) => {
  const res = await api.get(`/api/orders/${orderId}`);
  state.order = res.order;
  state.screen = 'order';
  state.rt?.subscribe(`order:${orderId}`);
  render();
});

function renderOrder() {
  const order = state.order;
  if (!order) { state.screen = 'work'; return render(); }
  const pickup = order.points[0];
  const dropoff = order.points.at(-1);
  const next = {
    assigned: ['driver_arriving', 'Їду до клієнта'],
    driver_arriving: ['waiting', 'Я на місці'],
    waiting: ['in_progress', 'Почати поїздку'],
    in_progress: ['completed', 'Завершити поїздку'],
  }[order.status];

  screenEl.innerHTML = `
    <div class="row between">
      <span class="pill ${STATUS_TONE[order.status]}">${STATUS_LABELS[order.status]}</span>
      <small class="muted">№${order.number}</small>
    </div>
    <div id="orderMap" style="height:200px"></div>

    <div class="card col tight">
      ${order.points.map((p) => `<div class="row" style="gap:8px">
        <span>${p.kind === 'pickup' ? '🟢' : p.kind === 'stop' ? '🟡' : '🟣'}</span>
        <div class="grow"><div style="font-size:13px">${esc(p.address)}</div>
          ${p.note ? `<small class="muted">${esc(p.note)}</small>` : ''}</div>
      </div>`).join('')}
      <div class="divider"></div>
      <div class="row between"><small class="muted">Оплата</small><span>${esc(order.payment_method)} · ${money(order.quoted_price_cents)}</span></div>
      ${order.comment ? `<div class="row between"><small class="muted">Коментар</small><span class="nowrap" style="max-width:60%">${esc(order.comment)}</span></div>` : ''}
      ${order.forOther ? `<div class="row between"><small class="muted">Пасажир</small><span>${esc(order.forOther.name)} · ${esc(order.forOther.phone)}</span></div>` : ''}
      <div class="row" style="gap:6px">
        <a class="btn sm grow" target="_blank" rel="noopener"
          href="https://www.google.com/maps/dir/?api=1&destination=${pickup.lat},${pickup.lng}&travelmode=driving">Навігатор до клієнта</a>
        <a class="btn sm grow" target="_blank" rel="noopener"
          href="https://www.google.com/maps/dir/?api=1&destination=${dropoff.lat},${dropoff.lng}&travelmode=driving">До призначення</a>
      </div>
    </div>

    ${order.driver && order.forOther === null ? '' : ''}
    <a class="btn sm" href="tel:${esc(order.points[0]?.contact_phone ?? '')}">📞 Звʼязатися з пасажиром</a>

    ${order.delivery ? `<div class="card col tight">
      <div class="label">Доставка</div>
      <div style="font-size:13px">${esc(order.delivery.description ?? '')} · ${order.delivery.weight_kg} кг</div>
      <div class="row between"><small class="muted">Отримувач</small><span>${esc(order.delivery.recipient_name)}</span></div>
      <div class="row" style="gap:8px">
        <input class="input" id="pickupCode" placeholder="Код відправника" inputmode="numeric" />
        <button class="btn sm" id="pickupBtn">Забрав</button>
      </div>
      <div class="row" style="gap:8px">
        <input class="input" id="dropoffCode" placeholder="Код отримувача" inputmode="numeric" />
        <button class="btn sm" id="dropoffBtn">Доставив</button>
      </div>
    </div>` : ''}
  `;

  const city = state.cities.find((c) => c.id === order.city_id);
  const map = new MapView($('#orderMap'), { center: { lat: city?.lat ?? 50.45, lng: city?.lng ?? 30.52 }, zoom: 1.8 });
  map.setMarkers([
    ...order.points.map((p, i) => ({ id: `p${i}`, lat: p.lat, lng: p.lng, kind: p.kind })),
    ...(state.lastPosition ? [{ id: 'me', ...state.lastPosition, kind: 'driver', label: 'Я' }] : []),
  ]);
  map.setRoute(order.points);
  map.fit(order.points, 1.8);
  state.map = map;

  if ($('#pickupBtn')) {
    $('#pickupBtn').onclick = guard(async () => {
      await api.post(`/api/orders/${order.id}/delivery/pickup`, { code: $('#pickupCode').value.trim() });
      toast('Посилку прийнято');
      await openOrder(order.id);
    });
    $('#dropoffBtn').onclick = guard(async () => {
      await api.post(`/api/orders/${order.id}/delivery/dropoff`,
        { code: $('#dropoffCode').value.trim(), photoUrl: '/uploads/proof/delivery.jpg' });
      toast('Доставку завершено');
      await loadAll();
      render();
    });
  }

  footerEl.classList.remove('hide');
  footerEl.innerHTML = `
    <div class="row" style="gap:8px">
      <button class="btn ghost" id="backBtn">←</button>
      ${next ? `<button class="btn primary grow" id="nextBtn">${next[1]}</button>` : '<small class="muted">Замовлення закрито</small>'}
    </div>`;
  $('#backBtn').onclick = () => { state.screen = 'work'; state.order = null; render(); };
  if ($('#nextBtn')) {
    $('#nextBtn').onclick = guard(async () => {
      const res = await api.post(`/api/driver/orders/${order.id}/status`, { status: next[0] });
      state.order = res.order;
      if (next[0] === 'completed') {
        toast(`Поїздку завершено. Заробіток: ${money(res.order.quoted_price_cents - (res.order.commission_cents ?? 0))}`);
        state.order = null;
        state.screen = 'work';
        state.tab = 'work';
        await refreshDriverState();
        await loadOffers();
        await loadEarnings();
        render();
        return;
      }
      render();
    });
  }
}

/* --------------------------------------------------------------- earnings -- */
function renderEarnings() {
  const profile = state.profile ?? {};
  const daily = state.earnings?.daily ?? [];
  const max = Math.max(1, ...daily.map((d) => Number(d.gross ?? 0)));
  const tx = state.transactions ?? [];

  screenEl.innerHTML = `
    <h1>Заробіток</h1>
    <div class="card col tight">
      <div class="row between">
        <div><div class="label">Баланс</div><div class="kpi-value">${money(state.earnings?.balanceCents ?? profile.balance_cents ?? 0)}</div></div>
        <button class="btn sm primary" id="payoutBtn">Вивести</button>
      </div>
      <small class="muted">Готівкові замовлення: комісія списується з балансу. Карткові — зараховуються на баланс.</small>
    </div>

    <div class="card col tight">
      <div class="label">Останні 14 днів</div>
      <div class="row" style="align-items:flex-end;gap:4px;height:90px">
        ${daily.length ? daily.slice().reverse().map((d) => `
          <div style="flex:1;text-align:center">
            <div style="height:${Math.max(4, (Number(d.gross) / max) * 70)}px;background:linear-gradient(180deg,#c8ff3d,#2ee6a8);border-radius:4px"></div>
            <small class="muted" style="font-size:9px">${String(d.day).slice(8)}</small>
          </div>`).join('') : '<small class="muted">Ще немає завершених поїздок</small>'}
      </div>
    </div>

    <div class="card col tight">
      <div class="label">Транзакції</div>
      <div class="list">
        ${tx.slice(0, 20).map((t) => `<div class="list-row">
          <span>${t.amount_cents >= 0 ? '＋' : '−'}</span>
          <div class="grow"><div style="font-size:13px">${esc(t.kind)}</div><small class="muted">${dt(t.created_at)}</small></div>
          <b style="color:${t.amount_cents >= 0 ? 'var(--green)' : 'var(--red)'}">${money2(Math.abs(t.amount_cents))}</b>
        </div>`).join('') || '<small class="muted">Немає транзакцій</small>'}
      </div>
    </div>
  `;
  footerEl.classList.add('hide');
  $('#payoutBtn').onclick = guard(async () => {
    const balance = state.earnings?.balanceCents ?? 0;
    if (balance < 10000) return toast('Мінімальна сума виплати — 100 ₴', 'err');
    await api.post('/api/driver/payout', { amountCents: balance, idempotencyKey: `wd_${Date.now()}` });
    toast('Заявку на виплату створено');
    await loadEarnings();
    render();
  });
}

/* ---------------------------------------------------------------- profile -- */
function renderProfileTab() {
  const profile = state.profile ?? {};
  const vehicles = state.me?.vehicles ?? [];
  const docs = state.me?.documents ?? [];
  screenEl.innerHTML = `
    <h1>Профіль водія</h1>
    <div class="card col tight">
      <div class="row between"><div>
        <div style="font-weight:700">${esc(state.user?.name ?? '')}</div>
        <small class="muted">${esc(state.user?.phone ?? '')}</small></div>
        <span class="pill ${profile.status === 'verified' ? 'green' : profile.status === 'pending' ? 'amber' : 'red'}">${profile.status}</span>
      </div>
      ${profile.rating_count ? `<div class="row between"><small class="muted">Рейтинг</small><span class="rating">★ ${profile.rating} (${profile.rating_count})</span></div>` : ''}
      ${profile.rejection_reason ? `<small class="muted">Причина відхилення: ${esc(profile.rejection_reason)}</small>` : ''}
    </div>

    <div class="card col tight">
      <div class="label">Режим роботи</div>
      <label class="row between" style="gap:8px">
        <span style="font-size:13px">Автоматично приймати замовлення</span>
        <input type="checkbox" id="autoAccept" ${profile.auto_accept ? 'checked' : ''} />
      </label>
      <small class="muted">Авто-прийняття спрацьовує лише якщо ціна ≥ мінімальної та відстань ≤ вашого радіуса.</small>
      <div class="row" style="gap:8px">
        <div class="field grow"><label class="label">Радіус, км</label>
          <input class="input" id="radius" type="number" min="0.5" max="50" step="0.5" value="${profile.accept_radius_km ?? 5}" /></div>
        <div class="field grow"><label class="label">Мін. ціна, ₴</label>
          <input class="input" id="minPrice" type="number" min="0" step="10" value="${Math.round((profile.min_price_cents ?? 0) / 100)}" /></div>
      </div>
      <div class="label">Класи</div>
      <div class="row wrap" id="classChips">
        ${state.classes.map((c) => `<button class="chip ${(profile.classes_csv ?? '').split(',').includes(c.code) ? 'active' : ''}" data-cls="${c.code}">${esc(c.name)}</button>`).join('')}
      </div>
      <button class="btn primary" id="saveSettings">Зберегти налаштування</button>
    </div>

    <div class="card col tight">
      <div class="label">Авто</div>
      ${vehicles.map((v) => `<div class="list-row"><span>🚘</span>
        <div class="grow">${esc(v.make)} ${esc(v.model)} · ${esc(v.color ?? '')}</div><b class="mono">${esc(v.plate)}</b></div>`).join('')}
    </div>

    <div class="card col tight">
      <div class="label">Документи</div>
      ${docs.map((d) => `<div class="list-row"><span>📄</span>
        <div class="grow" style="font-size:13px">${esc(d.type)}</div>
        <span class="pill ${d.status === 'approved' ? 'green' : d.status === 'rejected' ? 'red' : 'amber'}">${d.status}</span></div>`).join('')}
      <button class="btn sm ghost" id="addDocBtn">Додати документ</button>
    </div>

    <div class="card col tight">
      <div class="label">Відгуки (${state.reviews.length})</div>
      ${state.reviews.slice(0, 5).map((r) => `<div class="col" style="gap:2px">
        <div class="row between"><span class="rating">${'★'.repeat(r.rating)}</span><small class="muted">${dt(r.created_at)}</small></div>
        ${r.text ? `<small class="muted">${esc(r.text)}</small>` : ''}
      </div>`).join('') || '<small class="muted">Ще немає відгуків</small>'}
    </div>

    <div class="card col tight">
      <div class="label">Підтримка водіїв 24/7</div>
      <button class="btn sm" id="driverSupport">Написати в підтримку</button>
    </div>
  `;
  footerEl.classList.add('hide');

  const selected = new Set((profile.classes_csv ?? '').split(',').filter(Boolean));
  screenEl.querySelectorAll('[data-cls]').forEach((chip) => {
    chip.onclick = () => {
      const code = chip.dataset.cls;
      if (selected.has(code)) selected.delete(code); else selected.add(code);
      chip.classList.toggle('active');
    };
  });
  $('#saveSettings').onclick = guard(async () => {
    await api.patch('/api/driver/settings', {
      autoAccept: $('#autoAccept').checked,
      acceptRadiusKm: Number($('#radius').value),
      minPriceCents: Math.round(Number($('#minPrice').value) * 100),
      classes: Array.from(selected),
    });
    toast('Налаштування збережено');
    await loadAll();
    render();
  });
  $('#addDocBtn').onclick = guard(async () => {
    await api.post('/api/driver/documents', { type: 'insurance', fileUrl: `/uploads/insurance/${Date.now()}.jpg` });
    toast('Документ додано, очікуйте перевірки');
    await loadAll();
    render();
  });
  $('#driverSupport').onclick = guard(async () => {
    await api.post('/api/support/tickets', { subject: 'Питання водія', message: 'Потрібна допомога з замовленням' });
    toast('Звернення створено');
  });
}

/* ------------------------------------------------------------------ tabs --- */
function renderTabbar() {
  if (['auth', 'register', 'loading'].includes(state.screen)) { tabbarEl.innerHTML = ''; return; }
  const tabs = [['work', '🚕', 'Робота'], ['earnings', '💰', 'Заробіток'], ['profile', '👤', 'Профіль']];
  tabbarEl.innerHTML = tabs.map(([code, ico, label]) => `
    <div class="tab ${state.tab === code ? 'active' : ''}" data-tab="${code}"><span class="tab-ico">${ico}</span>${label}</div>`).join('');
  tabbarEl.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.onclick = () => {
      state.tab = tab.dataset.tab;
      state.screen = tab.dataset.tab;
      if (state.tab === 'earnings') loadEarnings();
      if (state.tab === 'profile') loadReviews();
      render();
    };
  });
}

function render() {
  if (!token.get() || state.screen === 'auth') return renderAuth();
  if (state.screen === 'loading') {
    screenEl.innerHTML = '<div class="row" style="justify-content:center;padding:40px"><div class="spinner"></div></div>';
    return;
  }
  $('#statusLabel').textContent = state.profile
    ? `${state.profile.work_status === 'online' ? 'на лінії' : state.profile.work_status === 'busy' ? 'виконує замовлення' : 'офлайн'} · ${state.profile.status}`
    : 'немає профілю';
  if (state.screen === 'register') { renderRegister(); return; }
  if (state.screen === 'order') { renderOrder(); renderTabbar(); return; }
  if (state.screen === 'earnings') { renderEarnings(); renderTabbar(); return; }
  if (state.screen === 'profile') { renderProfileTab(); renderTabbar(); return; }
  renderWork();
  renderTabbar();
}

$('#logoutBtn').onclick = () => {
  token.clear();
  state.rt?.close();
  location.reload();
};

boot();
