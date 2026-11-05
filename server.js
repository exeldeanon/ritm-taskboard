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
  actor TEXT NOT NULL DEFAULT 'Система',
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
);
CREATE TABLE IF NOT EXISTS task_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  due_date TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'manager',
  approved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_pending (
  telegram_id TEXT PRIMARY KEY,
  requested_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
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
ensureColumn('tasks', 'scheduled_at', "TEXT NOT NULL DEFAULT ''");
ensureColumn('tasks', 'depends_on_id', 'INTEGER');
ensureColumn('task_steps', 'step_status', "TEXT NOT NULL DEFAULT 'Следующий'");
ensureColumn('task_steps', 'due_date', "TEXT NOT NULL DEFAULT ''");
ensureColumn('task_steps', 'assignee', "TEXT NOT NULL DEFAULT ''");
ensureColumn('task_steps', 'note', "TEXT NOT NULL DEFAULT ''");
ensureColumn('task_steps', 'url', "TEXT NOT NULL DEFAULT ''");
ensureColumn('events', 'actor', "TEXT NOT NULL DEFAULT 'Система'");

const statuses = ['Входящие', 'Запланировано', 'В работе', 'Жду ответа', 'Готово'];
const priorities = ['Низкий', 'Обычный', 'Высокий', 'Срочный'];
const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
const webAppUrl = process.env.WEBAPP_URL || 'https://bot-1793823483-4147-exel.bothost.tech/';
const ownerId = process.env.OWNER_TELEGRAM_ID || '';
const managerId = process.env.MANAGER_CHAT_ID || '';
const ownerPassword = process.env.OWNER_PASSWORD || process.env.APP_PASSWORD || '';
const managerPassword = process.env.MANAGER_PASSWORD || process.env.APP_PASSWORD || '';
const buildVersion = 'all-features-20261105';
const digestHour = Math.max(0, Math.min(23, Number(process.env.DAILY_DIGEST_HOUR || 18)));
const launchUrl = (() => { try { const parsed = new URL(webAppUrl); parsed.searchParams.set('v', buildVersion); return parsed.toString(); } catch { return webAppUrl; } })();
const stamp = () => new Date().toISOString();
const cleanTags = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map(item => String(item).trim().replace(/^#/, '').slice(0, 32)).filter(Boolean))].slice(0, 12);
function taskView(task) {
  if (!task) return task;
  let tags = [];
  try { tags = JSON.parse(task.tags || '[]'); } catch { tags = cleanTags(task.tags); }
  let steps = [];
  try { steps = JSON.parse(task.steps_json || '[]'); } catch {}
  const { steps_json, ...rest } = task;
  return { ...rest, tags, steps };
}
const taskViews = tasks => tasks.map(taskView);
const taskTemplates = [
  { id: 'website-launch', title: 'Запуск сайта', description: 'Подготовить и выпустить новый сайт.', next_step: 'Собрать требования', tags: ['сайт'], steps: ['Собрать требования', 'Подготовить прототип', 'Согласовать дизайн', 'Разработать страницу', 'Проверить и опубликовать'] },
  { id: 'lead-processing', title: 'Обработка лида', description: 'Провести лид от первого контакта до результата.', next_step: 'Связаться с клиентом', tags: ['лид'], steps: ['Связаться с клиентом', 'Уточнить потребность', 'Подготовить предложение', 'Зафиксировать результат'] },
  { id: 'weekly-report', title: 'Еженедельный отчёт', description: 'Собрать результаты недели и подготовить отчёт.', next_step: 'Собрать цифры', tags: ['отчёт'], steps: ['Собрать цифры', 'Проверить данные', 'Сформировать выводы', 'Отправить отчёт'] }
];
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
function authenticate(req) {
  const id = String(req.headers['x-telegram-user-id'] || '').trim();
  if (id) {
    const user = db.prepare('SELECT * FROM telegram_users WHERE telegram_id=?').get(id);
    if (user) return { id, role: user.role, user: { id } };
    return { denied: true, user: { id } };
  }
  return null;
}
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error('Слишком большой запрос'); }
  return raw ? JSON.parse(raw) : {};
}
const notificationFieldLabels = { title: 'Название', description: 'Описание', status: 'Статус задачи', priority: 'Приоритет', due_date: 'Срок', next_step: 'Следующий шаг', blocker: 'Блокер', tags: 'Теги', assignee: 'Ответственный', reminder_at: 'Напоминание', repeat_rule: 'Повтор', scheduled_at: 'Планирование', depends_on_id: 'Зависимость', archived: 'Архив', parent_id: 'Связанная задача' };
function notificationValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ') || '—';
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed.join(', ') || '—'; } catch {} }
  return String(value);
}
async function notify(task, action, context = {}) {
  const chat = managerId;
  if (!botToken || !chat || !task) return false;
  const steps = task?.id ? db.prepare('SELECT * FROM task_steps WHERE task_id=? ORDER BY position,id').all(task.id) : [];
  const due = task.due_date ? `\nСрок: ${task.due_date}` : '';
  const next = task.next_step ? `\nСледующий шаг: ${task.next_step}` : '';
  const block = task.blocker ? `\nБлокер: ${task.blocker}` : '';
  const assignee = task.assignee ? `\nОтветственный: ${task.assignee}` : '';
  const tags = cleanTags(task.tags).length ? `\nТеги: ${cleanTags(task.tags).map(tag => `#${tag}`).join(' ')}` : '';
  const scheduled = task.scheduled_at ? `\nЗапланировано: ${task.scheduled_at}` : '';
  const dependency = task.depends_on_title ? `\nПосле задачи: ${task.depends_on_title}${task.depends_on_status ? ` (${task.depends_on_status})` : ''}` : '';
  const progress = steps.length ? `\nПрогресс шагов: ${steps.filter(step => step.step_status === 'Готово' || step.done).length}/${steps.length}` : '\nШаги: не добавлены';
  const stepLines = steps.length ? `\n\nШаги задачи:\n${steps.map((step, index) => `${step.step_status === 'Готово' || step.done ? '✅' : step.step_status === 'Проблема' ? '⚠️' : step.step_status === 'Жду ответа' ? '↗️' : step.step_status === 'В работе' ? '⏳' : '▫️'} ${index + 1}. ${step.title} — ${step.step_status || (step.done ? 'Готово' : 'Следующий')}${step.due_date ? ` · срок ${step.due_date}` : ''}${step.assignee ? ` · ${step.assignee}` : ''}${step.note ? `\n   ${step.note}` : ''}`).join('\n')}` : '';
  const changedStep = context.step ? `\n\nШаг задачи ${Number.isFinite(Number(context.step.position)) ? Number(context.step.position) + 1 : '—'}: «${context.step.title}»\nСтатус шага: ${context.step.step_status || context.step.status || 'Следующий'}${context.previousStatus ? `\nБыло: ${context.previousStatus}` : ''}${context.step.due_date ? `\nСрок шага: ${context.step.due_date}` : ''}${context.step.assignee ? `\nОтветственный за шаг: ${context.step.assignee}` : ''}${context.step.note ? `\nКомментарий к шагу: ${context.step.note}` : ''}` : '';
  const comment = context.comment ? `\n\nКомментарий от ${context.comment.author}:\n${context.comment.body}` : '';
  const changes = context.changes?.length ? `\n\nЧто изменилось:\n${context.changes.map(item => `• ${notificationFieldLabels[item.field] || item.field}: ${notificationValue(item.before)} → ${notificationValue(item.after)}`).join('\n')}` : '';
  const statusSync = context.taskStatusChange ? `\n\nАвтостатус по шагам: ${context.taskStatusChange.before} → ${context.taskStatusChange.after}` : '';
  const text = `📌 ${action}\nЗадача #${task.id}: ${task.title}\nСтатус задачи: ${task.status}\nПриоритет: ${task.priority}${assignee}${tags}${scheduled}${dependency}${due}${next}${block}${progress}${statusSync}${changes}${changedStep}${comment}${stepLines}`.slice(0, 3900);
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, reply_markup: { inline_keyboard: [[{ text: 'Открыть задачу', web_app: { url: `${launchUrl}#task=${task.id}` } }]] } })
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
  const telegramId = String(message.from.id);
  const approved = db.prepare('SELECT * FROM telegram_users WHERE telegram_id=?').get(telegramId);
  const command = String(message.text || '').trim().split(/\s+/, 1)[0].split('@')[0];
  const roleKeyboard = { keyboard: [[{ text: 'Начальство' }, { text: 'Менеджер' }]], resize_keyboard: true, one_time_keyboard: true };
  if (command === '/logout') {
    db.prepare('DELETE FROM telegram_users WHERE telegram_id=?').run(telegramId);
    db.prepare('DELETE FROM telegram_pending WHERE telegram_id=?').run(telegramId);
    await telegramCall('sendMessage', { chat_id: message.chat.id, text: 'Роль сброшена. Выберите, как войти в alwtasks.', reply_markup: roleKeyboard });
    return;
  }
  if (command === '/start') {
    if (!approved) {
      await telegramCall('sendMessage', { chat_id: message.chat.id, text: 'Выберите роль для входа в alwtasks.', reply_markup: roleKeyboard });
      return;
    }
    await telegramCall('sendMessage', {
      chat_id: message.chat.id,
      text: 'alwtasks — ваши задачи и прогресс. Откройте доску кнопкой ниже.',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть alwtasks', web_app: { url: launchUrl } }]] }
    });
  } else if (!approved && message.text && !String(message.text).startsWith('/')) {
    const text = String(message.text).trim();
    if (text === 'Начальство' || text === 'Менеджер') {
      const requestedRole = text === 'Начальство' ? 'manager' : 'owner';
      db.prepare('INSERT INTO telegram_pending(telegram_id,requested_role,created_at) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET requested_role=excluded.requested_role,created_at=excluded.created_at').run(telegramId, requestedRole, stamp());
      await telegramCall('sendMessage', { chat_id: message.chat.id, text: text === 'Начальство' ? 'Введите пароль начальства.' : 'Введите пароль менеджера.', reply_markup: { remove_keyboard: true } });
      return;
    }
    const pending = db.prepare('SELECT * FROM telegram_pending WHERE telegram_id=?').get(telegramId);
    const expectedPassword = pending?.requested_role === 'owner' ? ownerPassword : pending?.requested_role === 'manager' ? managerPassword : '';
    if (pending && expectedPassword && text === expectedPassword) {
      db.prepare('INSERT INTO telegram_users(telegram_id,role,approved_at) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET role=excluded.role,approved_at=excluded.approved_at').run(telegramId, pending.requested_role, stamp());
      db.prepare('DELETE FROM telegram_pending WHERE telegram_id=?').run(telegramId);
      await telegramCall('sendMessage', { chat_id: message.chat.id, text: `Готово. Вход выполнен как ${pending.requested_role === 'owner' ? 'менеджер' : 'начальство'}.`, reply_markup: { inline_keyboard: [[{ text: 'Открыть alwtasks', web_app: { url: launchUrl } }]] } });
    } else {
      await telegramCall('sendMessage', { chat_id: message.chat.id, text: 'Пароль не подошёл. Отправьте /start и выберите роль заново.' });
    }
    return;
  } else if (command === '/id') {
    if (!approved) return telegramCall('sendMessage', { chat_id: message.chat.id, text: 'Сначала отправьте /start и пароль доступа.' });
    await telegramCall('sendMessage', { chat_id: message.chat.id, text: `Ваш Telegram ID: ${message.from.id}` });
  } else if (command === '/help') {
    if (!approved) return telegramCall('sendMessage', { chat_id: message.chat.id, text: 'Сначала отправьте /start и пароль доступа.' });
    await telegramCall('sendMessage', { chat_id: message.chat.id, text: 'Команды:\n/start — открыть мини-приложение\n/id — показать ваш Telegram ID' });
  } else if (command === '/report') {
    if (!approved) return telegramCall('sendMessage', { chat_id: message.chat.id, text: 'Сначала отправьте /start и пароль доступа.' });
    const delivered = await sendDailyDigest(true, String(message.chat.id));
    if (!delivered) await telegramCall('sendMessage', { chat_id: message.chat.id, text: 'Не удалось сформировать отчёт. Проверьте настройки Telegram-бота.' });
  } else if (command === '/today') {
    if (!approved) return telegramCall('sendMessage', { chat_id: message.chat.id, text: 'Сначала отправьте /start и пароль доступа.' });
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
      { command: 'start', description: 'Открыть alwtasks' },
      { command: 'id', description: 'Показать мой Telegram ID' },
      { command: 'help', description: 'Помощь' },
      { command: 'report', description: 'Полный отчёт по задачам' },
      { command: 'today', description: 'Задачи на сегодня' },
      { command: 'logout', description: 'Сменить роль' }
    ] });
    await telegramCall('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть alwtasks', web_app: { url: launchUrl } } });
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
function actorLabel(principal) { return principal?.role === 'manager' ? 'Начальство' : principal?.role === 'owner' ? 'Менеджер' : 'Система'; }
function logEvent(id, message, actor = 'Система') { db.prepare('INSERT INTO events(task_id,message,actor,created_at) VALUES(?,?,?,?)').run(id, message, actor, stamp()); }
const selectTask = db.prepare('SELECT t.*,(SELECT title FROM tasks dep WHERE dep.id=t.depends_on_id) AS depends_on_title,(SELECT status FROM tasks dep WHERE dep.id=t.depends_on_id) AS depends_on_status FROM tasks t WHERE t.id=?');
function syncTaskStatus(taskId) {
  const task = selectTask.get(taskId);
  if (!task) return null;
  const steps = db.prepare('SELECT * FROM task_steps WHERE task_id=? ORDER BY position,id').all(taskId);
  if (!steps.length) return null;
  const allDone = steps.every(step => step.step_status === 'Готово' || step.done);
  const hasProblem = steps.some(step => step.step_status === 'Проблема');
  const hasWaiting = steps.some(step => step.step_status === 'Жду ответа');
  const hasWork = steps.some(step => step.step_status === 'В работе');
  const nextStatus = allDone ? 'Готово' : hasProblem || hasWaiting ? 'Жду ответа' : hasWork ? 'В работе' : 'Запланировано';
  if (nextStatus === task.status) return null;
  const now = stamp();
  db.prepare('UPDATE tasks SET status=?,completed_at=?,updated_at=? WHERE id=?').run(nextStatus, nextStatus === 'Готово' ? (task.completed_at || now) : '', now, taskId);
  logEvent(taskId, `Автостатус по шагам: ${task.status} → ${nextStatus}`);
  return { before: task.status, after: nextStatus };
}
function moscowNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(item => [item.type, item.value]));
  return { ...parts, date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
function appSetting(key) { return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value || ''; }
function setAppSetting(key, value) { db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
async function sendDailyDigest(force = false, targetChat = managerId) {
  if (!botToken || !targetChat) return false;
  const now = moscowNow();
  if (!force && (now.hour < digestHour || appSetting('daily_digest_date') === now.date)) return false;
  const active = db.prepare("SELECT * FROM tasks WHERE archived=0 AND status!='Готово' ORDER BY CASE WHEN due_date='' THEN 1 ELSE 0 END,due_date,priority DESC,updated_at DESC").all();
  const overdue = active.filter(task => task.due_date && task.due_date < now.date);
  const today = active.filter(task => task.due_date === now.date);
  const waiting = active.filter(task => task.status === 'Жду ответа' || db.prepare("SELECT 1 FROM task_steps WHERE task_id=? AND step_status IN ('Жду ответа','Проблема') LIMIT 1").get(task.id));
  const completed = db.prepare("SELECT * FROM tasks WHERE completed_at LIKE ? ORDER BY completed_at DESC LIMIT 20").all(`${now.date}%`);
  const list = (items, empty = 'нет') => items.length ? items.slice(0, 12).map(task => `• #${task.id} ${task.title}${task.assignee ? ` · ${task.assignee}` : ''}${task.due_date ? ` · до ${task.due_date}` : ''}`).join('\n') : empty;
  const text = `📊 Ежедневный контроль alwtasks\n${now.date}\n\n🔴 Просрочено (${overdue.length})\n${list(overdue)}\n\n🟡 На сегодня (${today.length})\n${list(today)}\n\n↗️ Ждут ответа или решения (${waiting.length})\n${list(waiting)}\n\n✅ Завершено сегодня (${completed.length})\n${list(completed)}`.slice(0, 3900);
  try {
    await telegramCall('sendMessage', { chat_id: targetChat, text, reply_markup: { inline_keyboard: [[{ text: 'Открыть контроль', web_app: { url: `${launchUrl}#control` } }]] } });
    if (String(targetChat) === String(managerId)) setAppSetting('daily_digest_date', now.date);
    return true;
  } catch { return false; }
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, version: buildVersion });
    if (req.method === 'GET' && /^\/fonts\/[A-Za-z0-9._-]+$/.test(url.pathname)) {
      const filename = url.pathname.slice('/fonts/'.length);
      const allowed = new Set(['HelveticaNeue-Light-Cyr.woff2', 'HelveticaNeue-UltraLight-Cyr.woff2']);
      if (!allowed.has(filename)) return json(res, 404, { error: 'Не найдено' });
      const font = await readFile(join(root, 'fonts', filename));
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(font);
    }
    if (req.method === 'GET' && url.pathname === '/assets/alwtasks-logo.png') {
      const logo = await readFile(join(root, 'assets', 'alwtasks-logo.png'));
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(logo);
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
      const items = taskViews(db.prepare(`SELECT t.*,(SELECT message FROM events e WHERE e.task_id=t.id ORDER BY e.id DESC LIMIT 1) AS last_event,(SELECT COUNT(*) FROM task_steps s WHERE s.task_id=t.id) AS step_count,(SELECT COUNT(*) FROM task_steps s WHERE s.task_id=t.id AND s.done=1) AS completed_step_count,(SELECT COALESCE(json_group_array(json_object('id',s.id,'title',s.title,'done',s.done,'step_status',s.step_status,'due_date',s.due_date,'assignee',s.assignee,'note',s.note,'url',s.url,'position',s.position)), '[]') FROM (SELECT id,title,done,step_status,due_date,assignee,note,url,position FROM task_steps WHERE task_id=t.id ORDER BY position,id) s) AS steps_json,(SELECT title FROM tasks dep WHERE dep.id=t.depends_on_id) AS depends_on_title,(SELECT status FROM tasks dep WHERE dep.id=t.depends_on_id) AS depends_on_status FROM tasks t WHERE (?=1 OR t.archived=0) ORDER BY t.sort_order, CASE t.status WHEN 'Готово' THEN 1 ELSE 0 END, CASE t.priority WHEN 'Срочный' THEN 0 WHEN 'Высокий' THEN 1 WHEN 'Обычный' THEN 2 ELSE 3 END, CASE WHEN t.due_date='' THEN 1 ELSE 0 END,t.due_date,t.updated_at DESC`).all(includeArchived ? 1 : 0).filter(task => {
        const tags = taskView(task).tags;
        const haystack = `${task.title} ${task.description} ${task.next_step} ${task.blocker} ${task.assignee} ${tags.join(' ')}`.toLowerCase();
        return (!query || haystack.includes(query)) && (!status || task.status === status) && (!priority || task.priority === priority) && (!tag || tags.some(item => item.toLowerCase() === tag));
      }));
      return json(res, 200, items);
    }
    if (req.method === 'GET' && url.pathname === '/api/templates') return json(res, 200, taskTemplates);
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const exportTasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
      const exportSteps = db.prepare('SELECT * FROM task_steps ORDER BY task_id,position,id').all();
      const exportComments = db.prepare('SELECT * FROM comments ORDER BY task_id,id').all();
      const exportEvents = db.prepare('SELECT * FROM events ORDER BY task_id,id').all();
      if (url.searchParams.get('format') === 'csv') {
        const csv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const rows = [['Тип','ID','Задача','Название','Статус','Приоритет','Срок','Ответственный','Шаг/комментарий','Статус шага','Комментарий','Ссылка','Изменил','Дата']];
        for (const task of exportTasks) rows.push(['Задача', task.id, task.title, task.title, task.status, task.priority, task.due_date, task.assignee, '', '', task.description, '', '', task.updated_at]);
        for (const step of exportSteps) rows.push(['Шаг', step.id, step.task_id, step.title, '', '', step.due_date, step.assignee, step.title, step.step_status, step.note, step.url, '', step.updated_at]);
        for (const comment of exportComments) rows.push(['Комментарий', comment.id, comment.task_id, '', '', '', '', comment.author, '', '', comment.body, '', comment.author, comment.created_at]);
        const output = rows.map(row => row.map(csv).join(',')).join('\r\n');
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="alwtasks-export.csv"' });
        return res.end(`\uFEFF${output}`);
      }
      return json(res, 200, { exported_at: stamp(), tasks: exportTasks, steps: exportSteps, comments: exportComments, events: exportEvents });
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
      logEvent(taskId, `Комментарий: ${text.slice(0, 90)}`, actorLabel(principal));
      const comment = db.prepare('SELECT * FROM comments WHERE id=?').get(Number(result.lastInsertRowid));
      const task = selectTask.get(taskId); const delivered = await notify(task, 'Новый комментарий', { comment });
      return json(res, 201, { ...comment, notification: delivered });
    }
    if (req.method === 'GET' && /^\/api\/tasks\/\d+\/steps$/.test(url.pathname)) {
      const taskId = Number(url.pathname.split('/')[3]);
      return json(res, 200, db.prepare('SELECT * FROM task_steps WHERE task_id=? ORDER BY position,id').all(taskId));
    }
    if (req.method === 'POST' && /^\/api\/tasks\/\d+\/steps$/.test(url.pathname)) {
      const taskId = Number(url.pathname.split('/')[3]);
      const patch = await body(req); const title = String(patch.title || '').trim();
      if (!title) return json(res, 400, { error: 'Название шага не может быть пустым' });
      const stepStatus = ['Следующий','В работе','Жду ответа','Проблема','Готово'].includes(patch.step_status) ? patch.step_status : 'Следующий';
      const dueDate = String(patch.due_date || '').slice(0, 32);
      const assignee = String(patch.assignee || '').trim().slice(0, 120);
      const note = String(patch.note || '').trim().slice(0, 1000);
      const stepUrl = String(patch.url || '').trim().slice(0, 1000);
      const now = stamp(); const position = Number(db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS next FROM task_steps WHERE task_id=?').get(taskId).next);
      const result = db.prepare('INSERT INTO task_steps(task_id,title,done,step_status,due_date,assignee,note,url,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(taskId, title.slice(0, 240), stepStatus === 'Готово' ? 1 : 0, stepStatus, dueDate, assignee, note, stepUrl, position, now, now);
      logEvent(taskId, `Добавлен шаг: ${title.slice(0, 90)}`, actorLabel(principal));
      const statusChange = syncTaskStatus(taskId);
      const step = db.prepare('SELECT * FROM task_steps WHERE id=?').get(Number(result.lastInsertRowid));
      const task = selectTask.get(taskId); const delivered = await notify(task, 'Добавлен новый шаг', { step, taskStatusChange: statusChange });
      return json(res, 201, { ...step, notification: delivered });
    }
    if (req.method === 'PATCH' && /^\/api\/steps\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1)); const old = db.prepare('SELECT * FROM task_steps WHERE id=?').get(id);
      if (!old) return json(res, 404, { error: 'Шаг не найден' });
      const patch = await body(req); const title = patch.title === undefined ? old.title : String(patch.title).trim();
      const status = patch.step_status === undefined ? (patch.done === undefined ? (old.step_status || (old.done ? 'Готово' : 'Следующий')) : (patch.done ? 'Готово' : 'В работе')) : (['Следующий','В работе','Жду ответа','Проблема','Готово'].includes(patch.step_status) ? patch.step_status : 'Следующий');
      const done = status === 'Готово' ? 1 : 0; const now = stamp();
      const dueDate = patch.due_date === undefined ? old.due_date : String(patch.due_date || '').slice(0, 32);
      const assignee = patch.assignee === undefined ? old.assignee : String(patch.assignee || '').trim().slice(0, 120);
      const note = patch.note === undefined ? old.note : String(patch.note || '').trim().slice(0, 1000);
      const stepUrl = patch.url === undefined ? old.url : String(patch.url || '').trim().slice(0, 1000);
      db.prepare('UPDATE task_steps SET title=?,done=?,step_status=?,due_date=?,assignee=?,note=?,url=?,position=?,updated_at=? WHERE id=?').run(title.slice(0, 240), done, status, dueDate, assignee, note, stepUrl, Number(patch.position ?? old.position), now, id);
      logEvent(old.task_id, `Шаг «${title.slice(0, 70)}»: ${status}`, actorLabel(principal));
      const statusChange = syncTaskStatus(old.task_id);
      const step = db.prepare('SELECT * FROM task_steps WHERE id=?').get(id);
      const task = selectTask.get(old.task_id); const delivered = await notify(task, `Статус шага изменён: ${status}`, { step, previousStatus: old.step_status || (old.done ? 'Готово' : 'Следующий'), taskStatusChange: statusChange });
      return json(res, 200, { ...step, notification: delivered });
    }
    if (req.method === 'DELETE' && /^\/api\/steps\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1)); const old = db.prepare('SELECT * FROM task_steps WHERE id=?').get(id);
      if (!old) return json(res, 404, { error: 'Шаг не найден' });
      db.prepare('DELETE FROM task_steps WHERE id=?').run(id); logEvent(old.task_id, `Удалён шаг: ${old.title.slice(0, 90)}`, actorLabel(principal));
      const statusChange = syncTaskStatus(old.task_id);
      const task = selectTask.get(old.task_id); const delivered = await notify(task, 'Шаг удалён', { step: old, taskStatusChange: statusChange });
      return json(res, 200, { ok: true, notification: delivered });
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
      const scheduledAt = String(patch.scheduled_at ?? old?.scheduled_at ?? '').slice(0, 40);
      const dependsOnId = patch.depends_on_id === undefined ? (old?.depends_on_id || null) : (patch.depends_on_id ? Number(patch.depends_on_id) : null);
      if (dependsOnId && ((!isNew && dependsOnId === id) || !db.prepare('SELECT id FROM tasks WHERE id=?').get(dependsOnId))) return json(res, 400, { error: 'Выберите существующую другую задачу для зависимости' });
      const archived = patch.archived === undefined ? Number(old?.archived || 0) : (patch.archived ? 1 : 0);
      const parentId = patch.parent_id === undefined ? (old?.parent_id || null) : (patch.parent_id ? Number(patch.parent_id) : null);
      const completedAt = status === 'Готово' ? (old?.completed_at || stamp()) : '';
      const reminderSentAt = reminderAt !== String(old?.reminder_at || '') ? '' : String(old?.reminder_sent_at || '');
      const updatedAt = stamp();
      const values = [title, String(patch.description ?? old?.description ?? ''), status, priority, dueDate, String(patch.next_step ?? old?.next_step ?? ''), String(patch.blocker ?? old?.blocker ?? ''), JSON.stringify(tags), assignee, reminderAt, repeatRule, scheduledAt, dependsOnId, archived, completedAt, parentId, Number(patch.sort_order ?? old?.sort_order ?? 0), reminderSentAt, updatedAt];
      if (isNew) {
        const result = db.prepare('INSERT INTO tasks(title,description,status,priority,due_date,next_step,blocker,tags,assignee,reminder_at,repeat_rule,scheduled_at,depends_on_id,archived,completed_at,parent_id,sort_order,reminder_sent_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values.slice(0, 18), stamp(), updatedAt);
        const task = selectTask.get(Number(result.lastInsertRowid)); logEvent(task.id, 'Задача создана', actorLabel(principal));
        const delivered = await notify(task, 'Новая задача'); return json(res, 201, { ...taskView(task), notification: delivered });
      }
      db.prepare('UPDATE tasks SET title=?,description=?,status=?,priority=?,due_date=?,next_step=?,blocker=?,tags=?,assignee=?,reminder_at=?,repeat_rule=?,scheduled_at=?,depends_on_id=?,archived=?,completed_at=?,parent_id=?,sort_order=?,reminder_sent_at=?,updated_at=? WHERE id=?').run(...values, id);
      const task = selectTask.get(id);
      const changes = [];
      for (const field of ['title','description','status','priority','due_date','next_step','blocker','tags','assignee','reminder_at','repeat_rule','scheduled_at','depends_on_id','archived','parent_id']) if (String(old[field] ?? '') !== String(task[field] ?? '')) changes.push(field);
      if (changes.length) logEvent(id, `Обновлено: ${changes.map(x => ({title:'название',description:'заметки',status:'статус',priority:'приоритет',due_date:'срок',next_step:'следующий шаг',blocker:'блокер',tags:'теги',assignee:'ответственный',reminder_at:'напоминание',repeat_rule:'повтор',scheduled_at:'планирование',depends_on_id:'зависимость',archived:'архив',parent_id:'связь'})[x]).join(', ')}`, actorLabel(principal));
      const changeDetails = changes.map(field => ({ field, before: old[field], after: task[field] }));
      const delivered = changes.length ? await notify(task, 'Обновление задачи', { changes: changeDetails }) : false;
      return json(res, 200, { ...taskView(task), notification: delivered });
    }
    if (req.method === 'DELETE' && /^\/api\/tasks\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1));
      const task = selectTask.get(id);
      const delivered = task ? await notify(task, 'Задача удалена') : false;
      db.prepare('DELETE FROM events WHERE task_id=?').run(id); const result = db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      if (!result.changes) return json(res, 404, { error: 'Задача не найдена' });
      return json(res, 200, { ok: true, notification: delivered });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, {
      role: principal.role, canEdit: principal.role === 'owner',
      roleName: principal.role === 'owner' ? 'Менеджер' : 'Начальство',
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
void sendDailyDigest();
setInterval(() => { void sendDailyDigest(); }, 60_000);
void startTelegramBot();
