/**
 * Драйвер БД для serverless-середовища (Vercel).
 *
 * Реалізує той самий інтерфейс, що й `better-sqlite3` (prepare/get/all/run,
 * exec, pragma, transaction), але поверх вбудованого в Node 22+ `node:sqlite`.
 * Це дозволяє бандлити API без нативних модулів: функція запускається на
 * будь-якому Node-рантаймі без компіляції C++.
 *
 * Підключається через esbuild-alias `better-sqlite3 → цей файл`
 * (див. scripts/build-vercel.mjs). Локальна розробка й тести працюють на
 * справжньому better-sqlite3.
 */
import { DatabaseSync } from 'node:sqlite';

/** node:sqlite повертає обʼєкти без прототипу — приводимо до звичайних. */
function plain(row) {
  if (row == null) return row;
  const out = {};
  for (const key of Object.keys(row)) out[key] = row[key];
  return out;
}

/** better-sqlite3 кидає на undefined і приймає boolean; node:sqlite — ні. */
function normalize(params) {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

class Statement {
  constructor(statement) {
    this.statement = statement;
  }

  all(...params) {
    return this.statement.all(...normalize(params)).map(plain);
  }

  get(...params) {
    const row = this.statement.get(...normalize(params));
    return row == null ? undefined : plain(row);
  }

  run(...params) {
    const result = this.statement.run(...normalize(params));
    return { changes: Number(result.changes ?? 0), lastInsertRowid: Number(result.lastInsertRowid ?? 0) };
  }
}

export default class Database {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.depth = 0;
  }

  prepare(sql) {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql) {
    this.db.exec(sql);
    return this;
  }

  pragma(statement) {
    try {
      this.db.exec(`PRAGMA ${statement}`);
    } catch {
      /* частина прагм не має сенсу для тимчасового файла — не валимо старт */
    }
    return this;
  }

  /**
   * Синхронна транзакція з відкатом на помилці.
   * Вкладені виклики (як у better-sqlite3) використовують SAVEPOINT, інакше
   * `BEGIN` всередині `BEGIN` падає — а доменні сервіси (settleOrder,
   * chargeOrder) навмисно відкривають власні транзакції всередині загальної.
   */
  transaction(fn) {
    return (...args) => {
      const level = ++this.depth;
      const savepoint = `rukh_sp_${level}`;
      this.db.exec(level === 1 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
      try {
        const result = fn(...args);
        this.db.exec(level === 1 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        try {
          if (level === 1) {
            this.db.exec('ROLLBACK');
          } else {
            this.db.exec(`ROLLBACK TO ${savepoint}`);
            this.db.exec(`RELEASE ${savepoint}`);
          }
        } catch {
          /* ignore rollback failure */
        }
        throw error;
      } finally {
        this.depth--;
      }
    };
  }

  close() {
    this.db.close();
  }
}
