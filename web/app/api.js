/* Shared browser client: REST + WebSocket + tiny DOM helpers. */

const TOKEN_KEY = 'rukh_token';

export const money = (cents, currency = 'UAH') => {
  if (cents === null || cents === undefined) return '—';
  const value = (Number(cents) / 100).toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return `${value} ₴`;
};
export const money2 = (cents) => `${(Number(cents || 0) / 100).toFixed(2)} ₴`;
export const hryvnia = (cents) => Math.round(Number(cents || 0) / 100);
export const dt = (value) => {
  if (!value) return '—';
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
export const time = (value) => {
  const d = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
};
export const km = (meters) => `${(Number(meters || 0) / 1000).toFixed(1)} км`;
export const mins = (seconds) => `${Math.max(1, Math.round(Number(seconds || 0) / 60))} хв`;

export const STATUS_LABELS = {
  searching: 'Пошук водія',
  offered: 'Пропозиція надіслана',
  no_drivers: 'Немає вільних водіїв',
  assigned: 'Водія призначено',
  driver_arriving: 'Водій прямує до вас',
  waiting: 'Водій чекає',
  in_progress: 'У дорозі',
  completed: 'Завершено',
  canceled: 'Скасовано',
  expired: 'Прострочено',
};
export const STATUS_TONE = {
  searching: 'amber', offered: 'amber', no_drivers: 'red', assigned: 'blue', driver_arriving: 'blue',
  waiting: 'blue', in_progress: 'lime', completed: 'green', canceled: 'grey', expired: 'grey',
};

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (value) => localStorage.setItem(TOKEN_KEY, value),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.message || `HTTP ${status}`);
    this.status = status;
    this.code = payload?.code;
    this.details = payload?.details;
  }
}

async function request(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const current = token.get();
  if (current) headers.authorization = `Bearer ${current}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  }
  if (!res.ok) throw new ApiError(res.status, payload?.error || payload);
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

/* ---------------------------------------------------------------- realtime */
export class Realtime {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.ws = null;
    this.channels = new Set();
    this.retry = 0;
    this.closed = false;
  }
  connect() {
    const current = token.get();
    if (!current) return this;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(current)}`;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.retry = 0;
      this.onEvent?.({ event: 'socket.open', payload: {} });
      for (const channel of this.channels) this.send({ type: 'subscribe', channel });
    };
    this.ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this.onEvent?.(msg);
    };
    this.ws.onclose = () => {
      this.onEvent?.({ event: 'socket.close', payload: {} });
      if (this.closed) return;
      // exponential-ish backoff, capped — survives internet drops
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.connect(), 400 * this.retry);
    };
    return this;
  }
  send(payload) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(payload));
  }
  subscribe(channel) {
    this.channels.add(channel);
    this.send({ type: 'subscribe', channel });
    return this;
  }
  unsubscribe(channel) {
    this.channels.delete(channel);
    return this;
  }
  close() {
    this.closed = true;
    this.ws?.close();
  }
}

/* ----------------------------------------------------------------- helpers */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const el = (html) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
};
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export function toast(message, kind = 'ok') {
  let stack = $('.toast-stack');
  if (!stack) {
    stack = el('<div class="toast-stack"></div>');
    document.body.appendChild(stack);
  }
  const node = el(`<div class="toast ${kind === 'err' ? 'err' : ''}">${esc(message)}</div>`);
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

export function guard(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof ApiError) {
        toast(error.message, 'err');
        if (error.status === 401) {
          token.clear();
          setTimeout(() => location.reload(), 600);
        }
      } else {
        // eslint-disable-next-line no-console
        console.error(error);
        toast(error.message || 'Помилка зʼєднання', 'err');
      }
      return undefined;
    }
  };
}
