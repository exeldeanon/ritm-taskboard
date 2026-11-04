import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || (process.env.BOTHOST === '1' ? '/app/data' : join(root, 'data'));
await mkdir(dataDir, { recursive: true });
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of (await readFile(envPath, 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}
if (process.env.BOTHOST === '1' && !process.env.APP_PASSWORD) {
  throw new Error('На Bothost задайте APP_PASSWORD перед запуском, чтобы не публиковать задачи без пароля.');
}

const db = new DatabaseSync(join(dataDir, 'tasks.sqlite'));
db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Входящие',
  priority TEXT NOT NULL DEFAULT 'Обычный',
  due_date TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  blocker TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);`);

const statuses = ['Входящие', 'Запланировано', 'В работе', 'Жду ответа', 'Готово'];
const priorities = ['Низкий', 'Обычный', 'Высокий', 'Срочный'];
const stamp = () => new Date().toISOString();
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error('Слишком большой запрос'); }
  return raw ? JSON.parse(raw) : {};
}
async function notify(task, action) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.MANAGER_CHAT_ID;
  if (!token || !chat) return false;
  const due = task.due_date ? `\nСрок: ${task.due_date}` : '';
  const next = task.next_step ? `\nСледующий шаг: ${task.next_step}` : '';
  const block = task.blocker ? `\nБлокер: ${task.blocker}` : '';
  const text = `📌 ${action}\n${task.title}\nСтатус: ${task.status} · Приоритет: ${task.priority}${due}${next}${block}`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text })
    });
    return r.ok;
  } catch { return false; }
}
function logEvent(id, message) { db.prepare('INSERT INTO events(task_id,message,created_at) VALUES(?,?,?)').run(id, message, stamp()); }
const selectTask = db.prepare('SELECT * FROM tasks WHERE id=?');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (process.env.APP_PASSWORD) {
      const auth = req.headers.authorization || '';
      const supplied = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
      const expected = `tasks:${process.env.APP_PASSWORD}`;
      if (supplied !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Ритм — задачи", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Для просмотра задач нужен пароль.');
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const items = db.prepare(`SELECT t.*,(SELECT message FROM events e WHERE e.task_id=t.id ORDER BY e.id DESC LIMIT 1) AS last_event FROM tasks t ORDER BY CASE t.status WHEN 'Готово' THEN 1 ELSE 0 END, CASE t.priority WHEN 'Срочный' THEN 0 WHEN 'Высокий' THEN 1 WHEN 'Обычный' THEN 2 ELSE 3 END, CASE WHEN t.due_date='' THEN 1 ELSE 0 END,t.due_date,t.updated_at DESC`).all();
      return json(res, 200, items);
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      return json(res, 200, db.prepare(`SELECT e.*,t.title FROM events e JOIN tasks t ON t.id=e.task_id ORDER BY e.id DESC LIMIT 30`).all());
    }
    if ((req.method === 'POST' && url.pathname === '/api/tasks') || (req.method === 'PATCH' && /^\/api\/tasks\/\d+$/.test(url.pathname))) {
      const patch = await body(req); const isNew = req.method === 'POST';
      const id = isNew ? null : Number(url.pathname.split('/').at(-1));
      const old = isNew ? null : selectTask.get(id);
      if (!isNew && !old) return json(res, 404, { error: 'Задача не найдена' });
      const title = String(patch.title ?? old?.title ?? '').trim();
      if (!title) return json(res, 400, { error: 'Укажите название задачи' });
      const status = statuses.includes(patch.status) ? patch.status : (old?.status || 'Входящие');
      const priority = priorities.includes(patch.priority) ? patch.priority : (old?.priority || 'Обычный');
      const values = [title, String(patch.description ?? old?.description ?? ''), status, priority, String(patch.due_date ?? old?.due_date ?? ''), String(patch.next_step ?? old?.next_step ?? ''), String(patch.blocker ?? old?.blocker ?? ''), stamp()];
      if (isNew) {
        const result = db.prepare('INSERT INTO tasks(title,description,status,priority,due_date,next_step,blocker,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(...values.slice(0, 7), stamp(), values[7]);
        const task = selectTask.get(Number(result.lastInsertRowid)); logEvent(task.id, 'Задача создана');
        const delivered = await notify(task, 'Новая задача'); return json(res, 201, { ...task, notification: delivered });
      }
      db.prepare('UPDATE tasks SET title=?,description=?,status=?,priority=?,due_date=?,next_step=?,blocker=?,updated_at=? WHERE id=?').run(...values, id);
      const task = selectTask.get(id);
      const changes = [];
      for (const field of ['title','description','status','priority','due_date','next_step','blocker']) if (String(old[field] ?? '') !== String(task[field] ?? '')) changes.push(field);
      if (changes.length) logEvent(id, `Обновлено: ${changes.map(x => ({title:'название',description:'заметки',status:'статус',priority:'приоритет',due_date:'срок',next_step:'следующий шаг',blocker:'блокер'})[x]).join(', ')}`);
      const delivered = changes.length ? await notify(task, 'Обновление задачи') : false;
      return json(res, 200, { ...task, notification: delivered });
    }
    if (req.method === 'DELETE' && /^\/api\/tasks\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1));
      db.prepare('DELETE FROM events WHERE task_id=?').run(id); const result = db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      return json(res, result.changes ? 200 : 404, { ok: Boolean(result.changes) });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { telegramEnabled: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.MANAGER_CHAT_ID) });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(join(root, 'index.html')); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    json(res, 404, { error: 'Не найдено' });
  } catch (err) { json(res, 500, { error: err.message || 'Внутренняя ошибка' }); }
});
const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => console.log(`Progress Desk: http://localhost:${port}`));
