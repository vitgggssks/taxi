/**
 * Uploads — приймання файлів (фото вручення, документи водія, аватар).
 *
 * Демо-реалізація свідомо без S3: файли лягають у `data/uploads` і віддаються
 * тим самим Fastify за `/uploads/<name>`. Контракт (`POST /api/uploads` →
 * `{ url }`) не залежить від сховища, тож продакшн-заміна на S3/R2/GCS — це
 * заміна двох функцій (`saveFile` / маршрут `/uploads/*`).
 *
 * Безпека: обмеження розміру (3 МБ), перевірка реального типу за магічними
 * байтами (а не за `Content-Type` від клієнта), випадкові імена, захист від
 * виходу з каталогу через `..`.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { currentUser } from '../lib/http.js';
import { bad, id, notFound, unprocessable } from '../lib/util.js';

const MAX_BYTES = 3 * 1024 * 1024;

type Signature = { mime: string; ext: string; test: (buf: Buffer) => boolean };

const SIGNATURES: Signature[] = [
  {
    mime: 'image/png',
    ext: 'png',
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    mime: 'application/pdf',
    ext: 'pdf',
    test: (b) => b.length > 4 && b.subarray(0, 4).toString('latin1') === '%PDF',
  },
];

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export function uploadsDir(): string {
  return process.env.UPLOAD_DIR ?? join(process.cwd(), 'data/uploads');
}

export function registerUploadRoutes(app: FastifyInstance, db: any): void {
  app.post('/api/uploads', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = typeof body.dataUrl === 'string' ? body.dataUrl : typeof body.data === 'string' ? body.data : '';
    const base64 = raw.replace(/^data:[^;]*;base64,/, '').trim();
    if (!base64) throw bad('Потрібні дані файлу (base64 або data URL)', { field: 'dataUrl' });

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) throw bad('Порожній файл');
    if (buffer.length > MAX_BYTES) {
      throw unprocessable(`Файл завеликий: максимум ${Math.round(MAX_BYTES / 1048576)} МБ`);
    }

    const signature = SIGNATURES.find((s) => s.test(buffer));
    if (!signature) throw unprocessable('Підтримуються лише PNG, JPEG, WEBP, PDF');

    const dir = uploadsDir();
    mkdirSync(dir, { recursive: true });
    const name = `${id('up')}.${signature.ext}`;
    writeFileSync(join(dir, name), buffer);

    return {
      ok: true,
      url: `/uploads/${name}`,
      mime: signature.mime,
      size: buffer.length,
      uploadedBy: user.id,
    };
  });

  app.get('/uploads/*', async (req, reply: FastifyReply) => {
    const wildcard = (req.params as Record<string, string>)['*'] ?? '';
    const dir = resolve(uploadsDir());
    // normalize + resolve захищає від ../../etc/passwd
    const path = resolve(join(dir, normalize(wildcard).replace(/^([/\\])+/, '')));
    if (path !== dir && !path.startsWith(dir + sep)) throw notFound('Файл не знайдено');

    let body: Buffer;
    try {
      body = readFileSync(path);
    } catch {
      throw notFound('Файл не знайдено');
    }
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    reply.type(MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream');
    return reply.send(body);
  });
}
