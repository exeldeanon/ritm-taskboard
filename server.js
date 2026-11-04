import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('tasks', 'tags', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('tasks', 'assignee', "TEXT NOT NULL DEFAULT ''");
ensureColumn('tasks', 'reminder_at', "TEXT NOT NULL DEFAULT ''");
ensureColumn('tasks', 'repeat_rule', "TEXT NOT NULL DEFAULT ''");
ensureColumn('tasks', 'archived', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tasks', 'completed_at', "TEXT NOT NULL DEFAULT ''");
ensureColumn('tasks', 'parent_id', 'INTEGER');
ensureColumn('tasks', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tasks', 'reminder_sent_at', "TEXT NOT NULL DEFAULT ''");

const statuses = ['Входящие', 'Запланировано', 'В работе', 'Жду ответа', 'Готово'];
const priorities = ['Низкий', 'Обычный', 'Высокий', 'Срочный'];
const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
const webAppUrl = process.env.WEBAPP_URL || 'https://bot-1793823483-4147-exel.bothost.tech/';
const ownerId = process.env.OWNER_TELEGRAM_ID || '';
const managerId = process.env.MANAGER_CHAT_ID || '';
const stamp = () => new Date().toISOString();
const cleanTags = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map(item => String(item).trim().replace(/^#/, '').slice(0, 32)).filter(Boolean))].slice(0, 12);
function taskView(task) {
  if (!task) return task;
  let tags = [];
  try { tags = JSON.parse(task.tags || '[]'); } catch { tags = cleanTags(task.tags); }
  return { ...task, tags };
}
const taskViews = tasks => tasks.map(taskView);
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
function verifyInitData(initData) {
  if (!botToken || !initData || initData.length > 8192) return null;
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    const rawUser = params.get('user');
    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !rawUser || !Number.isFinite(authDate)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (authDate > now + 60 || now - authDate > 86400) return null;
    const checkString = [...params.entries()].filter(([key]) => key !== 'hash' && key !== 'signature').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
    const secret = createHmac('sha256', botToken).update('WebAppData').digest();
    const expectedHash = createHmac('sha256', secret).update(checkString).digest();
    const actualHash = Buffer.from(receivedHash, 'hex');
    if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) return null;
    const user = JSON.parse(rawUser);
    const id = String(user.id || '');
    const role = id && ownerId && id === ownerId ? 'owner' : id && managerId && id === managerId ? 'manager' : '';
    if (!role) return { denied: true, user };
    return { id, role, user };
  } catch { return null; }
}
function authenticate(req) {
  const initData = req.headers['x-telegram-init-data'];
  if (initData) return verifyInitData(String(initData)) || { invalid: true };
  const auth = req.headers.authorization || '';
  const supplied = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
  if (process.env.APP_PASSWORD && supplied === `tasks:${process.env.APP_PASSWORD}`) return { role: 'owner', id: '' };
  return null;
}
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error('Слишком большой запрос'); }
  return raw ? JSON.parse(raw) : {};
}
async function notify(task, action) {
  const chat = managerId;
  if (!botToken || !chat) return false;
  const due = task.due_date ? `\nСрок: ${task.due_date}` : '';
  const next = task.next_step ? `\nСледующий шаг: ${task.next_step}` : '';
  const block = task.blocker ? `\nБлокер: ${task.blocker}` : '';
  const assignee = task.assignee ? `\nОтветственный: ${task.assignee}` : '';
  const tags = cleanTags(task.tags).length ? `\nТеги: ${cleanTags(task.tags).map(tag => `#${tag}`).join(' ')}` : '';
  const text = `📌 ${action}\n${task.title}\nСтатус: ${task.status} · Приоритет: ${task.priority}${assignee}${tags}${due}${next}${block}`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text })
    });
    return r.ok;
  } catch { return false; }
}
async function sendDueReminders() {
  if (!botToken || !managerId) return;
  const now = stamp();
  const dueTasks = db.prepare(`SELECT * FROM tasks WHERE archived=0 AND status!='Готово' AND reminder_at!='' AND reminder_at<=? AND reminder_sent_at='' ORDER BY reminder_at LIMIT 20`).all(now);
  for (const task of dueTasks) {
    const delivered = await notify(task, 'Напоминание');
    if (delivered) {
      let nextReminder = '';
      if (task.repeat_rule && task.reminder_at) {
        const next = new Date(task.reminder_at);
        if (task.repeat_rule === 'daily') next.setDate(next.getDate() + 1);
        if (task.repeat_rule === 'weekly') next.setDate(next.getDate() + 7);
        if (task.repeat_rule === 'monthly') next.setMonth(next.getMonth() + 1);
        nextReminder = next.toISOString();
      }
      db.prepare('UPDATE tasks SET reminder_sent_at=?,reminder_at=?,updated_at=? WHERE id=?').run(nextReminder ? '' : now, nextReminder, now, task.id);
    }
  }
}
async function telegramCall(method, payload, timeout = 15000) {
  if (!botToken) throw new Error('Bot token is not configured');
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${method} failed`);
  return result.result;
}
async function handleTelegramUpdate(update) {
  const message = update.message;
  if (!message?.chat || message.chat.type !== 'private' || !message.from) return;
  const command = String(message.text || '').trim().split(/\s+/, 1)[0].split('@')[0];
  if (command === '/start') {
    await telegramCall('sendMessage', {
      chat_id: message.chat.id,
      text: 'Ритм — ваши задачи и прогресс. Откройте доску кнопкой ниже.',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть Ритм', web_app: { url: webAppUrl } }]] }
    });
  } else if (command === '/id') {
    await telegramCall('sendMessage', { chat_id: message.chat.id, text: `Ваш Telegram ID: ${message.from.id}` });
  } else if (command === '/help') {
    await telegramCall('sendMessage', { chat_id: message.chat.id, text: 'Команды:\n/start — открыть мини-приложение\n/id — показать ваш Telegram ID' });
  } else if (command === '/today') {
    const today = new Date().toISOString().slice(0, 10);
    const dueTasks = taskViews(db.prepare(`SELECT * FROM tasks WHERE archived=0 AND status!='Готово' AND due_date=? ORDER BY priority DESC, updated_at DESC`).all(today));
    const text = dueTasks.length ? `Задачи на сегодня:\n\n${dueTasks.map(task => `• ${task.title} — ${task.status}`).join('\n')}` : 'На сегодня задач нет.';
    await telegramCall('sendMessage', { chat_id: message.chat.id, text });
  }
}
async function startTelegramBot() {
  if (!botToken) { console.warn('Telegram bot token is missing; Mini App launcher is disabled.'); return; }
  try {
    await telegramCall('setMyCommands', { commands: [
      { command: 'start', description: 'Открыть Ритм' },
      { command: 'id', description: 'Показать мой Telegram ID' },
      { command: 'help', description: 'Помощь' },
      { command: 'today', description: 'Задачи на сегодня' }
    ] });
    await telegramCall('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть Ритм', web_app: { url: webAppUrl } } });
    console.log('Telegram Mini App menu button configured.');
  } catch (error) { console.warn(`Could not configure Telegram Mini App menu button: ${error.message}`); }
  let offset = 0;
  while (true) {
    let updates;
    try { updates = await telegramCall('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35000); }
    catch (error) {
      console.error(`Telegram polling stopped: ${error.message}`);
      if (/conflict|webhook/i.test(error.message)) return;
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      try { await handleTelegramUpdate(update); }
      catch (error) { console.error(`Telegram update ${update.update_id} failed: ${error.message}`); }
    }
  }
}
function logEvent(id, message) { db.prepare('INSERT INTO events(task_id,message,created_at) VALUES(?,?,?)').run(id, message, stamp()); }
const selectTask = db.prepare('SELECT * FROM tasks WHERE id=?');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && /^\/fonts\/[A-Za-z0-9._-]+$/.test(url.pathname)) {
      const filename = url.pathname.slice('/fonts/'.length);
      const allowed = new Set(['HelveticaNeue-Light-Cyr.woff2', 'HelveticaNeue-UltraLight-Cyr.woff2']);
      if (!allowed.has(filename)) return json(res, 404, { error: 'Не найдено' });
      const font = await readFile(join(root, 'fonts', filename));
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(font);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(join(root, 'index.html')); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    const principal = url.pathname.startsWith('/api/') ? authenticate(req) : null;
    if (url.pathname.startsWith('/api/')) {
      if (principal?.invalid) return json(res, 401, { error: 'Не удалось проверить сессию Telegram. Закройте и снова откройте мини-приложение.' });
      if (principal?.denied) return json(res, 403, { error: 'Доступ к доске не настроен для вашего Telegram-аккаунта.' });
      if (!principal) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Progress Desk", charset="UTF-8"', 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'Введите пароль доски.' }));
      }
      const isCommentRequest = /\/comments$/.test(url.pathname);
      if (principal.role !== 'owner' && req.method !== 'GET' && !isCommentRequest) return json(res, 403, { error: 'Руководитель может просматривать задачи и оставлять комментарии, но изменять свойства может только владелец.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const includeArchived = url.searchParams.get('archived') === '1';
      const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const status = String(url.searchParams.get('status') || '').trim();
      const priority = String(url.searchParams.get('priority') || '').trim();
      const tag = String(url.searchParams.get('tag') || '').trim().replace(/^#/, '').toLowerCase();
      const items = taskViews(db.prepare(`SELECT t.*,(SELECT message FROM events e WHERE e.task_id=t.id ORDER BY e.id DESC LIMIT 1) AS last_event FROM tasks t WHERE (?=1 OR t.archived=0) ORDER BY t.sort_order, CASE t.status WHEN 'Готово' THEN 1 ELSE 0 END, CASE t.priority WHEN 'Срочный' THEN 0 WHEN 'Высокий' THEN 1 WHEN 'Обычный' THEN 2 ELSE 3 END, CASE WHEN t.due_date='' THEN 1 ELSE 0 END,t.due_date,t.updated_at DESC`).all(includeArchived ? 1 : 0).filter(task => {
        const tags = taskView(task).tags;
        const haystack = `${task.title} ${task.description} ${task.next_step} ${task.blocker} ${task.assignee} ${tags.join(' ')}`.toLowerCase();
        return (!query || haystack.includes(query)) && (!status || task.status === status) && (!priority || task.priority === priority) && (!tag || tags.some(item => item.toLowerCase() === tag));
      }));
      return json(res, 200, items);
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      return json(res, 200, db.prepare(`SELECT e.*,t.title FROM events e JOIN tasks t ON t.id=e.task_id ORDER BY e.id DESC LIMIT 30`).all());
    }
    if (req.method === 'GET' && /^\/api\/tasks\/\d+\/comments$/.test(url.pathname)) {
      const taskId = Number(url.pathname.split('/')[3]);
      return json(res, 200, db.prepare('SELECT * FROM comments WHERE task_id=? ORDER BY id ASC').all(taskId));
    }
    if (req.method === 'POST' && /^\/api\/tasks\/\d+\/comments$/.test(url.pathname)) {
      const taskId = Number(url.pathname.split('/')[3]);
      const patch = await body(req); const text = String(patch.body || '').trim();
      if (!text) return json(res, 400, { error: 'Комментарий не может быть пустым' });
      const author = String(patch.author || principal.user?.first_name || (principal.role === 'manager' ? 'Руководитель' : 'Владелец')).trim().slice(0, 80);
      const result = db.prepare('INSERT INTO comments(task_id,author,body,created_at) VALUES(?,?,?,?)').run(taskId, author, text.slice(0, 4000), stamp());
      logEvent(taskId, `Комментарий: ${text.slice(0, 90)}`);
      return json(res, 201, db.prepare('SELECT * FROM comments WHERE id=?').get(Number(result.lastInsertRowid)));
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
      const tags = cleanTags(patch.tags ?? old?.tags);
      const assignee = String(patch.assignee ?? old?.assignee ?? '').trim().slice(0, 120);
      const dueDate = String(patch.due_date ?? old?.due_date ?? '').slice(0, 32);
      const reminderAt = String(patch.reminder_at ?? old?.reminder_at ?? '').slice(0, 40);
      const repeatRule = String(patch.repeat_rule ?? old?.repeat_rule ?? '').slice(0, 40);
      const archived = patch.archived === undefined ? Number(old?.archived || 0) : (patch.archived ? 1 : 0);
      const parentId = patch.parent_id === undefined ? (old?.parent_id || null) : (patch.parent_id ? Number(patch.parent_id) : null);
      const completedAt = status === 'Готово' ? (old?.completed_at || stamp()) : '';
      const reminderSentAt = reminderAt !== String(old?.reminder_at || '') ? '' : String(old?.reminder_sent_at || '');
      const updatedAt = stamp();
      const values = [title, String(patch.description ?? old?.description ?? ''), status, priority, dueDate, String(patch.next_step ?? old?.next_step ?? ''), String(patch.blocker ?? old?.blocker ?? ''), JSON.stringify(tags), assignee, reminderAt, repeatRule, archived, completedAt, parentId, Number(patch.sort_order ?? old?.sort_order ?? 0), reminderSentAt, updatedAt];
      if (isNew) {
        const result = db.prepare('INSERT INTO tasks(title,description,status,priority,due_date,next_step,blocker,tags,assignee,reminder_at,repeat_rule,archived,completed_at,parent_id,sort_order,reminder_sent_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values.slice(0, 16), stamp(), updatedAt);
        const task = selectTask.get(Number(result.lastInsertRowid)); logEvent(task.id, 'Задача создана');
        const delivered = await notify(task, 'Новая задача'); return json(res, 201, { ...taskView(task), notification: delivered });
      }
      db.prepare('UPDATE tasks SET title=?,description=?,status=?,priority=?,due_date=?,next_step=?,blocker=?,tags=?,assignee=?,reminder_at=?,repeat_rule=?,archived=?,completed_at=?,parent_id=?,sort_order=?,reminder_sent_at=?,updated_at=? WHERE id=?').run(...values, id);
      const task = selectTask.get(id);
      const changes = [];
      for (const field of ['title','description','status','priority','due_date','next_step','blocker','tags','assignee','reminder_at','repeat_rule','archived','parent_id']) if (String(old[field] ?? '') !== String(task[field] ?? '')) changes.push(field);
      if (changes.length) logEvent(id, `Обновлено: ${changes.map(x => ({title:'название',description:'заметки',status:'статус',priority:'приоритет',due_date:'срок',next_step:'следующий шаг',blocker:'блокер',tags:'теги',assignee:'ответственный',reminder_at:'напоминание',repeat_rule:'повтор',archived:'архив',parent_id:'связь'})[x]).join(', ')}`);
      const delivered = changes.length ? await notify(task, 'Обновление задачи') : false;
      return json(res, 200, { ...taskView(task), notification: delivered });
    }
    if (req.method === 'DELETE' && /^\/api\/tasks\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1));
      db.prepare('DELETE FROM events WHERE task_id=?').run(id); const result = db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      return json(res, result.changes ? 200 : 404, { ok: Boolean(result.changes) });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, {
      role: principal.role, canEdit: principal.role === 'owner',
      telegramEnabled: Boolean(botToken && managerId),
      accessReady: Boolean(ownerId && managerId)
    });
    json(res, 404, { error: 'Не найдено' });
  } catch (err) { json(res, 500, { error: err.message || 'Внутренняя ошибка' }); }
});
const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => console.log(`Progress Desk: http://localhost:${port}`));
void sendDueReminders();
setInterval(() => { void sendDueReminders(); }, 60_000);
void startTelegramBot();
