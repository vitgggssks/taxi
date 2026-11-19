/* РУХ — admin panel. Every widget talks to the real API. */
import {
  $, $$, api, dt, el, esc, guard, money, Realtime,
  STATUS_LABELS, STATUS_TONE, toast, token, time,
} from './api.js';
import { MapView } from './map.js';

const state = {
  user: null,
  section: 'dashboard',
  cities: [],
  classes: [],
  citiesLoaded: false,
  liveMap: null,
  liveTimer: null,
  rt: null,
  cache: {},
};

const NAV = [
  ['dashboard', '📊', 'Дашборд'],
  ['map', '🗺️', 'Live-мапа'],
  ['orders', '🧾', 'Замовлення'],
  ['drivers', '🚕', 'Водії'],
  ['users', '👥', 'Користувачі'],
  ['tariffs', '💲', 'Тарифи'],
  ['catalog', '🧩', 'Класи та опції'],
  ['geo', '📍', 'Міста та зони'],
  ['promos', '🎟️', 'Промокоди'],
  ['payments', '💰', 'Платежі'],
  ['corporate', '🏢', 'Корпоративні'],
  ['support', '🎧', 'Підтримка'],
  ['reviews', '⭐', 'Відгуки'],
  ['quests', '🎯', 'Завдання'],
  ['reports', '📈', 'Звіти'],
  ['audit', '🕵️', 'Аудит'],
  ['settings', '⚙️', 'Налаштування'],
];

/* ------------------------------------------------------------------- boot -- */
async function boot() {
  if (!token.get()) return renderLogin();
  try {
    state.user = await api.get('/api/me');
    if (!['admin', 'dispatcher'].includes(state.user.role)) {
      $('#view').innerHTML = `<div class="card">Потрібна роль адміністратора або диспетчера. Ви увійшли як <b>${esc(state.user.role)}</b>.
        <div style="margin-top:12px"><button class="btn" id="switchBtn">Увійти як адміністратор</button></div></div>`;
      $('#switchBtn').onclick = guard(async () => {
        const res = await api.post('/api/auth/demo-login', { role: 'admin' });
        token.set(res.token);
        location.reload();
      });
      return;
    }
    state.cities = (await api.get('/api/cities')).items;
    state.classes = (await api.get('/api/catalog?cityId=city_kyiv')).classes;
    state.citiesLoaded = true;
    connectRealtime();
    renderNav();
    router();
  } catch {
    token.clear();
    renderLogin();
  }
}

function connectRealtime() {
  state.rt = new Realtime((msg) => {
    if (msg.event === 'order.updated' || msg.event === 'notification') {
      if (state.section === 'map') refreshLiveMap();
      if (['dashboard', 'orders'].includes(state.section)) renderSection();
    }
    if (msg.event === 'driver.location' && state.section === 'map') refreshLiveMap();
  });
  state.rt.connect();
  state.rt.subscribe('role:dispatch');
}

function renderLogin() {
  $('#sidebar').classList.add('hide');
  $('#pageActions').innerHTML = '';
  $('#view').innerHTML = `
    <div class="card col" style="max-width:420px">
      <h2>Вхід в адмінпанель</h2>
      <div class="field"><label class="label">Телефон</label>
        <input class="input" id="phone" value="+380500000001" /></div>
      <div class="field hide" id="codeField"><label class="label">Код</label>
        <input class="input" id="code" /><small class="muted" id="hint"></small></div>
      <button class="btn primary" id="loginBtn">Отримати код</button>
      <div class="divider"></div>
      <button class="btn" id="demoBtn">Демо-вхід як адміністратор</button>
    </div>`;
  let stage = 'phone';
  $('#loginBtn').onclick = guard(async () => {
    const phone = $('#phone').value.trim();
    if (stage === 'phone') {
      const res = await api.post('/api/auth/request-otp', { phone });
      stage = 'code';
      $('#codeField').classList.remove('hide');
      $('#code').value = res.demoCode;
      $('#hint').textContent = `Демо-код: ${res.demoCode}`;
      $('#loginBtn').textContent = 'Увійти';
      return;
    }
    const res = await api.post('/api/auth/verify-otp', { phone, code: $('#code').value.trim() });
    token.set(res.token);
    location.reload();
  });
  $('#demoBtn').onclick = guard(async () => {
    const res = await api.post('/api/auth/demo-login', { role: 'admin' });
    token.set(res.token);
    location.reload();
  });
}

/* ------------------------------------------------------------------- nav --- */
function renderNav() {
  $('#nav').innerHTML = NAV.map(([code, ico, label]) => `
    <div class="nav-item ${state.section === code ? 'active' : ''}" data-section="${code}">
      <span class="nav-ico">${ico}</span>${label}</div>`).join('');
  $$('#nav [data-section]').forEach((item) => {
    item.onclick = () => {
      state.section = item.dataset.section;
      location.hash = `#${state.section}`;
      renderNav();
      renderSection();
    };
  });
}

const titles = Object.fromEntries(NAV.map(([code, , label]) => [code, label]));

function router() {
  const hash = location.hash.replace('#', '');
  if (hash && titles[hash]) state.section = hash;
  renderNav();
  renderSection();
}

function renderSection() {
  clearInterval(state.liveTimer);
  state.liveTimer = null;
  $('#pageTitle').textContent = titles[state.section] ?? 'Дашборд';
  $('#pageActions').innerHTML = '';
  const view = $('#view');
  view.innerHTML = '<div class="row" style="padding:20px"><div class="spinner"></div></div>';
  const render = {
    dashboard: renderDashboard, map: renderMap, orders: renderOrders, drivers: renderDrivers,
    users: renderUsers, tariffs: renderTariffs, catalog: renderCatalog, geo: renderGeo,
    promos: renderPromos, payments: renderPayments, corporate: renderCorporate,
    support: renderSupport, reviews: renderReviews, quests: renderQuests,
    reports: renderReports, audit: renderAudit, settings: renderSettings,
  }[state.section];
  (render ?? renderDashboard)();
}

/* -------------------------------------------------------------- dashboard -- */
const renderDashboard = guard(async () => {
  const cityId = state.cache.dashCity ?? '';
  const data = await api.get(`/api/admin/dashboard${cityId ? `?cityId=${cityId}` : ''}`);
  $('#pageActions').innerHTML = `
    <select class="select" id="dashCity" style="width:200px">
      <option value="">Усі міста</option>
      ${state.cities.map((c) => `<option value="${c.id}" ${cityId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select>
    <button class="btn sm" id="refreshBtn">↻ Оновити</button>`;
  $('#dashCity').onchange = (e) => { state.cache.dashCity = e.target.value; renderSection(); };
  $('#refreshBtn').onclick = () => renderSection();

  const maxGross = Math.max(1, ...data.revenue7d.map((r) => Number(r.gross)));
  $('#view').innerHTML = `
    <div class="grid c4">
      <div class="card"><div class="kpi-label">Замовлень сьогодні</div><div class="kpi-value">${data.today.orders}</div>
        <small class="muted">завершено: ${data.today.completed}</small></div>
      <div class="card"><div class="kpi-label">Виторг сьогодні</div><div class="kpi-value">${money(data.today.grossCents)}</div>
        <small class="muted">скасувань 7д: ${data.cancellations7d}</small></div>
      <div class="card"><div class="kpi-label">Активні замовлення</div><div class="kpi-value">${data.activeOrders}</div>
        <small class="muted">водіїв на лінії: ${data.onlineDrivers}</small></div>
      <div class="card"><div class="kpi-label">Рейтинг сервісу</div><div class="kpi-value">${data.avgRating ?? '—'}</div>
        <small class="muted">на перевірці: ${data.pendingDrivers} · звернень: ${data.openTickets}</small></div>
    </div>

    <div class="grid c2" style="margin-top:14px">
      <div class="card">
        <h3>Виторг, 7 днів</h3>
        <div class="row" style="align-items:flex-end;gap:8px;height:150px">
          ${data.revenue7d.length ? data.revenue7d.map((r) => `
            <div style="flex:1;text-align:center">
              <div style="height:${Math.max(6, (Number(r.gross) / maxGross) * 110)}px;background:linear-gradient(180deg,#c8ff3d,#2ee6a8);border-radius:6px"></div>
              <small class="muted" style="font-size:10px">${String(r.day).slice(5)}</small>
              <div style="font-size:10px">${money(r.gross)}</div>
            </div>`).join('') : '<small class="muted">Немає даних</small>'}
        </div>
      </div>
      <div class="card">
        <h3>Міста</h3>
        <table class="table"><thead><tr><th>Місто</th><th>Поїздки</th><th>Виторг</th></tr></thead><tbody>
          ${data.byCity.map((c) => `<tr><td>${esc(c.city)}</td><td>${c.orders}</td><td>${money(c.gross)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <h3>Класи авто</h3>
        <table class="table"><thead><tr><th>Клас</th><th>Поїздки</th></tr></thead><tbody>
          ${data.byClass.map((c) => `<tr><td>${esc(c.class)}</td><td>${c.orders}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <h3>Швидкі дії</h3>
        <div class="col">
          <button class="btn" data-goto="drivers">Перевірити документи водіїв (${data.pendingDrivers})</button>
          <button class="btn" data-goto="support">Відкриті звернення (${data.openTickets})</button>
          <button class="btn" data-goto="orders">Активні замовлення (${data.activeOrders})</button>
          <button class="btn" data-goto="tariffs">Керувати тарифами</button>
        </div>
      </div>
    </div>`;
  $$('[data-goto]').forEach((b) => { b.onclick = () => { state.section = b.dataset.goto; renderNav(); renderSection(); }; });
});

/* ---------------------------------------------------------------- live map -- */
const renderMap = guard(async () => {
  $('#pageActions').innerHTML = '<button class="btn sm" id="refreshMap">↻</button>';
  $('#view').innerHTML = `
    <div class="grid" style="grid-template-columns:2fr 1fr;gap:14px">
      <div id="adminMap" style="height:620px"></div>
      <div class="col">
        <div class="card tight"><div class="kpi-label">На лінії</div><div class="kpi-value" id="drvCount">0</div></div>
        <div class="card tight"><div class="kpi-label">Активні замовлення</div><div class="kpi-value" id="ordCount">0</div></div>
        <div class="card col tight" style="max-height:440px;overflow:auto"><div class="label">Водії</div><div id="drvList" class="list"></div></div>
      </div>
    </div>`;
  $('#refreshMap').onclick = () => refreshLiveMap();
  refreshLiveMap();
  state.liveTimer = setInterval(refreshLiveMap, 4000);
});

const refreshLiveMap = guard(async () => {
  const data = await api.get('/api/admin/live-map');
  const city = state.cities[0] ?? { lat: 50.45, lng: 30.52 };
  if (!$('#adminMap')) return;
  if (!state.liveMap) {
    state.liveMap = new MapView($('#adminMap'), { center: { lat: city.lat, lng: city.lng }, zoom: 1.2 });
  }
  const markers = [
    ...data.drivers.filter((d) => d.lat).map((d) => ({
      id: `d-${d.user_id}`, lat: d.lat, lng: d.lng, kind: 'driver',
      label: `${d.name}${d.plate ? ` · ${d.plate}` : ''}`,
      color: d.work_status === 'busy' ? '#ffb545' : '#2ee6a8',
    })),
    ...data.orders.flatMap((o) => (o.points ?? []).map((p, i) => ({
      id: `o-${o.id}-${i}`, lat: p.lat, lng: p.lng, kind: p.kind === 'pickup' ? 'pickup' : 'dropoff',
    }))),
  ];
  state.liveMap.setMarkers(markers);
  $('#drvCount').textContent = data.drivers.length;
  $('#ordCount').textContent = data.orders.length;
  $('#drvList').innerHTML = data.drivers.map((d) => `
    <div class="list-row"><span>${d.work_status === 'busy' ? '🟠' : '🟢'}</span>
      <div class="grow nowrap" style="font-size:13px">${esc(d.name)}<br><small class="muted">${esc(d.plate ?? '')} · ★ ${d.rating ?? '—'}</small></div>
    </div>`).join('') || '<small class="muted">Немає водіїв на лінії</small>';
});

/* ----------------------------------------------------------------- orders -- */
const renderOrders = guard(async () => {
  const status = state.cache.orderStatus ?? '';
  const data = await api.get(`/api/admin/orders${status ? `?status=${status}&limit=200` : '?limit=200'}`);
  $('#pageActions').innerHTML = `
    <select class="select" id="statusFilter" style="width:220px">
      <option value="">Усі статуси</option>
      ${['searching', 'offered', 'assigned', 'driver_arriving', 'waiting', 'in_progress', 'completed', 'canceled', 'no_drivers']
        .map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
    </select>
    <button class="btn sm" id="csvOrders">⤓ CSV</button>`;
  $('#statusFilter').onchange = (e) => { state.cache.orderStatus = e.target.value; renderSection(); };
  $('#csvOrders').onclick = () => downloadCsv('/api/admin/reports/orders.csv');

  $('#view').innerHTML = `
    <div class="card" style="overflow:auto">
      <table class="table">
        <thead><tr><th>№</th><th>Створено</th><th>Статус</th><th>Маршрут</th><th>Клас</th><th>Оплата</th><th>Сума</th><th>Водій</th><th></th></tr></thead>
        <tbody>
        ${data.items.map((o) => `<tr>
          <td class="mono">${esc(o.number)}</td>
          <td>${dt(o.created_at)}</td>
          <td><span class="pill ${STATUS_TONE[o.status] ?? 'grey'}">${STATUS_LABELS[o.status] ?? o.status}</span></td>
          <td style="max-width:280px" class="nowrap">${esc(o.points[0]?.address ?? '')} → ${esc(o.points.at(-1)?.address ?? '')}</td>
          <td>${esc(state.classes.find((c) => c.id === o.class_id)?.name ?? o.class_id)}</td>
          <td>${esc(o.payment_method)}<br><small class="muted">${esc(o.payment_status)}</small></td>
          <td><b>${money(o.final_price_cents ?? o.quoted_price_cents)}</b></td>
          <td>${esc(o.driver?.name ?? '—')}</td>
          <td class="row" style="gap:4px">
            ${['searching', 'no_drivers', 'offered', 'assigned'].includes(o.status)
              ? `<button class="btn sm" data-assign="${o.id}">Призначити</button>` : ''}
            ${['completed', 'canceled'].includes(o.status) || o.payment_status !== 'paid' ? ''
              : `<button class="btn sm danger" data-refund="${o.id}">Повернути</button>`}
            ${['completed', 'canceled'].includes(o.status) ? ''
              : `<button class="btn sm danger" data-cancel="${o.id}">✕</button>`}
          </td>
        </tr>`).join('') || '<tr><td colspan="9" class="muted">Немає замовлень</td></tr>'}
        </tbody>
      </table>
    </div>`;

  $$('[data-cancel]').forEach((btn) => {
    btn.onclick = guard(async () => {
      const reason = prompt('Причина скасування', 'Скасовано диспетчером');
      if (reason === null) return;
      await api.post(`/api/admin/orders/${btn.dataset.cancel}/cancel`, { reason });
      toast('Замовлення скасовано');
      renderSection();
    });
  });
  $$('[data-refund]').forEach((btn) => {
    btn.onclick = guard(async () => {
      const reason = prompt('Причина повернення', 'Повернення коштів');
      if (reason === null) return;
      const res = await api.post(`/api/admin/orders/${btn.dataset.refund}/refund`, { reason });
      toast(`Повернено ${money(res.refundedCents)}`);
      renderSection();
    });
  });
  $$('[data-assign]').forEach((btn) => {
    btn.onclick = () => openAssignDialog(btn.dataset.assign);
  });
});

const openAssignDialog = guard(async (orderId) => {
  const live = await api.get('/api/admin/live-map');
  const overlay = el(`<div class="overlay" style="position:fixed">
    <div class="sheet" style="max-width:520px;border-radius:16px">
      <div class="row between"><h3 style="margin:0">Призначити водія</h3><button class="btn sm ghost" data-close>✕</button></div>
      <div class="list" id="driversPick">
        ${live.drivers.map((d) => `<div class="list-row" data-driver="${d.user_id}">
          <span>${d.work_status === 'busy' ? '🟠' : '🟢'}</span>
          <div class="grow">${esc(d.name)}<br><small class="muted">${esc(d.plate ?? '')}</small></div>
          <span class="muted">→</span></div>`).join('') || '<small class="muted">Немає водіїв онлайн</small>'}
      </div>
    </div></div>`);
  document.body.appendChild(overlay);
  overlay.querySelector('[data-close]').onclick = () => overlay.remove();
  overlay.querySelectorAll('[data-driver]').forEach((row) => {
    row.onclick = guard(async () => {
      await api.post(`/api/internal/orders/${orderId}/assign`, { driverId: row.dataset.driver });
      overlay.remove();
      toast('Водія призначено');
      renderSection();
    });
  });
});

/* ---------------------------------------------------------------- drivers -- */
const renderDrivers = guard(async () => {
  const [pending, all] = await Promise.all([
    api.get('/api/admin/drivers/pending'),
    api.get('/api/admin/users?role=driver'),
  ]);
  $('#view').innerHTML = `
    <div class="grid c2">
      <div class="card">
        <h3>На перевірці (${pending.items.length})</h3>
        <div class="col">
          ${pending.items.map((d) => `<div class="card tight col" style="gap:6px">
            <div class="row between"><b>${esc(d.name ?? d.user_id)}</b>
              <span class="pill ${d.status === 'pending' ? 'amber' : 'red'}">${d.status}</span></div>
            <small class="muted">${esc(d.phone ?? '')} · класи: ${esc(d.classes_csv || '—')}</small>
            <div class="row wrap">${d.vehicles.map((v) => `<span class="tag">${esc(v.make)} ${esc(v.model)} · ${esc(v.plate)}</span>`).join('')}</div>
            <div class="row wrap">${d.documents.map((doc) => `<span class="tag">${esc(doc.type)}: ${esc(doc.status)}</span>`).join('')}</div>
            <div class="row" style="gap:6px">
              <button class="btn sm primary" data-approve="${d.user_id}">Схвалити</button>
              <button class="btn sm danger" data-reject="${d.user_id}">Відхилити</button>
            </div>
          </div>`).join('') || '<small class="muted">Черга порожня</small>'}
        </div>
      </div>
      <div class="card" style="overflow:auto;max-height:640px">
        <h3>Усі водії (${all.items.length})</h3>
        <table class="table"><thead><tr><th>Водій</th><th>Телефон</th><th>Статус</th><th>Замовлень</th><th></th></tr></thead>
        <tbody>${all.items.map((u) => `<tr>
          <td>${esc(u.name ?? '—')}</td><td class="mono">${esc(u.phone)}</td>
          <td><span class="pill ${u.status === 'blocked' ? 'red' : 'green'}">${esc(u.status)}</span></td>
          <td>${u.driver_orders}</td>
          <td><button class="btn sm ${u.status === 'blocked' ? '' : 'danger'}" data-block="${u.id}" data-blocked="${u.status === 'blocked'}">
            ${u.status === 'blocked' ? 'Розблокувати' : 'Блокувати'}</button></td>
        </tr>`).join('')}</tbody></table>
      </div>
    </div>`;

  $$('[data-approve]').forEach((b) => {
    b.onclick = guard(async () => {
      await api.post(`/api/admin/drivers/${b.dataset.approve}/verify`, { approve: true });
      toast('Водія верифіковано');
      renderSection();
    });
  });
  $$('[data-reject]').forEach((b) => {
    b.onclick = guard(async () => {
      const reason = prompt('Причина відхилення', 'Документи нерозбірливі');
      if (reason === null) return;
      await api.post(`/api/admin/drivers/${b.dataset.reject}/verify`, { approve: false, reason });
      toast('Заявку відхилено');
      renderSection();
    });
  });
  $$('[data-block]').forEach((b) => {
    b.onclick = guard(async () => {
      await api.post(`/api/admin/drivers/${b.dataset.block}/block`, { blocked: b.dataset.blocked !== 'true' });
      renderSection();
    });
  });
});

/* ------------------------------------------------------------------ users -- */
const renderUsers = guard(async () => {
  const q = state.cache.userQuery ?? '';
  const data = await api.get(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#pageActions').innerHTML = `<input class="input" id="userSearch" placeholder="Пошук за телефоном/імʼям" value="${esc(q)}" style="width:240px" />`;
  $('#userSearch').onkeydown = (e) => {
    if (e.key === 'Enter') { state.cache.userQuery = e.target.value.trim(); renderSection(); }
  };
  $('#view').innerHTML = `<div class="card" style="overflow:auto"><table class="table">
    <thead><tr><th>Користувач</th><th>Телефон</th><th>Роль</th><th>Замовлень</th><th>Статус</th><th></th></tr></thead>
    <tbody>${data.items.map((u) => `<tr>
      <td>${esc(u.name ?? '—')}</td><td class="mono">${esc(u.phone)}</td>
      <td><span class="pill blue">${esc(u.role)}</span></td>
      <td>${u.orders}</td>
      <td><span class="pill ${u.status === 'blocked' ? 'red' : 'green'}">${esc(u.status)}</span></td>
      <td class="row" style="gap:4px">
        <select class="select" style="width:auto;padding:4px 8px" data-role="${u.id}">
          ${['passenger', 'driver', 'dispatcher', 'admin'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
        <button class="btn sm" data-block="${u.id}" data-blocked="${u.status === 'blocked'}">${u.status === 'blocked' ? 'Розблокувати' : 'Блокувати'}</button>
      </td></tr>`).join('')}</tbody></table></div>`;
  $$('[data-block]').forEach((b) => {
    b.onclick = guard(async () => {
      await api.post(`/api/admin/users/${b.dataset.block}/block`, { blocked: b.dataset.blocked !== 'true' });
      renderSection();
    });
  });
  $$('[data-role]').forEach((sel) => {
    sel.onchange = guard(async () => {
      await api.post(`/api/admin/users/${sel.dataset.role}/role`, { role: sel.value });
      toast('Роль змінено');
    });
  });
});

/* ---------------------------------------------------------------- tariffs -- */
const renderTariffs = guard(async () => {
  const cityId = state.cache.tariffCity ?? state.cities[0]?.id;
  const data = await api.get(`/api/admin/tariffs?cityId=${cityId}`);
  $('#pageActions').innerHTML = `
    <select class="select" id="tariffCity" style="width:200px">
      ${state.cities.map((c) => `<option value="${c.id}" ${c.id === cityId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select>`;
  $('#tariffCity').onchange = (e) => { state.cache.tariffCity = e.target.value; renderSection(); };

  $('#view').innerHTML = `<div class="card" style="overflow:auto"><table class="table">
    <thead><tr><th>Клас</th><th>Посадка ₴</th><th>За км ₴</th><th>За хв ₴</th><th>Мінімум ₴</th><th>Зупинка ₴</th><th>Ніч ×</th><th>Комісія %</th><th>Міжмісто ₴/км</th><th></th></tr></thead>
    <tbody>${data.items.map((t) => `<tr data-tariff="${t.id}">
      <td><b>${esc(t.class_name)}</b></td>
      ${['base_cents', 'per_km_cents', 'per_min_cents', 'min_fare_cents', 'per_stop_cents'].map((f) => `
        <td><input class="input" style="width:84px;padding:6px" data-field="${f}" value="${Math.round(t[f] / 100)}" /></td>`).join('')}
      <td><input class="input" style="width:66px;padding:6px" data-field="night_multiplier" value="${t.night_multiplier}" /></td>
      <td><input class="input" style="width:66px;padding:6px" data-field="commission_pct" value="${t.commission_pct}" /></td>
      <td><input class="input" style="width:80px;padding:6px" data-field="intercity_per_km_cents"
        value="${t.intercity_per_km_cents ? Math.round(t.intercity_per_km_cents / 100) : ''}" /></td>
      <td><button class="btn sm primary" data-save="${t.id}">Зберегти</button></td>
    </tr>`).join('')}</tbody></table></div>`;

  $$('[data-save]').forEach((btn) => {
    btn.onclick = guard(async () => {
      const row = btn.closest('tr');
      const payload = {};
      row.querySelectorAll('[data-field]').forEach((input) => {
        const field = input.dataset.field;
        const value = input.value.trim();
        if (value === '') return;
        payload[field] = ['night_multiplier', 'commission_pct'].includes(field) ? Number(value) : Math.round(Number(value) * 100);
      });
      await api.patch(`/api/admin/tariffs/${btn.dataset.save}`, payload);
      toast('Тариф оновлено — ціни застосовуються одразу');
    });
  });
});

/* ---------------------------------------------------------------- catalog -- */
const renderCatalog = guard(async () => {
  const [classes, options] = await Promise.all([api.get('/api/admin/classes'), api.get('/api/admin/options')]);
  $('#view').innerHTML = `
    <div class="grid c2">
      <div class="card">
        <h3>Класи авто</h3>
        <table class="table"><thead><tr><th>Код</th><th>Назва</th><th>Тип</th><th>Місць</th><th>Активний</th></tr></thead>
        <tbody>${classes.items.map((c) => `<tr>
          <td class="mono">${esc(c.code)}</td><td>${c.icon ?? ''} ${esc(c.name)}</td><td>${esc(c.kind)}</td>
          <td>${c.seats}</td>
          <td><input type="checkbox" data-class-active="${c.id}" ${c.active ? 'checked' : ''} /></td>
        </tr>`).join('')}</tbody></table>
        <div class="divider"></div>
        <div class="col" style="gap:8px">
          <div class="label">Новий клас</div>
          <div class="row"><input class="input" id="newClassCode" placeholder="код (латиниця)" />
            <input class="input" id="newClassName" placeholder="назва" /></div>
          <div class="row"><input class="input" id="newClassSeats" type="number" value="4" placeholder="місць" />
            <button class="btn primary" id="createClass">Створити</button></div>
          <small class="muted">Тариф автоматично клонується для всіх міст.</small>
        </div>
      </div>
      <div class="card">
        <h3>Опції замовлення</h3>
        <table class="table"><thead><tr><th>Назва</th><th>Ціна ₴</th><th>Класи</th><th>Активна</th></tr></thead>
        <tbody>${options.items.map((o) => `<tr>
          <td>${esc(o.name)}<br><small class="muted">${esc(o.code)}</small></td>
          <td>${money(o.price_cents)}</td>
          <td class="muted" style="max-width:160px">${esc(o.class_scope ?? 'усі')}</td>
          <td><input type="checkbox" data-option-active="${o.id}" ${o.active ? 'checked' : ''} /></td>
        </tr>`).join('')}</tbody></table>
        <div class="divider"></div>
        <div class="col" style="gap:8px">
          <div class="label">Нова опція</div>
          <div class="row"><input class="input" id="newOptCode" placeholder="код" />
            <input class="input" id="newOptName" placeholder="назва" />
            <input class="input" id="newOptPrice" type="number" placeholder="ціна ₴" style="width:110px" /></div>
          <button class="btn primary" id="createOption">Створити</button>
        </div>
      </div>
    </div>`;

  $$('[data-class-active]').forEach((box) => {
    box.onchange = guard(async () => {
      await api.patch(`/api/admin/classes/${box.dataset.classActive}`, { active: box.checked });
      toast('Клас оновлено');
    });
  });
  $$('[data-option-active]').forEach((box) => {
    box.onchange = guard(async () => {
      await api.patch(`/api/admin/options/${box.dataset.optionActive}`, { active: box.checked });
      toast('Опцію оновлено');
    });
  });
  $('#createClass').onclick = guard(async () => {
    await api.post('/api/admin/classes', {
      code: $('#newClassCode').value.trim(), name: $('#newClassName').value.trim(),
      seats: Number($('#newClassSeats').value) || 4, kind: 'ride',
    });
    toast('Клас створено');
    renderSection();
  });
  $('#createOption').onclick = guard(async () => {
    await api.post('/api/admin/options', {
      code: $('#newOptCode').value.trim(), name: $('#newOptName').value.trim(),
      priceCents: Math.round(Number($('#newOptPrice').value || 0) * 100),
    });
    toast('Опцію створено');
    renderSection();
  });
});

/* -------------------------------------------------------------------- geo -- */
const renderGeo = guard(async () => {
  const [cities, zones] = await Promise.all([api.get('/api/admin/cities'), api.get('/api/admin/zones')]);
  $('#view').innerHTML = `
    <div class="grid c2">
      <div class="card">
        <h3>Міста</h3>
        <table class="table"><thead><tr><th>Місто</th><th>Регіон</th><th>Координати</th><th>Активне</th></tr></thead>
        <tbody>${cities.items.map((c) => `<tr>
          <td>${esc(c.name)}</td><td>${esc(c.region ?? '—')}</td>
          <td class="mono">${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}</td>
          <td><input type="checkbox" data-city-active="${c.id}" ${c.active ? 'checked' : ''} /></td>
        </tr>`).join('')}</tbody></table>
        <div class="divider"></div>
        <div class="label">Нове місто</div>
        <div class="row"><input class="input" id="cityName" placeholder="Назва" />
          <input class="input" id="cityRegion" placeholder="Область" /></div>
        <div class="row"><input class="input" id="cityLat" placeholder="lat" value="50.45" />
          <input class="input" id="cityLng" placeholder="lng" value="30.52" />
          <button class="btn primary" id="createCity">Додати</button></div>
        <small class="muted">Створюється разом з тарифами та налаштуваннями диспетчеризації.</small>
      </div>
      <div class="card">
        <h3>Зони та геозони</h3>
        <table class="table"><thead><tr><th>Назва</th><th>Місто</th><th>Тип</th><th>Множник</th><th></th></tr></thead>
        <tbody>${zones.items.map((z) => `<tr>
          <td>${esc(z.name)}</td><td>${esc(cities.items.find((c) => c.id === z.city_id)?.name ?? z.city_id)}</td>
          <td>${esc(z.kind)}</td><td>×${z.multiplier}</td>
          <td><button class="btn sm danger" data-del-zone="${z.id}">✕</button></td>
        </tr>`).join('')}</tbody></table>
        <div class="divider"></div>
        <div class="label">Нова зона підвищеного попиту</div>
        <div class="row"><input class="input" id="zoneName" placeholder="Назва" />
          <select class="select" id="zoneCity">${cities.items.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="row"><input class="input" id="zoneLat" placeholder="центр lat" value="50.45" />
          <input class="input" id="zoneLng" placeholder="центр lng" value="30.52" />
          <input class="input" id="zoneSpot" type="number" step="0.005" value="0.01" placeholder="радіус, °" />
          <input class="input" id="zoneMult" type="number" step="0.05" value="1.2" placeholder="×" style="width:80px" /></div>
        <button class="btn primary" id="createZone">Створити зону</button>
      </div>
    </div>`;
  $$('[data-city-active]').forEach((box) => {
    box.onchange = guard(async () => {
      await api.patch(`/api/admin/cities/${box.dataset.cityActive}`, { active: box.checked });
      toast('Місто оновлено');
    });
  });
  $$('[data-del-zone]').forEach((btn) => {
    btn.onclick = guard(async () => {
      await api.del(`/api/admin/zones/${btn.dataset.delZone}`);
      renderSection();
    });
  });
  $('#createCity').onclick = guard(async () => {
    await api.post('/api/admin/cities', {
      name: $('#cityName').value.trim(), region: $('#cityRegion').value.trim(),
      lat: Number($('#cityLat').value), lng: Number($('#cityLng').value),
    });
    toast('Місто додано');
    state.cities = (await api.get('/api/cities')).items;
    renderSection();
  });
  $('#createZone').onclick = guard(async () => {
    const lat = Number($('#zoneLat').value);
    const lng = Number($('#zoneLng').value);
    const s = Number($('#zoneSpot').value);
    await api.post('/api/admin/zones', {
      cityId: $('#zoneCity').value, name: $('#zoneName').value.trim(), kind: 'surge',
      multiplier: Number($('#zoneMult').value),
      polygon: [{ lat: lat + s, lng: lng - s }, { lat: lat + s, lng: lng + s }, { lat: lat - s, lng: lng + s }, { lat: lat - s, lng: lng - s }],
    });
    toast('Зону створено');
    renderSection();
  });
});

/* ----------------------------------------------------------------- promos -- */
const renderPromos = guard(async () => {
  const data = await api.get('/api/admin/promos');
  $('#view').innerHTML = `
    <div class="grid c2">
      <div class="card" style="overflow:auto">
        <h3>Промокоди</h3>
        <table class="table"><thead><tr><th>Код</th><th>Тип</th><th>Значення</th><th>Використань</th><th>До</th><th>Активний</th></tr></thead>
        <tbody>${data.items.map((p) => `<tr>
          <td class="mono"><b>${esc(p.code)}</b></td><td>${esc(p.kind)}</td>
          <td>${p.kind === 'percent' ? `${p.value}%` : money(p.value)}</td>
          <td>${p.used_count}/${p.usage_limit ?? '∞'}</td>
          <td>${p.valid_to ?? '—'}</td>
          <td><input type="checkbox" data-promo="${p.code}" ${p.active ? 'checked' : ''} /></td>
        </tr>`).join('')}</tbody></table>
      </div>
      <div class="card col">
        <h3>Новий промокод</h3>
        <input class="input" id="promoCode" placeholder="КОД" />
        <select class="select" id="promoKind">
          <option value="percent">Відсоток</option><option value="fixed">Фіксована сума</option><option value="free_ride">Безкоштовна поїздка</option>
        </select>
        <input class="input" id="promoValue" type="number" placeholder="Значення (% або ₴)" />
        <input class="input" id="promoMin" type="number" placeholder="Мін. сума замовлення ₴" />
        <input class="input" id="promoLimit" type="number" placeholder="Ліміт використань" />
        <input class="input" id="promoPerUser" type="number" placeholder="На користувача" value="1" />
        <input class="input" id="promoTo" type="date" />
        <button class="btn primary" id="createPromo">Створити</button>
      </div>
    </div>`;
  $$('[data-promo]').forEach((box) => {
    box.onchange = guard(async () => {
      await api.patch(`/api/admin/promos/${box.dataset.promo}`, { active: box.checked });
      toast('Промокод оновлено');
    });
  });
  $('#createPromo').onclick = guard(async () => {
    const kind = $('#promoKind').value;
    const rawValue = Number($('#promoValue').value || 0);
    await api.post('/api/admin/promos', {
      code: $('#promoCode').value.trim().toUpperCase(), kind,
      value: kind === 'percent' ? rawValue : Math.round(rawValue * 100),
      minFareCents: Math.round(Number($('#promoMin').value || 0) * 100),
      usageLimit: $('#promoLimit').value ? Number($('#promoLimit').value) : null,
      perUserLimit: Number($('#promoPerUser').value || 1),
      validTo: $('#promoTo').value || null,
    });
    toast('Промокод створено');
    renderSection();
  });
});

/* --------------------------------------------------------------- payments -- */
const renderPayments = guard(async () => {
  const data = await api.get('/api/admin/payments');
  const settlements = await api.get('/api/admin/settlements');
  $('#view').innerHTML = `
    <div class="grid c4">
      ${data.summary.map((s) => `<div class="card"><div class="kpi-label">${esc(s.method)}</div>
        <div class="kpi-value">${money(s.total)}</div><small class="muted">${s.n} операцій</small></div>`).join('')}
    </div>
    <div class="grid c2" style="margin-top:14px">
      <div class="card" style="overflow:auto;max-height:560px">
        <h3>Останні платежі</h3>
        <table class="table"><thead><tr><th>Замовлення</th><th>Метод</th><th>Сума</th><th>Статус</th><th>Час</th></tr></thead>
        <tbody>${data.items.map((p) => `<tr>
          <td class="mono">${esc(p.number)}</td><td>${esc(p.method)}</td><td>${money(p.amount_cents)}</td>
          <td><span class="pill ${p.status === 'captured' ? 'green' : p.status === 'refunded' ? 'amber' : 'grey'}">${esc(p.status)}</span></td>
          <td>${time(p.created_at)}</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="card" style="overflow:auto;max-height:560px">
        <h3>Баланси водіїв</h3>
        <table class="table"><thead><tr><th>Водій</th><th>Баланс</th><th>Зароблено</th><th>Поїздок</th></tr></thead>
        <tbody>${settlements.items.map((d) => `<tr>
          <td>${esc(d.name)}<br><small class="muted">${esc(d.phone)}</small></td>
          <td style="color:${d.balance_cents < 0 ? 'var(--red)' : 'var(--green)'}">${money(d.balance_cents)}</td>
          <td>${money(d.earned_cents)}</td><td>${d.orders_completed}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>`;
});

/* -------------------------------------------------------------- corporate -- */
const renderCorporate = guard(async () => {
  const data = await api.get('/api/admin/companies');
  $('#view').innerHTML = `
    <div class="grid c2">
      <div class="card" style="overflow:auto">
        <h3>Компанії</h3>
        <table class="table"><thead><tr><th>Назва</th><th>ЄДРПОУ</th><th>Знижка</th><th>Ліміт</th><th>Співробітники</th><th>Відкритий рахунок</th></tr></thead>
        <tbody>${data.items.map((c) => `<tr>
          <td>${esc(c.name)}</td><td class="mono">${esc(c.edrpou ?? '—')}</td>
          <td>${c.discount_pct}%</td><td>${money(c.credit_limit_cents)}</td>
          <td>${c.members}</td><td>${money(c.open_invoice_cents)}</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="card col">
        <h3>Нова компанія</h3>
        <input class="input" id="compName" placeholder="Назва" />
        <input class="input" id="compEdrpou" placeholder="ЄДРПОУ" />
        <input class="input" id="compDiscount" type="number" placeholder="Знижка %" value="5" />
        <input class="input" id="compLimit" type="number" placeholder="Кредитний ліміт ₴" value="20000" />
        <input class="input" id="compEmail" placeholder="Email для рахунків" />
        <button class="btn primary" id="createCompany">Створити</button>
        <small class="muted">Корпоративні поїздки оплачуються з єдиного рахунку з місячним лімітом на співробітника.</small>
      </div>
    </div>`;
  $('#createCompany').onclick = guard(async () => {
    await api.post('/api/admin/companies', {
      name: $('#compName').value.trim(), edrpou: $('#compEdrpou').value.trim(),
      discountPct: Number($('#compDiscount').value || 0),
      creditLimitCents: Math.round(Number($('#compLimit').value || 0) * 100),
      invoiceEmail: $('#compEmail').value.trim(),
    });
    toast('Компанію створено');
    renderSection();
  });
});

/* ---------------------------------------------------------------- support -- */
const renderSupport = guard(async () => {
  const data = await api.get('/api/admin/support/tickets');
  $('#view').innerHTML = `<div class="card" style="overflow:auto"><table class="table">
    <thead><tr><th>Тема</th><th>Клієнт</th><th>Статус</th><th>Оновлено</th><th></th></tr></thead>
    <tbody>${data.items.map((t) => `<tr>
      <td>${esc(t.subject)}</td><td>${esc(t.name ?? '')}<br><small class="muted">${esc(t.phone ?? '')}</small></td>
      <td><span class="pill ${t.status === 'closed' ? 'grey' : t.status === 'open' ? 'amber' : 'blue'}">${esc(t.status)}</span></td>
      <td>${dt(t.updated_at)}</td>
      <td><button class="btn sm" data-ticket="${t.id}">Відкрити</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Звернень немає</td></tr>'}
    </tbody></table></div>`;
  $$('[data-ticket]').forEach((btn) => {
    btn.onclick = guard(async () => {
      const detail = await api.get(`/api/support/tickets/${btn.dataset.ticket}`);
      const overlay = el(`<div class="overlay" style="position:fixed"><div class="sheet" style="max-width:560px;border-radius:16px">
        <div class="row between"><h3 style="margin:0">${esc(detail.ticket.subject)}</h3><button class="btn sm ghost" data-close>✕</button></div>
        <div class="list">${detail.messages.map((m) => `<div class="list-row">
          <span>${m.author_role === 'agent' ? '🎧' : '👤'}</span>
          <div class="grow"><div style="font-size:13px">${esc(m.body)}</div><small class="muted">${dt(m.created_at)}</small></div></div>`).join('')}</div>
        <textarea class="textarea" id="replyText" placeholder="Відповідь клієнту"></textarea>
        <div class="row"><button class="btn primary grow" id="sendReply">Надіслати</button>
          <button class="btn grow" id="closeTicket">Закрити звернення</button></div>
      </div></div>`);
      document.body.appendChild(overlay);
      overlay.querySelector('[data-close]').onclick = () => overlay.remove();
      overlay.querySelector('#sendReply').onclick = guard(async () => {
        await api.post(`/api/support/tickets/${btn.dataset.ticket}/messages`, { message: overlay.querySelector('#replyText').value.trim() });
        overlay.remove();
        toast('Відповідь надіслано');
        renderSection();
      });
      overlay.querySelector('#closeTicket').onclick = guard(async () => {
        await api.patch(`/api/admin/support/tickets/${btn.dataset.ticket}`, { status: 'closed' });
        overlay.remove();
        renderSection();
      });
    });
  });
});

/* ---------------------------------------------------------------- reviews -- */
const renderReviews = guard(async () => {
  const data = await api.get('/api/admin/reviews');
  $('#view').innerHTML = `<div class="card" style="overflow:auto"><table class="table">
    <thead><tr><th>Оцінка</th><th>Водій</th><th>Пасажир</th><th>Коментар</th><th>Замовлення</th><th></th></tr></thead>
    <tbody>${data.items.map((r) => `<tr>
      <td class="rating">${'★'.repeat(r.rating)}</td><td>${esc(r.driver_name)}</td><td>${esc(r.passenger_name ?? '')}</td>
      <td style="max-width:320px">${esc(r.text ?? '')}</td><td class="mono">${esc(r.number ?? '')}</td>
      <td><button class="btn sm danger" data-del-review="${r.id}">Видалити</button></td></tr>`).join('')
      || '<tr><td colspan="6" class="muted">Відгуків немає</td></tr>'}
    </tbody></table></div>`;
  $$('[data-del-review]').forEach((btn) => {
    btn.onclick = guard(async () => {
      if (!confirm('Видалити відгук?')) return;
      await api.del(`/api/admin/reviews/${btn.dataset.delReview}`);
      toast('Відгук видалено');
      renderSection();
    });
  });
});

/* ----------------------------------------------------------------- quests -- */
const renderQuests = guard(async () => {
  const data = await api.get('/api/admin/quests');
  $('#view').innerHTML = `
    <div class="grid c2">
      <div class="card" style="overflow:auto">
        <h3>Бонусні завдання</h3>
        <table class="table"><thead><tr><th>Завдання</th><th>Ціль</th><th>Бонус</th><th>Період</th><th>Активне</th></tr></thead>
        <tbody>${data.items.map((q) => `<tr>
          <td>${esc(q.title)}</td><td>${q.target_orders} замовлень</td><td>${money(q.bonus_cents)}</td>
          <td>${q.valid_from ?? ''} — ${q.valid_to ?? '∞'}</td>
          <td><span class="pill ${q.active ? 'green' : 'grey'}">${q.active ? 'так' : 'ні'}</span></td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">Немає завдань</td></tr>'}</tbody></table>
      </div>
      <div class="card col">
        <h3>Нове завдання</h3>
        <input class="input" id="questTitle" placeholder="Назва (напр. 20 поїздок за тиждень)" />
        <input class="input" id="questTarget" type="number" placeholder="Кількість замовлень" value="20" />
        <input class="input" id="questBonus" type="number" placeholder="Бонус ₴" value="500" />
        <input class="input" id="questFrom" type="date" />
        <input class="input" id="questTo" type="date" />
        <button class="btn primary" id="createQuest">Створити</button>
        <small class="muted">Бонус нараховується автоматично після виконання умови (ідемпотентно).</small>
      </div>
    </div>`;
  $('#createQuest').onclick = guard(async () => {
    await api.post('/api/admin/quests', {
      title: $('#questTitle').value.trim(), targetOrders: Number($('#questTarget').value),
      bonusCents: Math.round(Number($('#questBonus').value) * 100),
      validFrom: $('#questFrom').value || undefined, validTo: $('#questTo').value || undefined,
    });
    toast('Завдання створено');
    renderSection();
  });
});

/* ---------------------------------------------------------------- reports -- */
function renderReports() {
  $('#view').innerHTML = `
    <div class="grid c2">
      <div class="card col">
        <h3>Експорт замовлень</h3>
        <div class="row"><input class="input" type="date" id="repFrom" /><input class="input" type="date" id="repTo" /></div>
        <button class="btn primary" id="exportOrders">⤓ Завантажити CSV</button>
      </div>
      <div class="card col">
        <h3>Фінансовий звіт</h3>
        <div class="row"><input class="input" type="date" id="finFrom" /><input class="input" type="date" id="finTo" /></div>
        <button class="btn primary" id="exportFinance">⤓ Завантажити CSV</button>
      </div>
    </div>`;
  $('#exportOrders').onclick = () => downloadCsv('/api/admin/reports/orders.csv', {
    from: $('#repFrom').value || undefined, to: $('#repTo').value || undefined,
  });
  $('#exportFinance').onclick = () => downloadCsv('/api/admin/reports/finance.csv', {
    from: $('#finFrom').value || undefined, to: $('#finTo').value || undefined,
  });
}

async function downloadCsv(path, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  const res = await fetch(`${path}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${token.get()}` } });
  if (!res.ok) { toast('Не вдалось отримати звіт', 'err'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = el(`<a href="${url}" download="report.csv"></a>`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ audit -- */
const renderAudit = guard(async () => {
  const data = await api.get('/api/admin/audit');
  $('#view').innerHTML = `<div class="card" style="overflow:auto"><table class="table">
    <thead><tr><th>Час</th><th>Хто</th><th>Дія</th><th>Обʼєкт</th><th>Деталі</th></tr></thead>
    <tbody>${data.items.map((a) => `<tr>
      <td>${dt(a.created_at)}</td><td>${esc(a.actor_name ?? a.actor_role ?? 'system')}</td>
      <td><span class="pill blue">${esc(a.action)}</span></td><td>${esc(a.entity)} ${esc(a.entity_id ?? '')}</td>
      <td class="muted" style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.payload)}</td>
    </tr>`).join('')}</tbody></table></div>`;
});

/* --------------------------------------------------------------- settings -- */
const renderSettings = guard(async () => {
  const data = await api.get('/api/admin/settings');
  $('#view').innerHTML = `
    <div class="grid c2">
      <div class="card col">
        <h3>Параметри платформи</h3>
        ${data.items.map((s) => `<div class="row" style="gap:8px">
          <label class="label" style="width:210px">${esc(s.key)}</label>
          <input class="input" data-setting="${esc(s.key)}" value="${esc(typeof s.value === 'object' ? JSON.stringify(s.value) : s.value)}" />
        </div>`).join('')}
        <button class="btn primary" id="saveSettings">Зберегти</button>
        <small class="muted">Значення без лапок трактуються як рядки, числа — як числа.</small>
      </div>
      <div class="card col">
        <h3>Диспетчеризація по містах</h3>
        ${data.dispatch.map((d) => `<div class="card tight col" style="gap:6px">
          <b>${esc(state.cities.find((c) => c.id === d.city_id)?.name ?? d.city_id)}</b>
          <div class="row wrap">
            ${[['offer_timeout_s', 'Таймер, с'], ['offer_rounds', 'Раундів'], ['search_radius_km', 'Радіус, км'],
               ['parallel_offers', 'Паралельних пропозицій'], ['max_active_orders', 'Активних на клієнта']]
              .map(([key, label]) => `<div class="field"><label class="label">${label}</label>
                <input class="input" style="width:100px;padding:6px" data-dispatch="${d.city_id}" data-key="${key}" value="${d[key]}" /></div>`).join('')}
          </div>
          <button class="btn sm primary" data-save-dispatch="${d.city_id}">Зберегти</button>
        </div>`).join('')}
        <div class="divider"></div>
        <h3>Ролі та права</h3>
        <table class="table"><thead><tr><th>Роль</th><th>Права</th></tr></thead>
        <tbody>${data.roles.map((r) => `<tr><td>${esc(r.name)}</td><td class="muted">${esc(r.permissions)}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>`;

  $('#saveSettings').onclick = guard(async () => {
    const payload = {};
    $$('[data-setting]').forEach((input) => {
      const raw = input.value.trim();
      if (raw === '') { payload[input.dataset.setting] = ''; return; }
      const asNumber = Number(raw);
      payload[input.dataset.setting] = Number.isFinite(asNumber) && raw !== '' && !Number.isNaN(asNumber) && /^-?\d+(\.\d+)?$/.test(raw)
        ? asNumber : raw;
    });
    await api.patch('/api/admin/settings', payload);
    toast('Налаштування збережено');
  });

  $$('[data-save-dispatch]').forEach((btn) => {
    btn.onclick = guard(async () => {
      const cityId = btn.dataset.saveDispatch;
      const payload = {};
      $$(`[data-dispatch="${cityId}"]`).forEach((input) => { payload[toCamel(input.dataset.key)] = Number(input.value); });
      await api.patch(`/api/admin/dispatch/${cityId}`, payload);
      toast('Параметри диспетчеризації оновлено');
    });
  });
});

const toCamel = (snake) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/* ------------------------------------------------------------------- misc -- */
$('#logoutBtn').onclick = () => {
  token.clear();
  state.rt?.close();
  location.reload();
};
window.addEventListener('hashchange', router);

boot();
