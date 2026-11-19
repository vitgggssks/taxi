/* РУХ — passenger web app. Talks to the real API + WebSocket, no mock data. */
import {
  $, api, dt, el, esc, guard, hryvnia, km, mins, money, Realtime,
  STATUS_LABELS, STATUS_TONE, toast, token,
} from './api.js';
import { MapView } from './map.js';

const state = {
  user: null,
  catalog: null,
  cities: [],
  cityId: 'city_kyiv',
  screen: 'auth',
  tab: 'home',
  service: 'ride', // ride | delivery | intercity | sober
  route: { pickup: null, dropoff: null, stops: [] },
  picking: 'pickup',
  classId: null,
  quotes: [],
  quote: null,
  options: [],
  promo: '',
  payment: 'cash',
  comment: '',
  scheduledAt: '',
  forOther: false,
  otherName: '',
  otherPhone: '',
  delivery: { weightKg: 2, description: '', instructions: '', recipientName: '', recipientPhone: '', declaredValueCents: 0 },
  trackId: null,
  order: null,
  history: [],
  activeOrders: [],
  addresses: [],
  wallet: { balance: 0, bonus: 0 },
  notifications: [],
  map: null,
  rt: null,
  quoteSeq: 0,
};

const screenEl = $('#screen');
const footerEl = $('#footer');
const tabbarEl = $('#tabbar');

/* ------------------------------------------------------------------ boot -- */
async function boot() {
  if (!token.get()) return render();
  try {
    await refreshMe();
    state.screen = 'home';
  } catch {
    token.clear();
    state.screen = 'auth';
  }
  render();
}

const refreshMe = guard(async () => {
  const me = await api.get('/api/me');
  state.user = me;
  state.cityId = me.cityId || state.cityId;
  state.addresses = (await api.get('/api/me/addresses')).items;
  state.notifications = (await api.get('/api/me/notifications')).items;
  await refreshWallet();
  await loadCities();
  await loadCatalog();
  await loadOrders();
  connectRealtime();
  $('#cityLabel').textContent = cityName(state.cityId);
});

const refreshWallet = guard(async () => {
  const res = await api.get('/api/wallet');
  state.wallet = { balance: res.balanceCents, bonus: res.bonusCents };
  $('#walletBtn').textContent = money(res.balanceCents);
});

const loadCities = guard(async () => {
  state.cities = (await api.get('/api/cities')).items;
});

const loadCatalog = guard(async () => {
  state.catalog = await api.get(`/api/catalog?cityId=${state.cityId}`);
});

const loadOrders = guard(async () => {
  const all = (await api.get('/api/orders?limit=40')).items;
  state.history = all.filter((o) => ['completed', 'canceled', 'expired'].includes(o.status));
  state.activeOrders = all.filter((o) => !['completed', 'canceled', 'expired'].includes(o.status));
  if (state.trackId) {
    const found = all.find((o) => o.id === state.trackId);
    if (found) state.order = found;
  }
});

function connectRealtime() {
  if (state.rt) return;
  state.rt = new Realtime(async (msg) => {
    if (msg.event === 'order.updated' || msg.event === 'order.assigned') {
      const order = msg.payload;
      if (state.trackId && order?.id === state.trackId) {
        state.order = order;
        render();
      }
      loadOrders();
    }
    if (msg.event === 'driver.location' && state.order?.driver) {
      state.order.driver.lat = msg.payload.lat;
      state.order.driver.lng = msg.payload.lng;
      state.map?.upsertMarker({ id: 'driver', lat: msg.payload.lat, lng: msg.payload.lng, kind: 'driver', label: 'Водій' });
    }
    if (msg.event === 'notification') {
      toast(`${msg.payload.title}${msg.payload.body ? ` · ${msg.payload.body}` : ''}`);
      loadOrders();
    }
    if (msg.event === 'wallet.updated') refreshWallet();
  });
  state.rt.connect();
}

const cityName = (cityId) => state.cities.find((c) => c.id === cityId)?.name ?? 'Україна';

/* ------------------------------------------------------------------- auth -- */
function renderAuth() {
  screenEl.innerHTML = `
    <div class="col" style="gap:14px;padding-top:8px">
      <div>
        <h1>РУХ</h1>
        <p class="muted">Таксі, міжміські поїздки та доставка посилок. Фіксована ціна до підтвердження.</p>
      </div>
      <div class="card col">
        <div class="field">
          <label class="label">Номер телефону</label>
          <input class="input" id="phoneInput" inputmode="tel" placeholder="+380 67 123 45 67" value="+380671112233" />
        </div>
        <div class="field hide" id="codeField">
          <label class="label">Код з SMS</label>
          <input class="input" id="codeInput" inputmode="numeric" placeholder="6 цифр" />
          <small class="muted" id="codeHint"></small>
        </div>
        <button class="btn primary block" id="authBtn">Отримати код</button>
      </div>
      <div class="card col tight">
        <div class="label">Демо-вхід (SMS-шлюз не підключений)</div>
        <div class="row wrap">
          <button class="chip" data-demo="passenger">Пасажир</button>
          <button class="chip" data-demo="corporate_admin">Корпоративний</button>
          <a class="chip" href="/driver">Застосунок водія →</a>
          <a class="chip" href="/admin">Адмінпанель →</a>
        </div>
      </div>
      <small class="muted center">Продовжуючи, ви приймаєте правила сервісу та політику конфіденційності.</small>
    </div>`;

  let stage = 'phone';
  $('#authBtn').onclick = guard(async () => {
    if (stage === 'phone') {
      const phone = $('#phoneInput').value.trim();
      const res = await api.post('/api/auth/request-otp', { phone });
      stage = 'code';
      $('#codeField').classList.remove('hide');
      $('#codeInput').value = res.demoCode || '';
      $('#codeHint').textContent = `Демо-режим: код ${res.demoCode}. Дійсний ${Math.round(res.expiresInSec / 60)} хв.`;
      $('#authBtn').textContent = 'Увійти';
      return;
    }
    const phone = $('#phoneInput').value.trim();
    const code = $('#codeInput').value.trim();
    const res = await api.post('/api/auth/verify-otp', { phone, code });
    token.set(res.token);
    await refreshMe();
    state.screen = 'home';
    render();
    toast(`Вітаємо, ${res.user.name || res.user.phone}`);
  });

  screenEl.querySelectorAll('[data-demo]').forEach((btn) => {
    btn.onclick = guard(async () => {
      const res = await api.post('/api/auth/demo-login', { role: btn.dataset.demo });
      token.set(res.token);
      await refreshMe();
      state.screen = 'home';
      render();
    });
  });
  tabbarEl.innerHTML = '';
  footerEl.classList.add('hide');
}

/* ------------------------------------------------------------------- home -- */
function renderHome() {
  const isDelivery = state.service === 'delivery';
  const pickup = state.route.pickup;
  const dropoff = state.route.dropoff;

  screenEl.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(4,1fr);gap:6px">
      ${[
        ['ride', '🚗 Поїздка'], ['delivery', '📦 Доставка'], ['intercity', '🛣️ Міжмісто'], ['sober', '🧑‍✈️ Тверезий'],
      ].map(([code, label]) => `<button class="chip ${state.service === code ? 'active' : ''}" data-service="${code}"
        style="justify-content:center;font-size:12px">${label}</button>`).join('')}
    </div>

    <div id="mapBox" style="height:230px"></div>

    <div class="card col tight">
      <div class="row" style="gap:8px">
        <div class="route-dots"><span class="dot"></span><span class="dot-line"></span><span class="dot square"></span></div>
        <div class="col grow" style="gap:6px">
          <input class="input" id="pickupInput" placeholder="Звідки" value="${esc(pickup?.address ?? '')}" />
          <input class="input" id="dropoffInput" placeholder="Куди" value="${esc(dropoff?.address ?? '')}" />
        </div>
      </div>
      ${state.route.stops.map((stop, i) => `
        <div class="row" style="gap:8px;padding-left:22px">
          <input class="input" data-stop-input="${i}" placeholder="Зупинка ${i + 1}" value="${esc(stop.address)}" />
          <button class="btn sm danger" data-remove-stop="${i}">✕</button>
        </div>`).join('')}
      <div class="row wrap">
        <button class="btn sm ghost" id="addStopBtn" ${state.route.stops.length >= 5 ? 'disabled' : ''}>+ Зупинка</button>
        <button class="btn sm ghost" id="myAddressesBtn">⭐ Мої адреси</button>
        <button class="btn sm ghost" id="geoBtn">📍 Моє місце</button>
      </div>
      <small class="muted">Клік по мапі: ${state.picking === 'pickup' ? 'точка подачі' : 'точка призначення'} · Ctrl+колесо — зум</small>
    </div>

    ${isDelivery ? renderDeliveryForm() : ''}

    <div class="col" style="gap:8px">
      <div class="row between"><h2 style="margin:0">${isDelivery ? 'Курʼєр' : 'Клас авто'}</h2>
        <small class="muted" id="routeMeta">${state.quote ? `${km(state.quote.distanceM)} · ${mins(state.quote.durationS)}` : ''}</small></div>
      <div class="col" id="classList" style="gap:8px"></div>
    </div>

    <div class="card col tight">
      <div class="label">Опції</div>
      <div class="row wrap" id="optionList"></div>
      <div class="divider"></div>
      <div class="label">Оплата</div>
      <div class="row wrap" id="paymentList">
        ${[['cash', '💵 Готівка'], ['card', '💳 Картка'], ['apple_pay', ' Apple Pay'], ['google_pay', '🟢 Google Pay'], ['wallet', '👛 Баланс']]
          .map(([code, label]) => `<button class="chip ${state.payment === code ? 'active' : ''}" data-payment="${code}">${label}</button>`).join('')}
      </div>
      <div class="divider"></div>
      <div class="row" style="gap:8px">
        <input class="input" id="promoInput" placeholder="Промокод" value="${esc(state.promo)}" />
        <button class="btn sm" id="promoBtn">Застосувати</button>
      </div>
      <div class="row" style="gap:8px">
        <input class="input" id="commentInput" placeholder="Коментар водієві" value="${esc(state.comment)}" />
      </div>
      <details>
        <summary class="muted" style="cursor:pointer;font-size:13px">Попереднє замовлення / для іншої людини</summary>
        <div class="col" style="gap:8px;margin-top:8px">
          <input class="input" type="datetime-local" id="scheduleInput" value="${esc(state.scheduledAt)}" />
          <label class="row" style="gap:8px;font-size:13px">
            <input type="checkbox" id="forOtherToggle" ${state.forOther ? 'checked' : ''} /> Замовляю для іншої людини
          </label>
          ${state.forOther ? `
            <input class="input" id="otherName" placeholder="Імʼя пасажира" value="${esc(state.otherName)}" />
            <input class="input" id="otherPhone" placeholder="Телефон пасажира" value="${esc(state.otherPhone)}" />` : ''}
        </div>
      </details>
    </div>

    ${state.activeOrders.length ? `
      <div class="col" style="gap:8px">
        <h2 style="margin:0">Активні (${state.activeOrders.length}/5)</h2>
        ${state.activeOrders.map((o) => `
          <div class="list-row" data-open-order="${o.id}">
            <span class="pill ${STATUS_TONE[o.status]}">${STATUS_LABELS[o.status] ?? o.status}</span>
            <div class="grow nowrap">
              <div style="font-size:13px">${esc(o.points[0]?.address ?? '')} → ${esc(o.points.at(-1)?.address ?? '')}</div>
              <small class="muted">№${o.number} · ${money(o.quoted_price_cents)}</small>
            </div>
            <span class="muted">→</span>
          </div>`).join('')}
      </div>` : ''}
  `;

  mountMap();
  renderClassList();
  renderOptions();

  $('#pickupInput').oninput = (e) => { state.route.pickup = { ...(state.route.pickup || {}), address: e.target.value }; };
  $('#dropoffInput').oninput = (e) => { state.route.dropoff = { ...(state.route.dropoff || {}), address: e.target.value }; };
  $('#pickupInput').onclick = () => openAddressSearch('pickup');
  $('#dropoffInput').onclick = () => openAddressSearch('dropoff');

  screenEl.querySelectorAll('[data-service]').forEach((btn) => {
    btn.onclick = guard(async () => {
      state.service = btn.dataset.service;
      state.classId = null;
      state.quote = null;
      state.options = [];
      await loadCatalog();
      render();
    });
  });

  $('#addStopBtn').onclick = guard(async () => {
    if (state.route.stops.length >= 5) return toast('Максимум 5 зупинок', 'err');
    state.route.stops.push({ address: '', lat: null, lng: null });
    render();
    openAddressSearch('stop', state.route.stops.length - 1);
  });

  screenEl.querySelectorAll('[data-remove-stop]').forEach((btn) => {
    btn.onclick = () => {
      state.route.stops.splice(Number(btn.dataset.removeStop), 1);
      refreshQuotes();
      render();
    };
  });

  screenEl.querySelectorAll('[data-stop-input]').forEach((input) => {
    input.onclick = () => openAddressSearch('stop', Number(input.dataset.stopInput));
  });

  $('#myAddressesBtn').onclick = () => openSavedAddresses();
  $('#geoBtn').onclick = guard(async () => {
    navigator.geolocation?.getCurrentPosition(async (pos) => {
      state.route.pickup = { address: 'Моє місце', lat: pos.coords.latitude, lng: pos.coords.longitude };
      await refreshQuotes();
      render();
    }, () => toast('Геолокація недоступна — виберіть точку на мапі', 'err'));
  });

  screenEl.querySelectorAll('[data-payment]').forEach((btn) => {
    btn.onclick = () => { state.payment = btn.dataset.payment; render(); };
  });

  $('#promoBtn').onclick = applyPromo;
  $('#commentInput').oninput = (e) => { state.comment = e.target.value; };
  $('#scheduleInput').onchange = (e) => { state.scheduledAt = e.target.value; };
  const otherToggle = $('#forOtherToggle');
  if (otherToggle) otherToggle.onchange = (e) => { state.forOther = e.target.checked; render(); };
  if ($('#otherName')) $('#otherName').oninput = (e) => { state.otherName = e.target.value; };
  if ($('#otherPhone')) $('#otherPhone').oninput = (e) => { state.otherPhone = e.target.value; };

  if (state.service === 'delivery') bindDeliveryForm();

  screenEl.querySelectorAll('[data-open-order]').forEach((row) => {
    row.onclick = () => openTracking(row.dataset.openOrder);
  });

  renderFooter();
  if (!state.route.pickup || !state.route.dropoff) refreshQuotes();
}

function renderDeliveryForm() {
  return `
    <div class="card col tight">
      <div class="label">Деталі посилки (до 20 кг)</div>
      <div class="row" style="gap:8px">
        <div class="field grow"><label class="label">Вага, кг</label>
          <input class="input" id="dWeight" type="number" min="0.1" max="20" step="0.1" value="${state.delivery.weightKg}" /></div>
        <div class="field grow"><label class="label">Оголошена вартість, ₴</label>
          <input class="input" id="dValue" type="number" min="0" step="50" value="${hryvnia(state.delivery.declaredValueCents)}" /></div>
      </div>
      <input class="input" id="dDesc" placeholder="Опис (документи, ключі…)" value="${esc(state.delivery.description)}" />
      <input class="input" id="dInstr" placeholder="Особливі інструкції" value="${esc(state.delivery.instructions)}" />
      <div class="row" style="gap:8px">
        <input class="input" id="dRecipient" placeholder="Отримувач: імʼя" value="${esc(state.delivery.recipientName)}" />
        <input class="input" id="dRecipientPhone" placeholder="Телефон отримувача" value="${esc(state.delivery.recipientPhone)}" />
      </div>
      <small class="muted">Відправник — ви (${esc(state.user?.phone ?? '')}). Коди підтвердження зʼявляться після створення.</small>
    </div>`;
}

function bindDeliveryForm() {
  const bind = (id, key, transform = (v) => v) => {
    const node = $(id);
    if (node) node.oninput = (e) => { state.delivery[key] = transform(e.target.value); };
  };
  bind('#dWeight', 'weightKg', Number);
  bind('#dValue', 'declaredValueCents', (v) => Math.round(Number(v) * 100));
  bind('#dDesc', 'description');
  bind('#dInstr', 'instructions');
  bind('#dRecipient', 'recipientName');
  bind('#dRecipientPhone', 'recipientPhone');
}

function mountMap() {
  const box = $('#mapBox');
  if (!box) return;
  const city = state.cities.find((c) => c.id === state.cityId) ?? { lat: 50.4501, lng: 30.5234 };
  state.map = new MapView(box, {
    center: state.route.pickup?.lat ? { lat: state.route.pickup.lat, lng: state.route.pickup.lng } : { lat: city.lat, lng: city.lng },
    zoom: 1.6,
    onPick: guard(async (point) => {
      const address = await reverse(point);
      const target = state.picking;
      if (target === 'pickup') state.route.pickup = { ...point, address };
      else if (target === 'dropoff') state.route.dropoff = { ...point, address };
      state.picking = state.picking === 'pickup' ? 'dropoff' : 'pickup';
      await refreshQuotes();
      render();
    }),
  });
  state.map.setHint(`Клік — ${state.picking === 'pickup' ? 'точка подачі' : 'точка призначення'}`);
  syncMapMarkers();
}

function syncMapMarkers() {
  if (!state.map) return;
  const markers = [];
  if (state.route.pickup?.lat) markers.push({ id: 'pickup', ...state.route.pickup, kind: 'pickup' });
  if (state.route.dropoff?.lat) markers.push({ id: 'dropoff', ...state.route.dropoff, kind: 'dropoff' });
  state.route.stops.forEach((stop, i) => {
    if (stop.lat) markers.push({ id: `stop-${i}`, ...stop, kind: 'stop' });
  });
  state.map.setMarkers(markers);
  const points = [
    state.route.pickup, ...state.route.stops, state.route.dropoff,
  ].filter((p) => p?.lat);
  state.map.setRoute(points);
  if (points.length >= 2) state.map.fit(points, 1.6);
}

async function reverse(point) {
  try {
    const res = await api.get(`/api/geo/reverse?cityId=${state.cityId}&lat=${point.lat}&lng=${point.lng}`);
    return res.label;
  } catch {
    return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  }
}

/* --------------------------------------------------------------- addresses -- */
function openAddressSearch(target, index = 0) {
  const overlay = el(`
    <div class="overlay">
      <div class="sheet">
        <div class="row between"><h3 style="margin:0">Вибір адреси</h3><button class="btn sm ghost" data-close>✕</button></div>
        <input class="input" id="addrQuery" placeholder="Вулиця, заклад, адреса…" autofocus />
        <div class="list" id="addrResults"></div>
      </div>
    </div>`);
  $('#app').appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const resultsEl = overlay.querySelector('#addrResults');
  const input = overlay.querySelector('#addrQuery');
  let timer = null;
  const search = async () => {
    const q = input.value.trim();
    if (q.length < 2) { resultsEl.innerHTML = ''; return; }
    const res = await api.get(`/api/geo/search?cityId=${state.cityId}&q=${encodeURIComponent(q)}`);
    resultsEl.innerHTML = res.items.length
      ? res.items.map((item) => `
        <div class="list-row" data-address='${esc(JSON.stringify(item))}'>
          <span>${item.kind === 'poi' ? '📍' : item.kind === 'airport' ? '✈️' : item.kind === 'station' ? '🚉' : '🏠'}</span>
          <div class="grow nowrap">${esc(item.label)}</div>
        </div>`).join('')
      : '<small class="muted">Нічого не знайдено — спробуйте інший запит або клік по мапі</small>';
    resultsEl.querySelectorAll('[data-address]').forEach((row) => {
      row.onclick = async () => {
        const item = JSON.parse(row.dataset.address);
        const point = { address: item.label, lat: item.lat, lng: item.lng };
        applyPoint(target, index, point);
        close();
      };
    });
  };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(guard(search), 220); };
  input.focus();
}

function applyPoint(target, index, point) {
  if (target === 'pickup') state.route.pickup = point;
  else if (target === 'dropoff') state.route.dropoff = point;
  else state.route.stops[index] = point;
  state.picking = target === 'pickup' ? 'dropoff' : target;
  refreshQuotes();
  render();
}

function openSavedAddresses() {
  const overlay = el(`
    <div class="overlay"><div class="sheet">
      <div class="row between"><h3 style="margin:0">Мої адреси</h3><button class="btn sm ghost" data-close>✕</button></div>
      <div class="list">${state.addresses.length ? state.addresses.map((a) => `
        <div class="list-row" data-saved='${esc(JSON.stringify(a))}'>
          <span>⭐</span><div class="grow nowrap">${esc(a.label)}<br><small class="muted">${esc(a.address)}</small></div>
          <button class="btn sm danger" data-del="${a.id}">✕</button>
        </div>`).join('') : '<small class="muted">Ще немає збережених адрес</small>'}</div>
      <div class="divider"></div>
      <div class="col" style="gap:8px">
        <input class="input" id="newLabel" placeholder="Назва (Дім, Робота…)" />
        <input class="input" id="newAddress" placeholder="Адреса" value="${esc(state.route.pickup?.address ?? '')}" />
        <button class="btn primary" id="saveAddr">Зберегти поточну точку подачі</button>
      </div>
    </div></div>`);
  $('#app').appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').onclick = close;
  overlay.querySelectorAll('[data-saved]').forEach((row) => {
    row.onclick = (e) => {
      if (e.target.dataset.del) return;
      const item = JSON.parse(row.dataset.saved);
      applyPoint(state.picking, 0, { address: item.address, lat: item.lat, lng: item.lng });
      close();
    };
  });
  overlay.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = guard(async (e) => {
      e.stopPropagation();
      await api.del(`/api/me/addresses/${btn.dataset.del}`);
      state.addresses = (await api.get('/api/me/addresses')).items;
      btn.closest('.list-row').remove();
    });
  });
  overlay.querySelector('#saveAddr').onclick = guard(async () => {
    const label = overlay.querySelector('#newLabel').value.trim() || 'Адреса';
    const address = overlay.querySelector('#newAddress').value.trim();
    const point = state.route.pickup;
    if (!address) return toast('Вкажіть адресу', 'err');
    await api.post('/api/me/addresses', { label, address, lat: point?.lat ?? 0, lng: point?.lng ?? 0 });
    state.addresses = (await api.get('/api/me/addresses')).items;
    toast('Адресу збережено');
    close();
  });
}

/* ----------------------------------------------------------------- quotes -- */
const routePoints = () => {
  const points = [];
  if (state.route.pickup) points.push({ address: state.route.pickup.address || 'Точка подачі', lat: state.route.pickup.lat, lng: state.route.pickup.lng });
  state.route.stops.forEach((s) => { if (s) points.push({ address: s.address || 'Зупинка', lat: s.lat, lng: s.lng }); });
  if (state.route.dropoff) points.push({ address: state.route.dropoff.address || 'Призначення', lat: state.route.dropoff.lat, lng: state.route.dropoff.lng });
  return points;
};

const serviceKind = () => (['ride', 'delivery', 'intercity', 'sober'].includes(state.service) ? state.service : 'ride');

const refreshQuotes = guard(async () => {
  const points = routePoints();
  if (points.length < 2) {
    state.quotes = [];
    state.quote = null;
    renderClassList();
    renderFooter();
    return;
  }
  const seq = ++state.quoteSeq;
  const payload = {
    cityId: state.cityId,
    points,
    serviceKind: serviceKind(),
    options: state.options,
    promoCode: state.promo || null,
    plusMinusCents: state.quote?.plusMinusCents ?? 0,
  };
  const res = await api.post('/api/orders/quote', payload);
  if (seq !== state.quoteSeq) return;
  state.quotes = res.quotes ?? (res.quote ? [res.quote] : []);
  if (!state.classId && state.quotes.length) state.classId = state.quotes[0].classId;
  state.quote = state.quotes.find((q) => q.classId === state.classId) ?? state.quotes[0] ?? null;
  renderClassList();
  renderOptions();
  renderFooter();
});

function renderClassList() {
  const list = $('#classList');
  if (!list) return;
  if (!state.quotes.length) {
    list.innerHTML = `<small class="muted">${routePoints().length < 2 ? 'Вкажіть точки маршруту, щоб побачити ціну' : 'Немає доступних класів для цього маршруту'}</small>`;
    return;
  }
  const icons = Object.fromEntries((state.catalog?.classes ?? []).map((c) => [c.id, c.icon]));
  const seats = Object.fromEntries((state.catalog?.classes ?? []).map((c) => [c.id, c.seats]));
  list.innerHTML = state.quotes.map((q) => `
    <div class="list-row ${q.classId === state.classId ? 'offer-card' : ''}" data-class="${q.classId}" style="cursor:pointer">
      <div style="font-size:22px">${icons[q.classId] ?? '🚗'}</div>
      <div class="grow">
        <div style="font-weight:600">${esc(q.className)}</div>
        <small class="muted">${mins(q.pickupEtaS)} подача · ${km(q.distanceM)} · ${seats[q.classId] ? `${seats[q.classId]} місць` : ''}</small>
      </div>
      <div class="right">
        <div style="font-weight:700">${money(q.totalCents)}</div>
        <small class="muted">${q.breakdown.minFareApplied ? 'мін. тариф' : 'фіксовано'}</small>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-class]').forEach((row) => {
    row.onclick = () => { state.classId = row.dataset.class; refreshQuotes(); };
  });
}

function renderOptions() {
  const box = $('#optionList');
  if (!box || !state.catalog) return;
  const classCode = state.quote?.classCode;
  const allowed = state.catalog.options.filter((opt) => {
    if (opt.kind !== 'option') return false;
    if (!opt.class_scope) return true;
    const scope = String(opt.class_scope).split(',');
    return scope.includes('*') || (classCode && scope.includes(classCode));
  });
  box.innerHTML = allowed.map((opt) => `
    <button class="chip ${state.options.includes(opt.code) ? 'active' : ''}" data-option="${opt.code}">
      ${esc(opt.name)}${opt.price_cents ? ` · ${money(opt.price_cents)}` : ''}
    </button>`).join('') || '<small class="muted">Немає опцій для цього класу</small>';
  box.querySelectorAll('[data-option]').forEach((btn) => {
    btn.onclick = () => {
      const code = btn.dataset.option;
      state.options = state.options.includes(code) ? state.options.filter((c) => c !== code) : [...state.options, code];
      refreshQuotes();
    };
  });
}

const applyPromo = guard(async () => {
  const code = $('#promoInput').value.trim();
  if (!code) { state.promo = ''; await refreshQuotes(); return; }
  const points = routePoints();
  if (points.length < 2 || !state.classId) return toast('Спочатку вкажіть маршрут', 'err');
  const res = await api.post('/api/promo/validate', { code, cityId: state.cityId, classId: state.classId, points });
  if (!res.valid) { toast(res.reason || 'Промокод недійсний', 'err'); return; }
  state.promo = code;
  toast(`Промокод застосовано: −${money(res.discountCents)}`);
  await refreshQuotes();
});

/* ----------------------------------------------------------------- footer -- */
function renderFooter() {
  if (state.screen !== 'home') { footerEl.classList.add('hide'); return; }
  footerEl.classList.remove('hide');
  const ready = routePoints().length >= 2 && state.classId;
  const quote = state.quote;
  footerEl.innerHTML = `
    <div class="row between" style="margin-bottom:8px">
      <div>
        <div class="label">До сплати</div>
        <div style="font-size:22px;font-weight:800">${quote ? money(quote.totalCents) : '— ₴'}</div>
        ${quote && quote.discountCents ? `<small class="muted">знижка −${money(quote.discountCents)}</small>` : ''}
      </div>
      <div class="row" style="gap:6px">
        <button class="btn sm" id="minusBtn" ${!quote ? 'disabled' : ''}>−50 ₴</button>
        <button class="btn sm" id="plusBtn" ${!quote ? 'disabled' : ''}>+50 ₴</button>
      </div>
    </div>
    <button class="btn primary block" id="orderBtn" ${ready ? '' : 'disabled'}>
      ${state.service === 'delivery' ? 'Замовити курʼєра' : state.scheduledAt ? 'Запопередньо замовити' : 'Замовити РУХ'}
    </button>`;

  const adjust = guard(async (delta) => {
    const base = quote.plusMinusCents ?? 0;
    const payload = {
      cityId: state.cityId, classId: state.classId, points: routePoints(),
      serviceKind: serviceKind(), options: state.options, promoCode: state.promo || null,
      plusMinusCents: base + delta,
    };
    const res = await api.post('/api/orders/quote', payload);
    state.quote = res.quote;
    state.quotes = state.quotes.map((q) => (q.classId === res.quote.classId ? res.quote : q));
    renderClassList();
    renderFooter();
  });
  const minus = $('#minusBtn');
  const plus = $('#plusBtn');
  if (minus) minus.onclick = () => adjust(-5000);
  if (plus) plus.onclick = () => adjust(5000);
  $('#orderBtn').onclick = placeOrder;
}

const placeOrder = guard(async () => {
  const points = routePoints();
  if (points.length < 2) return toast('Вкажіть маршрут', 'err');
  if (state.forOther && (!state.otherName || !state.otherPhone)) return toast('Вкажіть імʼя та телефон пасажира', 'err');
  const payload = {
    cityId: state.cityId,
    classId: state.classId,
    serviceKind: serviceKind(),
    points,
    options: state.options,
    promoCode: state.promo || null,
    paymentMethod: state.payment,
    plusMinusCents: state.quote?.plusMinusCents ?? 0,
    comment: state.comment || null,
    scheduledAt: state.scheduledAt ? state.scheduledAt.replace('T', ' ') : null,
    forOther: state.forOther ? { name: state.otherName, phone: state.otherPhone } : null,
  };
  if (state.service === 'delivery') {
    payload.delivery = {
      senderName: state.user?.name || 'Відправник',
      senderPhone: state.user?.phone,
      recipientName: state.delivery.recipientName,
      recipientPhone: state.delivery.recipientPhone,
      weightKg: state.delivery.weightKg,
      declaredValueCents: state.delivery.declaredValueCents,
      description: state.delivery.description,
      instructions: state.delivery.instructions,
    };
  }
  const res = await api.post('/api/orders', payload);
  toast(`Замовлення №${res.order.number} створено`);
  await loadOrders();
  openTracking(res.order.id);
});

/* --------------------------------------------------------------- tracking -- */
const openTracking = guard(async (orderId) => {
  state.trackId = orderId;
  const res = await api.get(`/api/orders/${orderId}`);
  state.order = res.order;
  state.screen = 'track';
  state.rt?.subscribe(`order:${orderId}`);
  render();
});

function renderTracking() {
  const order = state.order;
  if (!order) { state.screen = 'home'; return render(); }
  const status = order.status;
  const isDelivery = order.service_kind === 'delivery';
  const steps = isDelivery
    ? [['searching', 'Пошук курʼєра'], ['assigned', 'Курʼєра призначено'], ['in_progress', 'Посилка в дорозі'], ['completed', 'Доставлено']]
    : [['searching', 'Пошук водія'], ['assigned', 'Водія призначено'], ['driver_arriving', 'Авто прибуває'], ['in_progress', 'У дорозі'], ['completed', 'Завершено']];
  const statusIndex = Math.max(0, steps.findIndex(([code]) => code === status));

  screenEl.innerHTML = `
    <div id="trackMap" style="height:210px"></div>
    <div class="card col tight">
      <div class="row between">
        <span class="pill ${STATUS_TONE[status] ?? 'grey'}">${STATUS_LABELS[status] ?? status}</span>
        <small class="muted">№${order.number} · ${dt(order.created_at)}</small>
      </div>
      <div class="col" style="gap:6px">
        ${steps.map(([code, label], i) => `
          <div class="row" style="gap:8px;opacity:${i <= statusIndex ? 1 : .45}">
            <span style="width:16px">${i <= statusIndex ? '●' : '○'}</span>
            <span style="font-size:13px">${label}</span>
          </div>`).join('')}
      </div>
      ${status === 'searching' || status === 'offered' ? '<div class="row"><div class="spinner"></div><small class="muted">Шукаємо виконавця поблизу…</small></div>' : ''}
      ${status === 'no_drivers' ? '<small class="muted">Вільних водіїв немає. Спробуйте збільшити ціну кнопкою «+50 ₴» або зачекайте.</small>' : ''}
    </div>

    ${order.driver ? `
      <div class="card col tight">
        <div class="row between">
          <div class="row" style="gap:10px">
            <div class="brand-mark" style="background:linear-gradient(135deg,#7c5cff,#2ee6a8)">${(order.driver.name || 'В')[0]}</div>
            <div>
              <div style="font-weight:600">${esc(order.driver.name ?? 'Водій')}</div>
              <small class="muted rating">★ ${order.driver.rating ?? '5.0'} · ${order.driver.orders_completed ?? 0} поїздок</small>
            </div>
          </div>
          <a class="btn sm" href="tel:${esc(order.driver.phone)}">📞</a>
        </div>
        ${order.vehicle ? `<div class="list-row"><span>🚘</span><div class="grow">${esc(order.vehicle.make)} ${esc(order.vehicle.model)} · ${esc(order.vehicle.color ?? '')}</div><b class="mono">${esc(order.vehicle.plate)}</b></div>` : ''}
      </div>` : ''}

    ${order.delivery ? `
      <div class="card col tight">
        <div class="label">Доставка</div>
        <div style="font-size:13px">${esc(order.delivery.description ?? '')}</div>
        <div class="row between"><small class="muted">Отримувач</small><span>${esc(order.delivery.recipient_name)} · ${esc(order.delivery.recipient_phone)}</span></div>
        <div class="row between"><small class="muted">Вага</small><span>${order.delivery.weight_kg} кг${order.delivery.declared_value_cents ? ` · ${money(order.delivery.declared_value_cents)}` : ''}</span></div>
        <div class="row between"><small class="muted">Код для курʼєра (відправник)</small><b class="mono">${esc(order.delivery.pickup_code)}</b></div>
        <div class="row between"><small class="muted">Код для отримувача</small><b class="mono">${esc(order.delivery.dropoff_code)}</b></div>
      </div>` : ''}

    <div class="card col tight">
      <div class="label">Маршрут</div>
      ${order.points.map((p, i) => `
        <div class="row" style="gap:8px">
          <span>${p.kind === 'pickup' ? '🟢' : p.kind === 'stop' ? '🟡' : '🟣'}</span>
          <div class="grow nowrap" style="font-size:13px">${esc(p.address)}</div>
          ${p.kind === 'stop' ? `<button class="btn sm danger" data-del-stop="${i}">✕</button>` : ''}
        </div>`).join('')}
      <div class="row between"><small class="muted">Відстань</small><span>${km(order.distance_m)}</span></div>
      <div class="row between"><small class="muted">Оплата</small><span>${esc(order.payment_method)}</span></div>
      <div class="row between"><b>Разом</b><b>${money(order.final_price_cents ?? order.quoted_price_cents)}</b></div>
    </div>
  `;

  const city = state.cities.find((c) => c.id === order.city_id);
  const map = new MapView($('#trackMap'), { center: { lat: city?.lat ?? 50.45, lng: city?.lng ?? 30.52 }, zoom: 1.8 });
  const markers = order.points.map((p, i) => ({ id: `p${i}`, lat: p.lat, lng: p.lng, kind: p.kind }));
  if (order.driver?.lat) markers.push({ id: 'driver', lat: order.driver.lat, lng: order.driver.lng, kind: 'driver', label: 'Водій' });
  map.setMarkers(markers);
  map.setRoute(order.points.filter((p) => p.kind !== 'stop' || true));
  map.fit(order.points, 1.8);
  state.map = map;

  screenEl.querySelectorAll('[data-del-stop]').forEach((btn) => {
    btn.onclick = guard(async () => {
      const points = order.points.filter((_, i) => i !== Number(btn.dataset.delStop))
        .map((p) => ({ address: p.address, lat: p.lat, lng: p.lng }));
      const res = await api.post(`/api/orders/${order.id}/route-change`, { points });
      toast(res.status === 'applied' ? 'Маршрут оновлено' : 'Запит надіслано водієві на підтвердження');
      state.order = (await api.get(`/api/orders/${order.id}`)).order;
      render();
    });
  });

  renderTrackFooter();
}

function renderTrackFooter() {
  const order = state.order;
  footerEl.classList.remove('hide');
  const canCancel = !['completed', 'canceled', 'expired'].includes(order.status);
  const canRate = order.status === 'completed' && !order.rating;
  footerEl.innerHTML = `
    <div class="row" style="gap:8px">
      <button class="btn grow" id="homeBtn">До мапи</button>
      ${canRate ? '<button class="btn primary grow" id="rateBtn">Оцінити</button>' : ''}
      ${canCancel ? '<button class="btn danger grow" id="cancelBtn">Скасувати</button>' : ''}
      ${order.status === 'completed' ? '<button class="btn violet grow" id="repeatBtn">Повторити</button>' : ''}
    </div>`;
  $('#homeBtn').onclick = () => { state.screen = 'home'; state.trackId = null; render(); };
  if ($('#cancelBtn')) {
    $('#cancelBtn').onclick = guard(async () => {
      if (!confirm('Скасувати замовлення?')) return;
      const res = await api.post(`/api/orders/${order.id}/cancel`, { reason: 'Скасовано пасажиром' });
      toast(res.cancelFeeCents ? `Скасовано. Утримано ${money(res.cancelFeeCents)}` : 'Замовлення скасовано');
      state.order = res.order;
      await loadOrders();
      render();
    });
  }
  if ($('#rateBtn')) $('#rateBtn').onclick = () => openRating(order.id);
  if ($('#repeatBtn')) {
    $('#repeatBtn').onclick = guard(async () => {
      const res = await api.post(`/api/orders/${order.id}/repeat`, {});
      state.route = {
        pickup: res.prefill.points[0],
        dropoff: res.prefill.points.at(-1),
        stops: res.prefill.points.slice(1, -1),
      };
      state.classId = res.prefill.classId;
      state.options = res.prefill.options;
      state.payment = res.prefill.paymentMethod;
      state.screen = 'home';
      state.trackId = null;
      await refreshQuotes();
      render();
      toast('Маршрут відновлено — підтвердіть замовлення');
    });
  }
}

function openRating(orderId) {
  const overlay = el(`
    <div class="overlay"><div class="sheet">
      <h3 style="margin:0">Оцініть поїздку</h3>
      <div class="row" id="stars" style="gap:8px;font-size:26px">${[1, 2, 3, 4, 5].map((n) => `<span data-star="${n}" style="cursor:pointer">★</span>`).join('')}</div>
      <textarea class="textarea" id="reviewText" placeholder="Коментар (необовʼязково)"></textarea>
      <div class="row"><button class="btn ghost grow" data-close>Пізніше</button><button class="btn primary grow" id="sendReview">Надіслати</button></div>
    </div></div>`);
  $('#app').appendChild(overlay);
  let stars = 5;
  const paint = () => overlay.querySelectorAll('[data-star]').forEach((s) => {
    s.style.color = Number(s.dataset.star) <= stars ? '#ffb545' : '#3a4556';
  });
  paint();
  overlay.querySelectorAll('[data-star]').forEach((s) => {
    s.onclick = () => { stars = Number(s.dataset.star); paint(); };
  });
  overlay.querySelector('[data-close]').onclick = () => overlay.remove();
  overlay.querySelector('#sendReview').onclick = guard(async () => {
    await api.post(`/api/orders/${orderId}/rate`, { rating: stars, text: overlay.querySelector('#reviewText').value.trim() || null });
    overlay.remove();
    toast('Дякуємо за відгук!');
    state.order = (await api.get(`/api/orders/${orderId}`)).order;
    render();
  });
}

/* ---------------------------------------------------------------- history -- */
function renderHistory() {
  screenEl.innerHTML = `
    <h1>Історія</h1>
    ${state.activeOrders.length ? `<div class="card tight col">
      <div class="label">Активні (${state.activeOrders.length}/5)</div>
      ${state.activeOrders.map((o) => `<div class="list-row" data-open="${o.id}">
        <span class="pill ${STATUS_TONE[o.status]}">${STATUS_LABELS[o.status]}</span>
        <div class="grow nowrap">№${o.number} · ${money(o.quoted_price_cents)}</div><span>→</span></div>`).join('')}
    </div>` : ''}
    <div class="col" style="gap:8px">
      ${state.history.length ? state.history.map((o) => `
        <div class="card tight col" style="gap:6px">
          <div class="row between">
            <span class="pill ${STATUS_TONE[o.status]}">${STATUS_LABELS[o.status] ?? o.status}</span>
            <small class="muted">${dt(o.created_at)} · №${o.number}</small>
          </div>
          <div style="font-size:13px">${esc(o.points[0]?.address ?? '')} → ${esc(o.points.at(-1)?.address ?? '')}</div>
          <div class="row between">
            <small class="muted">${km(o.distance_m)} · ${esc(o.service_kind)}</small>
            <b>${money(o.final_price_cents ?? o.quoted_price_cents)}</b>
          </div>
          <div class="row" style="gap:6px">
            ${o.status === 'completed' && !o.rating ? `<button class="btn sm" data-rate="${o.id}">Оцінити</button>` : ''}
            <button class="btn sm" data-repeat="${o.id}">Повторити</button>
            <button class="btn sm ghost" data-open="${o.id}">Деталі</button>
          </div>
        </div>`).join('') : '<small class="muted">Поки що немає завершених замовлень</small>'}
    </div>`;
  footerEl.classList.add('hide');
  screenEl.querySelectorAll('[data-open]').forEach((n) => { n.onclick = () => openTracking(n.dataset.open); });
  screenEl.querySelectorAll('[data-rate]').forEach((n) => { n.onclick = () => openRating(n.dataset.rate); });
  screenEl.querySelectorAll('[data-repeat]').forEach((n) => {
    n.onclick = guard(async () => {
      const res = await api.post(`/api/orders/${n.dataset.repeat}/repeat`, {});
      state.route = { pickup: res.prefill.points[0], dropoff: res.prefill.points.at(-1), stops: res.prefill.points.slice(1, -1) };
      state.classId = res.prefill.classId;
      state.screen = 'home'; state.tab = 'home';
      await refreshQuotes();
      render();
    });
  });
}

/* ---------------------------------------------------------------- profile -- */
function renderProfile() {
  const user = state.user ?? {};
  screenEl.innerHTML = `
    <h1>Профіль</h1>
    <div class="card col tight">
      <div class="row" style="gap:10px">
        <div class="brand-mark" style="width:44px;height:44px;border-radius:14px">${(user.name || user.phone || 'Р')[0]}</div>
        <div class="grow">
          <div style="font-weight:600">${esc(user.name || 'Без імені')}</div>
          <small class="muted">${esc(user.phone ?? '')} · ${esc(user.role ?? '')}</small>
        </div>
      </div>
      <div class="row" style="gap:8px">
        <input class="input" id="profileName" placeholder="Ваше імʼя" value="${esc(user.name ?? '')}" />
        <button class="btn sm" id="saveName">Зберегти</button>
      </div>
      <div class="row between">
        <div><div class="label">Баланс</div><b>${money(state.wallet.balance)}</b></div>
        <div><div class="label">Бонуси</div><b>${money(state.wallet.bonus)}</b></div>
        <button class="btn sm primary" id="topupBtn">Поповнити</button>
      </div>
    </div>

    <div class="card col tight">
      <div class="row between"><div class="label">Мої адреси</div>
        <button class="btn sm ghost" id="manageAddr">Керувати</button></div>
      ${state.addresses.length ? state.addresses.map((a) => `<div class="row between" style="font-size:13px">
        <span>⭐ ${esc(a.label)}</span><small class="muted nowrap" style="max-width:60%">${esc(a.address)}</small></div>`).join('')
        : '<small class="muted">Немає збережених адрес</small>'}
    </div>

    <div class="card col tight">
      <div class="row between"><div class="label">Підтримка 24/7</div>
        <button class="btn sm" id="supportBtn">Написати</button></div>
      <small class="muted">Середній час відповіді — 3 хвилини</small>
    </div>

    <div class="card col tight">
      <div class="label">Сповіщення</div>
      <div class="list">
        ${state.notifications.slice(0, 6).map((n) => `<div class="list-row">
          <span>🔔</span><div class="grow"><div style="font-size:13px">${esc(n.title)}</div>
          <small class="muted">${esc(n.body)}</small></div></div>`).join('') || '<small class="muted">Порожньо</small>'}
      </div>
    </div>

    <div class="card col tight">
      <div class="label">Місто</div>
      <select class="select" id="citySelect">
        ${state.cities.map((c) => `<option value="${c.id}" ${c.id === state.cityId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
    </div>
  `;
  footerEl.classList.add('hide');
  $('#saveName').onclick = guard(async () => {
    const name = $('#profileName').value.trim();
    await api.patch('/api/me', { name });
    await refreshMe();
    toast('Збережено');
    render();
  });
  $('#manageAddr').onclick = () => openSavedAddresses();
  $('#topupBtn').onclick = openTopup;
  $('#supportBtn').onclick = openSupport;
  $('#citySelect').onchange = guard(async (e) => {
    await api.patch('/api/me', { cityId: e.target.value });
    state.cityId = e.target.value;
    await loadCatalog();
    state.classId = null;
    toast(`Місто: ${cityName(state.cityId)}`);
    render();
  });
}

function openTopup() {
  const overlay = el(`
    <div class="overlay"><div class="sheet col">
      <h3 style="margin:0">Поповнення балансу</h3>
      <div class="row wrap">${[10000, 20000, 50000].map((v) => `<button class="chip" data-amount="${v}">${money(v)}</button>`).join('')}</div>
      <input class="input" id="topupAmount" type="number" min="50" step="50" value="200" placeholder="Сума, ₴" />
      <button class="btn primary" id="doTopup">Поповнити</button>
      <button class="btn ghost" data-close>Скасувати</button>
    </div></div>`);
  $('#app').appendChild(overlay);
  overlay.querySelector('[data-close]').onclick = () => overlay.remove();
  overlay.querySelectorAll('[data-amount]').forEach((b) => {
    b.onclick = () => { overlay.querySelector('#topupAmount').value = b.dataset.amount / 100; };
  });
  overlay.querySelector('#doTopup').onclick = guard(async () => {
    const amount = Math.round(Number(overlay.querySelector('#topupAmount').value) * 100);
    await api.post('/api/wallet/topup', { amountCents: amount, idempotencyKey: `topup_${Date.now()}` });
    overlay.remove();
    await refreshWallet();
    toast('Баланс поповнено');
    render();
  });
}

function openSupport() {
  const overlay = el(`
    <div class="overlay"><div class="sheet col">
      <h3 style="margin:0">Підтримка</h3>
      <input class="input" id="ticketSubject" placeholder="Тема звернення" />
      <textarea class="textarea" id="ticketMessage" placeholder="Опишіть ситуацію"></textarea>
      <button class="btn primary" id="sendTicket">Надіслати</button>
      <button class="btn ghost" data-close>Скасувати</button>
    </div></div>`);
  $('#app').appendChild(overlay);
  overlay.querySelector('[data-close]').onclick = () => overlay.remove();
  overlay.querySelector('#sendTicket').onclick = guard(async () => {
    await api.post('/api/support/tickets', {
      subject: overlay.querySelector('#ticketSubject').value.trim() || 'Звернення',
      message: overlay.querySelector('#ticketMessage').value.trim(),
      orderId: state.order?.id ?? null,
    });
    overlay.remove();
    toast('Звернення створено');
  });
}

/* ------------------------------------------------------------------- tabs -- */
function renderTabbar() {
  if (state.screen === 'auth') { tabbarEl.innerHTML = ''; return; }
  const tabs = [['home', '🗺️', 'Замовити'], ['history', '🧾', 'Історія'], ['profile', '👤', 'Профіль']];
  tabbarEl.innerHTML = tabs.map(([code, ico, label]) => `
    <div class="tab ${state.tab === code ? 'active' : ''}" data-tab="${code}">
      <span class="tab-ico">${ico}</span>${label}</div>`).join('');
  tabbarEl.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.onclick = () => {
      state.tab = tab.dataset.tab;
      state.screen = tab.dataset.tab;
      render();
    };
  });
}

/* ----------------------------------------------------------------- render -- */
function render() {
  if (!token.get() || state.screen === 'auth') { renderAuth(); return; }
  if (state.screen === 'track') { renderTracking(); renderTabbar(); return; }
  if (state.screen === 'history' || state.tab === 'history') { renderHistory(); renderTabbar(); return; }
  if (state.screen === 'profile' || state.tab === 'profile') { renderProfile(); renderTabbar(); return; }
  renderHome();
  renderTabbar();
}

$('#logoutBtn').onclick = () => {
  token.clear();
  state.rt?.close();
  location.reload();
};
$('#walletBtn').onclick = () => { state.tab = 'profile'; state.screen = 'profile'; render(); };

window.addEventListener('resize', () => state.map?.render?.());
boot();
