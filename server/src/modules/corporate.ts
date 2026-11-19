/** Corporate module + support desk. */
import type { FastifyInstance } from 'fastify';
import { all, Db, one, run, tx } from '../lib/db.js';
import { audit, currentUser, requireRole } from '../lib/http.js';
import { notify } from '../lib/order-service.js';
import { conflict, forbidden, id, iso, notFound, num, oneOf, phone, str, unprocessable } from '../lib/util.js';

export function registerCorporateRoutes(app: FastifyInstance, db: Db) {
  const companyOf = (userId: string) => {
    const user = one(db, `SELECT * FROM users WHERE id = ?`, userId);
    if (!user?.corporate_id) throw forbidden('Корпоративний акаунт не налаштований');
    return { user, companyId: user.corporate_id as string };
  };

  app.get('/api/corporate/me', async (req) => {
    const user = currentUser(db, req);
    const { companyId } = companyOf(user.id);
    const company = one(db, `SELECT * FROM companies WHERE id = ?`, companyId);
    const members = all(db,
      `SELECT m.*, u.name FROM corporate_members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.company_id = ? ORDER BY m.created_at`, companyId);
    const invoices = all(db, `SELECT * FROM corporate_invoices WHERE company_id = ? ORDER BY period DESC`, companyId);
    const period = iso().slice(0, 7);
    const stats = one<any>(db,
      `SELECT COUNT(*) AS orders, COALESCE(SUM(COALESCE(final_price_cents, quoted_price_cents)),0) AS total
       FROM orders WHERE corporate_id = ? AND strftime('%Y-%m', created_at) = ?`, companyId, period)!;
    return { company, members, invoices, currentPeriod: { period, orders: stats.orders, totalCents: stats.total } };
  });

  app.post('/api/corporate/members/invite', async (req) => {
    const user = currentUser(db, req);
    const { companyId } = companyOf(user.id);
    const member = one(db, `SELECT * FROM corporate_members WHERE company_id = ? AND user_id = ?`, companyId, user.id);
    if (member && member.role !== 'admin' && user.role !== 'admin' && user.role !== 'corporate_admin') {
      throw forbidden('Запрошувати співробітників може лише адміністратор компанії');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const memberPhone = phone(body.phone);
    const limit = body.monthlyLimitCents !== undefined ? num(body.monthlyLimitCents, 'monthlyLimitCents', { min: 0, int: true }) : 0;
    const exists = one(db, `SELECT id FROM corporate_members WHERE company_id = ? AND phone = ?`, companyId, memberPhone);
    if (exists) throw conflict('Цей співробітник уже доданий');
    const memberId = id('cm');
    const token = `inv_${id('x').slice(2)}`;
    run(db,
      `INSERT INTO corporate_members (id, company_id, phone, role, monthly_limit_cents, status, invite_token)
       VALUES (?,?,?,'employee',?,'invited',?)`, memberId, companyId, memberPhone, limit, token);
    audit(db, user, 'corporate.invite', 'company', companyId, { memberPhone });
    return { ok: true, memberId, inviteToken: token, inviteLink: `/corporate/join?token=${token}` };
  });

  app.post('/api/corporate/join', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = str(body.token, 'token', { min: 5, max: 80 });
    const invite = one(db, `SELECT * FROM corporate_members WHERE invite_token = ?`, token);
    if (!invite) throw notFound('Запрошення не знайдено');
    if (invite.status !== 'invited') throw conflict('Запрошення вже використано');
    tx(db, () => {
      run(db, `UPDATE corporate_members SET user_id = ?, phone = ?, status = 'active' WHERE id = ?`,
        user.id, user.phone, invite.id);
      run(db, `UPDATE users SET corporate_id = ? WHERE id = ?`, invite.company_id, user.id);
    });
    audit(db, user, 'corporate.joined', 'company', invite.company_id, {});
    return { ok: true, companyId: invite.company_id };
  });

  app.patch('/api/corporate/members/:id', async (req) => {
    const user = currentUser(db, req);
    const { companyId } = companyOf(user.id);
    const { id: memberId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const target = one(db, `SELECT * FROM corporate_members WHERE id = ? AND company_id = ?`, memberId, companyId);
    if (!target) throw notFound('Співробітника не знайдено');
    if (user.role !== 'admin' && !['corporate_admin'].includes(user.role)) {
      const self = one(db, `SELECT * FROM corporate_members WHERE company_id = ? AND user_id = ?`, companyId, user.id);
      if (!self || self.role !== 'admin') throw forbidden('Керувати співробітниками може адміністратор компанії');
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.monthlyLimitCents !== undefined) {
      fields.push('monthly_limit_cents = ?');
      values.push(num(body.monthlyLimitCents, 'monthlyLimitCents', { min: 0, int: true }));
    }
    if (body.status !== undefined) {
      fields.push('status = ?');
      values.push(oneOf(body.status, ['invited', 'active', 'blocked'] as const, 'status'));
    }
    if (!fields.length) throw unprocessable('Немає змін');
    run(db, `UPDATE corporate_members SET ${fields.join(', ')} WHERE id = ?`, ...values, memberId);
    audit(db, user, 'corporate.member_updated', 'company', companyId, { memberId, ...body });
    return { ok: true };
  });

  app.get('/api/corporate/reports', async (req, reply) => {
    const user = currentUser(db, req);
    const { companyId } = companyOf(user.id);
    const q = req.query as Record<string, string>;
    const period = q.period ?? iso().slice(0, 7);
    const rows = all(db,
      `SELECT o.number, o.created_at, o.status, u.name AS employee, u.phone,
              COALESCE(o.final_price_cents, o.quoted_price_cents) AS amount_cents, o.payment_method
       FROM orders o JOIN users u ON u.id = o.passenger_id
       WHERE o.corporate_id = ? AND strftime('%Y-%m', o.created_at) = ? ORDER BY o.created_at DESC`,
      companyId, period);
    const total = rows.reduce((s, r) => s + Number(r.amount_cents ?? 0), 0);
    if (q.format === 'csv') {
      const header = 'number;created_at;status;employee;phone;amount_cents;payment_method';
      const body = rows.map((r) => [r.number, r.created_at, r.status, r.employee, r.phone, r.amount_cents, r.payment_method].join(';'));
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="corporate-${period}.csv"`);
      audit(db, user, 'corporate.report_exported', 'company', companyId, { period });
      return '\uFEFF' + [header, ...body].join('\n');
    }
    return { period, items: rows, totalCents: total };
  });
}

export function registerSupportRoutes(app: FastifyInstance, db: Db) {
  app.post('/api/support/tickets', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subject = str(body.subject, 'subject', { min: 3, max: 120 });
    const message = str(body.message, 'message', { min: 3, max: 2000 });
    const orderId = body.orderId ? str(body.orderId, 'orderId') : null;
    const ticketId = id('tkt');
    tx(db, () => {
      run(db, `INSERT INTO support_tickets (id, user_id, order_id, subject) VALUES (?,?,?,?)`,
        ticketId, user.id, orderId, subject);
      run(db, `INSERT INTO support_messages (id, ticket_id, author_id, author_role, body) VALUES (?,?,?,'user',?)`,
        id('msg'), ticketId, user.id, message);
    });
    return { ok: true, ticketId };
  });

  app.get('/api/support/tickets', async (req) => {
    const user = currentUser(db, req);
    const rows = all(db, `SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC`, user.id);
    return { items: rows };
  });

  app.get('/api/support/tickets/:id', async (req) => {
    const user = currentUser(db, req);
    const { id: ticketId } = req.params as { id: string };
    const ticket = one(db, `SELECT * FROM support_tickets WHERE id = ?`, ticketId);
    if (!ticket) throw notFound('Звернення не знайдено');
    const isStaff = ['admin', 'dispatcher'].includes(user.role);
    if (ticket.user_id !== user.id && !isStaff) throw forbidden();
    return {
      ticket,
      messages: all(db, `SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at`, ticketId),
    };
  });

  app.post('/api/support/tickets/:id/messages', async (req) => {
    const user = currentUser(db, req);
    const { id: ticketId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = str(body.message, 'message', { min: 1, max: 2000 });
    const ticket = one(db, `SELECT * FROM support_tickets WHERE id = ?`, ticketId);
    if (!ticket) throw notFound('Звернення не знайдено');
    const isStaff = ['admin', 'dispatcher'].includes(user.role);
    if (ticket.user_id !== user.id && !isStaff) throw forbidden();
    run(db, `INSERT INTO support_messages (id, ticket_id, author_id, author_role, body) VALUES (?,?,?,?,?)`,
      id('msg'), ticketId, user.id, isStaff ? 'agent' : 'user', text);
    run(db, `UPDATE support_tickets SET updated_at = ?, status = ? WHERE id = ?`,
      iso(), isStaff ? 'pending' : 'open', ticketId);
    if (isStaff) notify(db, ticket.user_id, 'support_reply', 'Відповідь підтримки', text.slice(0, 120), { ticketId });
    return { ok: true };
  });

  app.get('/api/admin/support/tickets', async (req) => {
    const user = currentUser(db, req);
    requireRole(user, 'admin', 'dispatcher');
    const rows = all(db,
      `SELECT t.*, u.name, u.phone FROM support_tickets t JOIN users u ON u.id = t.user_id
       ORDER BY t.status != 'closed' DESC, t.updated_at DESC LIMIT 200`);
    return { items: rows };
  });

  app.patch('/api/admin/support/tickets/:id', async (req) => {
    const user = currentUser(db, req);
    requireRole(user, 'admin', 'dispatcher');
    const { id: ticketId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = oneOf(body.status, ['open', 'pending', 'closed'] as const, 'status');
    run(db, `UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?`, status, iso(), ticketId);
    audit(db, user, 'support.status', 'ticket', ticketId, { status });
    return { ok: true };
  });
}
