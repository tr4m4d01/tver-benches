// ============================================================================
//  server.js (D1) — «Скамейки Твери» on Cloudflare D1
//  Optimized: retries + timeouts, batched queries, caching, error handling.
// ============================================================================

// ---- Libraries ------------------------------------------------------------
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");
const os = require("os");
const jwt = require("jsonwebtoken");

// ---- Configuration --------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

// Cloudflare D1 configuration (from environment variables)
const D1_ACCOUNT_ID = process.env.D1_ACCOUNT_ID;
const D1_DATABASE_ID = process.env.D1_DATABASE_ID;
const D1_API_TOKEN = process.env.D1_API_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // В продакшене JWT_SECRET обязателен. Для локальной разработки генерируем
  // случайный ключ (токены будут недействительны после перезапуска сервера).
  console.warn(
    " WARNING: JWT_SECRET не задан — сгенерирован временный ключ. " +
      "Установите JWT_SECRET в переменных окружения для продакшена.",
  );
}
const jwtSecret = JWT_SECRET || crypto.randomBytes(32).toString("hex");

// Время жизни JWT-токена (30 дней).
const JWT_TTL = "30d";
// Максимальный возраст auth_date из initData Telegram (24 часа).
const TG_AUTH_DATE_MAX_AGE = 24 * 60 * 60;

// Reliability tuning
const D1_RETRIES = 3; // retry attempts on transient failures
const D1_RETRY_DELAY = 300; // base backoff (ms), exponential
const D1_TIMEOUT = 10000; // per-request fetch timeout (ms)
const CACHE_TTL = 30000; // stats / top-users cache TTL (ms)

if (!D1_ACCOUNT_ID || !D1_DATABASE_ID || !D1_API_TOKEN) {
  console.error(" Missing required D1 environment variables:");
  console.error("   D1_ACCOUNT_ID:", D1_ACCOUNT_ID ? "" : "");
  console.error("   D1_DATABASE_ID:", D1_DATABASE_ID ? "" : "");
  console.error("   D1_API_TOKEN:", D1_API_TOKEN ? "" : "");
  process.exit(1);
}

const D1_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${D1_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;

// ---- Required directories -------------------------------------------------
// Фото больше не сохраняются в /uploads: временно ссыпаются в системный tmp-каталог,
// сразу читаются, конвертируются в data URL и удаляются. Сами хранятся в D1.
const TMP_DIR = path.join(os.tmpdir(), "tver-benches-uploads");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(__dirname + "/uploads"))
  fs.mkdirSync(__dirname + "/uploads");
if (!fs.existsSync(__dirname + "/public")) fs.mkdirSync(__dirname + "/public");

// ============================================================================
//  D1 Database Interface (with retry + timeout)
// ============================================================================
class D1SqlError extends Error {
  constructor(m) {
    super(m);
    this.fatal = true;
  }
}
class D1TransientError extends Error {
  constructor(m) {
    super(m);
    this.fatal = false;
  }
}

// Executes ONE SQL statement against D1 (D1 HTTP API runs a single statement
// per call). Retries transient (network/timeout/5xx) errors.
async function d1Query(sql, params = []) {
  let lastErr;
  for (let attempt = 0; attempt <= D1_RETRIES; attempt++) {
    try {
      const response = await fetch(D1_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${D1_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(D1_TIMEOUT),
      });

      if (!response.ok) {
        // 4xx from Cloudflare usually means auth/quota — still retry a couple times
        throw new D1TransientError(
          `HTTP ${response.status} ${response.statusText}`,
        );
      }

      let data;
      try {
        data = await response.json();
      } catch (e) {
        throw new D1TransientError("Invalid JSON from D1 API");
      }

      if (data.errors && data.errors.length > 0) {
        const msg = data.errors[0]?.message || "Unknown D1 error";
        throw new D1SqlError(`D1 error: ${msg}`);
      }
      if (!data.result || data.result.length === 0) return [];

      const result = data.result[0];
      if (result.error) throw new D1SqlError(`D1 error: ${result.error}`);

      return result.results || [];
    } catch (err) {
      lastErr = err;
      if (err.fatal) throw err; // SQL/constraint errors — never retry
      if (attempt < D1_RETRIES) {
        const backoff = D1_RETRY_DELAY * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new D1TransientError("D1 query failed");
}

// Wrapper for write operations (no returned rows needed)
async function d1Run(sql, params = []) {
  await d1Query(sql, params);
}

// Run an array of SQL statements one-by-one (D1 has no batch execution)
async function execMultiple(statements) {
  for (const stmt of statements) {
    await d1Run(stmt);
  }
}

// Resolve last inserted row id with a safe fallback for the stateless API
async function d1LastInsertRowid(tableName = "benches") {
  try {
    const rows = await d1Query("SELECT last_insert_rowid() as id");
    if (rows.length && rows[0].id !== undefined && rows[0].id !== null) {
      return rows[0].id;
    }
  } catch (e) {
    console.warn("last_insert_rowid failed:", e.message);
  }
  try {
    const rows = await d1Query(`SELECT MAX(id) as id FROM ${tableName}`);
    return rows.length ? rows[0].id : null;
  } catch (e) {
    console.warn(`MAX(id) failed for ${tableName}:`, e.message);
    return null;
  }
}

// Thin aliases used across the codebase
async function q(sql, params) {
  return d1Query(sql, params);
}
async function run(sql, params) {
  return d1Run(sql, params);
}

// ============================================================================
//  In-memory caches
// ============================================================================
const responseCache = new Map();
function getCache(key) {
  const item = responseCache.get(key);
  if (item && Date.now() - item.t < CACHE_TTL) return item.v;
  if (item) responseCache.delete(key);
  return null;
}
function setCache(key, v) {
  responseCache.set(key, { v, t: Date.now() });
}



// ============================================================================
//  Batch helpers (eliminate N+1 API calls)
// ============================================================================

// Attach photo arrays to a list of parent rows in a single query.
async function attachPhotos(rows, idField, table, refField) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r[idField]);
  const ph = ids.map(() => "?").join(",");
  const photos = await q(
    `SELECT id, photo_url, ${refField} as ref FROM ${table} WHERE ${refField} IN (${ph})`,
    ids,
  );
  const map = {};
  photos.forEach((p) => {
    (map[p.ref] ||= []).push({ id: p.id, photo_url: p.photo_url });
  });
  return rows.map((r) =>
    Object.assign({}, r, { photos: map[r[idField]] || [] }),
  );
}

// Enrich a list of benches with photos / likes / liked / favorited in 4 queries.
async function enrichBenches(benches, uid) {
  if (!benches.length) return [];
  const ids = benches.map((b) => b.id);
  const ph = ids.map(() => "?").join(",");

  const [photos, likes, liked, favs] = await Promise.all([
    q(
      `SELECT id, bench_id, photo_url FROM bench_photos WHERE bench_id IN (${ph})`,
      ids,
    ),
    q(
      `SELECT bench_id, COUNT(*) as count FROM bench_likes WHERE bench_id IN (${ph}) GROUP BY bench_id`,
      ids,
    ),
    uid
      ? q(
          `SELECT bench_id FROM bench_likes WHERE bench_id IN (${ph}) AND user_id=?`,
          [...ids, uid],
        )
      : Promise.resolve([]),
    uid
      ? q(
          `SELECT bench_id FROM bench_favorites WHERE bench_id IN (${ph}) AND user_id=?`,
          [...ids, uid],
        )
      : Promise.resolve([]),
  ]);

  const photosMap = {};
  photos.forEach((p) => {
    (photosMap[p.bench_id] ||= []).push({ id: p.id, photo_url: p.photo_url });
  });
  const likesMap = {};
  likes.forEach((l) => {
    likesMap[l.bench_id] = l.count;
  });
  const likedSet = new Set(liked.map((r) => r.bench_id));
  const favSet = new Set(favs.map((r) => r.bench_id));

  return benches.map((b) => ({
    ...b,
    photos: photosMap[b.id] || [],
    likes: likesMap[b.id] || 0,
    liked: likedSet.has(b.id),
    favorited: favSet.has(b.id),
  }));
}

// ============================================================================
//  Rate limiting
// ============================================================================
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 10;

function checkRateLimit(key) {
  const now = Date.now();
  let entries = rateLimiter.get(key) || [];
  entries = entries.filter((t) => now - t < RATE_LIMIT_WINDOW);
  entries.push(now);
  rateLimiter.set(key, entries);
  return entries.length <= RATE_LIMIT_MAX;
}

// ============================================================================
//  JWT helpers (вместо сессионной/парольной авторизации)
// ============================================================================
function signToken(userId) {
  return jwt.sign({ userId }, jwtSecret, { expiresIn: JWT_TTL });
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, jwtSecret);
    return payload && payload.userId ? payload.userId : null;
  } catch (e) {
    return null;
  }
}

// ============================================================================
//  Authentication middleware
// ============================================================================
function requireAuth(req, res, next) {
  let token = req.headers.authorization || "";
  if (token.startsWith("Bearer ")) token = token.substring(7);
  else token = (req.body && req.body.token) || req.query.token || "";

  if (!token)
    return res.status(401).json({ success: false, error: "Требуется авторизация" });

  const uid = verifyToken(token);
  if (!uid)
    return res.status(401).json({ success: false, error: "Токен недействителен" });

  req.user_id = uid;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, async function () {
    try {
      const user = await q("SELECT is_admin FROM users WHERE id=?", [
        req.user_id,
      ]);
      if (!user.length || !user[0].is_admin) {
        return res.status(403).json({ success: false, error: "Доступ запрещён" });
      }
      next();
    } catch (err) {
      console.error("Ошибка проверки админа:", err.message);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}

// Проверяет подпись Telegram WebApp initData по алгоритму:
//   secret_key = HMAC-SHA256("WebAppData", bot_token)
//   hash       = HMAC-SHA256(secret_key, data_check_string)
// где data_check_string — отсортированные "key=value" через "\n".
// Также проверяет auth_date (отклоняет старше 24 часов и будущие значения).
// Возвращает объект пользователя из initData или null при ошибке.
function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  try {
    // Telegram initData — это строка вида "query_id=...&user=...&hash=..."
    // без ведущего '?'. new URL иначе трактует её как путь, поэтому нормализуем.
    const normalized = initData.startsWith("?") ? initData : "?" + initData;
    const url = new URL(normalized, "http://localhost");
    const hash = url.searchParams.get("hash");
    if (!hash) return null;

    // Проверка auth_date
    const authDateRaw = url.searchParams.get("auth_date");
    if (!authDateRaw) return null;
    const authDate = parseInt(authDateRaw, 10);
    const now = Math.floor(Date.now() / 1000);
    if (isNaN(authDate) || now - authDate > TG_AUTH_DATE_MAX_AGE || authDate > now + 60)
      return null;

    url.searchParams.delete("hash");

    const params = Array.from(url.searchParams.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    const dataCheckString = params.map(([k, v]) => `${k}=${v}`).join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (computedHash !== hash) return null;

    const userParam = url.searchParams.get("user");
    if (!userParam) return null;

    return JSON.parse(userParam);
  } catch (e) {
    console.error("Ошибка проверки Telegram initData:", e.message);
    return null;
  }
}


// Создаёт пользователя по telegram_id или обновляет его данные
// (first_name/last_name/username/photo_url могли измениться в Telegram).
async function upsertTelegramUser(tgUser) {
  const telegramId = String(tgUser.id);
  const username = tgUser.username || null;
  const firstName = tgUser.first_name || "";
  const lastName = tgUser.last_name || "";
  const photoUrl = tgUser.photo_url || null;

  const existing = await q("SELECT * FROM users WHERE telegram_id=?", [
    telegramId,
  ]);

  if (!existing.length) {
    const login = ("tg_" + telegramId).substring(0, 50);
    const nickname = (firstName || username || "Пользователь").substring(0, 100);
    await run(
      "INSERT INTO users(telegram_id, login, nickname, first_name, last_name, username, photo_url) VALUES (?,?,?,?,?,?,?)",
      [telegramId, login, nickname, firstName, lastName, username, photoUrl],
    );
    return (await q("SELECT * FROM users WHERE telegram_id=?", [telegramId]))[0];
  }

  const user = existing[0];
  await run(
    "UPDATE users SET first_name=?, last_name=?, username=?, photo_url=? WHERE id=?",
    [firstName, lastName, username, photoUrl, user.id],
  );
  return Object.assign({}, user, {
    first_name: firstName,
    last_name: lastName,
    username: username,
    photo_url: photoUrl,
  });
}

// Безопасное представление пользователя для клиента.
function publicUser(user) {
  return {
    id: user.id,
    nickname: user.nickname,
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    username: user.username || "",
    photo_url: user.photo_url || "",
    is_admin: user.is_admin,
    theme: user.theme || "dark",
    avatar: user.avatar || "",
  };
}

// POST /api/auth/telegram — прозрачная авторизация через Telegram WebApp.
app.post("/api/auth/telegram", async (req, res) => {
  const initData = req.body && req.body.initData;
  const tgUser = verifyTelegramInitData(initData, TELEGRAM_BOT_TOKEN);

  if (!tgUser) {
    return res
      .status(401)
      .json({ success: false, error: "Неверные данные Telegram" });
  }

  try {
    const user = await upsertTelegramUser(tgUser);
    const token = signToken(user.id);
    res.json({ success: true, token, user: publicUser(user) });
  } catch (err) {
    console.error("Ошибка Telegram входа:", err.message);
    res.status(500).json({ success: false, error: "Ошибка сервера" });
  }
});

const isDev =
  process.env.NODE_ENV !== "production" || process.env.DEV_MODE === "true";

// Dev-only: вход без Telegram (например, при локальной отладке в браузере).
if (isDev) {
  app.post("/api/auth/dev-login", async (req, res) => {
    try {
      const telegramId = "dev";
      let user = (await q("SELECT * FROM users WHERE telegram_id=?", [
        telegramId,
      ]))[0];

      if (!user) {
        await run(
          "INSERT INTO users(telegram_id, login, nickname) VALUES (?,?,?)",
          [telegramId, "dev", "Dev User"],
        );
        user = (await q("SELECT * FROM users WHERE telegram_id=?", [
          telegramId,
        ]))[0];
      }

      const token = signToken(user.id);
      res.json({ success: true, token, user: publicUser(user) });
    } catch (err) {
      console.error("Ошибка dev входа:", err.message);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}

// ============================================================================
//  Express middleware
// ============================================================================
const CORS_ORIGIN =
  process.env.CORS_ORIGIN || "https://tver-benches.onrender.com";
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "50mb" }));
app.use("/uploads", express.static(__dirname + "/uploads"));
app.use(express.static(__dirname + "/public"));

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "private", "admin.html"));
});

app.use((req, res, next) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) =>
    cb(
      null,
      Date.now() +
        "-" +
        Math.round(Math.random() * 1e9) +
        path.extname(file.originalname),
    ),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const allowedExts = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE_TYPE"), false);
    }
  },
});

// Конвертирует загруженный multer-файл во data URL ('data:<mime>;base64,<data>')
// и сразу удаляет временный файл с диска. Фото попадают в D1 и не пропадают.
function fileToDataURL(file) {
  if (!file || !file.path) return null;
  try {
    const buf = fs.readFileSync(file.path);
    const mime = file.mimetype || "application/octet-stream";
    return "data:" + mime + ";base64," + buf.toString("base64");
  } finally {
    try {
      fs.unlinkSync(file.path);
    } catch (e) {}
  }
}

// ============================================================================
//  Database initialization (each CREATE TABLE is a separate D1 call)
// ============================================================================
async function initDatabase() {
  console.log("Инициализация базы данных D1...");

  const createTables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT UNIQUE, password TEXT, nickname TEXT,
      reputation INTEGER DEFAULT 0, total_benches INTEGER DEFAULT 0,
      total_reviews_received INTEGER DEFAULT 0, theme TEXT DEFAULT 'dark',
      is_admin INTEGER DEFAULT 0, avatar TEXT, phone TEXT, email TEXT,
      banned INTEGER DEFAULT 0, ban_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
    `CREATE TABLE IF NOT EXISTS benches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT DEFAULT 'Скамейка',
      description TEXT, latitude REAL, longitude REAL, user_id INTEGER,
      user_name TEXT, status TEXT DEFAULT 'pending', rating REAL DEFAULT 0,
      admin_comment TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
    `CREATE TABLE IF NOT EXISTS bench_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bench_id INTEGER, photo_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
    `CREATE TABLE IF NOT EXISTS bench_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bench_id INTEGER, user_id INTEGER,
      rating INTEGER, comment TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
    `CREATE TABLE IF NOT EXISTS bench_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bench_id INTEGER, user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(bench_id, user_id) )`,
    `CREATE TABLE IF NOT EXISTS bench_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bench_id INTEGER, user_id INTEGER,
      reason TEXT, status TEXT DEFAULT 'pending', admin_response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
    `CREATE TABLE IF NOT EXISTS report_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER, photo_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
    `CREATE TABLE IF NOT EXISTS review_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, review_id INTEGER, photo_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
    `CREATE TABLE IF NOT EXISTS bench_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bench_id INTEGER, user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(bench_id, user_id) )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, message TEXT,
      type TEXT DEFAULT 'info', read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
    `CREATE TABLE IF NOT EXISTS user_notice (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, message TEXT,
      type TEXT DEFAULT 'info', read INTEGER DEFAULT 0, related_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
    `CREATE TABLE IF NOT EXISTS review_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, review_id INTEGER, user_id INTEGER,
      reason TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
    `CREATE TABLE IF NOT EXISTS admin_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      message TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read INTEGER DEFAULT 0 )`,
  ];

  await execMultiple(createTables);
  console.log("База данных инициализирована");

  const cols = await q(`PRAGMA table_info(notifications)`);
  const hasCol = cols.some((c) => c.name === "related_id");
  if (!hasCol) {
    await run(
      `ALTER TABLE notifications ADD COLUMN related_id INTEGER DEFAULT NULL`,
    );
    console.log("Добавлена колонка related_id в notifications");
  }

  const ucols = await q(`PRAGMA table_info(users)`);
  if (!ucols.some((c) => c.name === "banned")) {
    await run(`ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0`);
    console.log("Добавлена колонка banned в users");
  }
  if (!ucols.some((c) => c.name === "ban_reason")) {
    await run(`ALTER TABLE users ADD COLUMN ban_reason TEXT DEFAULT NULL`);
    console.log("Добавлена колонка ban_reason в users");
  }
  if (!ucols.some((c) => c.name === "telegram_id")) {
    await run(`ALTER TABLE users ADD COLUMN telegram_id TEXT DEFAULT NULL`);
    await run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)`,
    );
    console.log("Добавлена колонка telegram_id в users");
  }
  // Колонки профиля Telegram (если их ещё нет)
  const telegramCols = {
    first_name: `ALTER TABLE users ADD COLUMN first_name TEXT DEFAULT NULL`,
    last_name: `ALTER TABLE users ADD COLUMN last_name TEXT DEFAULT NULL`,
    username: `ALTER TABLE users ADD COLUMN username TEXT DEFAULT NULL`,
    photo_url: `ALTER TABLE users ADD COLUMN photo_url TEXT DEFAULT NULL`,
  };
  for (const [col, sql] of Object.entries(telegramCols)) {
    if (!ucols.some((c) => c.name === col)) {
      await run(sql);
      console.log(`Добавлена колонка ${col} в users`);
    }
  }
}

// ============================================================================
//  Notification helpers
// ============================================================================
async function createNotification(userId, message, type, relatedId = null) {
  try {
    if (type === "admin") {
      await run(
        "INSERT INTO notifications(user_id, message, type, related_id) VALUES (NULL, ?, ?, ?)",
        [message, type || "info", relatedId],
      );
    } else if (userId) {
      await run(
        "INSERT INTO notifications(user_id, message, type, related_id) VALUES (?, ?, ?, ?)",
        [userId, message, type || "info", relatedId],
      );
    } else {
      await run(
        "INSERT INTO notifications(message, type, related_id) VALUES (?, ?, ?)",
        [message, type || "info", relatedId],
      );
    }
  } catch (err) {
    console.error("Ошибка создания уведомления:", err.message);
  }
}

async function createUserNotice(userId, message, type, relatedId) {
  try {
    await run(
      "INSERT INTO user_notice(user_id, message, type, related_id) VALUES (?, ?, ?, ?)",
      [userId, message, type || "info", relatedId || null],
    );
  } catch (err) {
    console.error("Ошибка создания персонального уведомления:", err.message);
  }
}

// ============================================================================
//  API Endpoints
// ============================================================================

// Парольная регистрация/вход (/api/register, /api/login) удалены:
// аутентификация теперь только через Telegram WebApp (см. /api/auth/telegram).
// Поля login/password в таблице users оставлены для обратной совместимости,
// но больше не используются.

// POST /api/user/avatar
app.post(
  "/api/user/avatar",
  requireAuth,
  upload.single("avatar"),
  async (req, res) => {
    if (!req.file)
      return res.json({ success: false, error: "Файл не загружен" });
    const avatarData = fileToDataURL(req.file);
    if (!avatarData)
      return res.json({ success: false, error: "Файл не загружен" });
    try {
      await run("UPDATE users SET avatar=? WHERE id=?", [
        avatarData,
        req.user_id,
      ]);
      res.json({ success: true, avatar: avatarData });
    } catch (err) {
      console.error("Ошибка загрузки аватара:", err.message);
      res.json({ success: false, error: "Ошибка сервера" });
    }
  },
);

// GET /api/user/:id
app.get("/api/user/:id", async (req, res) => {
  const uid = parseInt(req.params.id);
  try {
    const user = await q(
      "SELECT id,login,nickname,reputation,total_benches,total_reviews_received,theme,is_admin,avatar,phone,email,created_at FROM users WHERE id=?",
      [uid],
    );
    if (!user.length)
      return res.json({ success: false, error: "Пользователь не найден" });
    const u = Object.assign({}, user[0]);
    if (uid === req.user_id) {
      u.phone = user[0].phone || "";
      u.email = user[0].email || "";
    }
    res.json({ success: true, user: u });
  } catch (err) {
    console.error("Ошибка получения пользователя:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/me — проверка текущей сессии (валидирует токен доступа).
// Клиент вызывает при старте, чтобы убедиться, что сохранённый аккаунт и
// токен действительны. requireAuth вернёт {success:false, "Сессия истекла"},
// если токен есть, а сессия — {success:false, "Пользователь не найден"},
// если пользователь удалён. В обоих случаях клиент показывает экран входа.
app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const user = await q(
      "SELECT id, login, nickname, reputation, total_benches, total_reviews_received, theme, is_admin, avatar, phone, email, created_at FROM users WHERE id=?",
      [req.user_id],
    );
    if (!user.length) {
      // Пользователь удалён — токен больше не действителен
      return res.json({ success: false, error: "Пользователь не найден" });
    }
    res.json({ success: true, user: user[0] });
  } catch (err) {
    console.error("Ошибка проверки сессии:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/user/:id
app.post("/api/user/:id", requireAuth, upload.none(), async (req, res) => {
  const uid = parseInt(req.params.id);
  if (uid !== req.user_id)
    return res.json({ success: false, error: "Доступ запрещён" });

  const fields = [],
    params = [];
  if (req.body.nickname !== undefined) {
    if (
      (
        await q("SELECT id FROM users WHERE nickname=? AND id!=?", [
          req.body.nickname,
          uid,
        ])
      ).length
    )
      return res.json({ success: false, error: "Никнейм занят" });
    fields.push("nickname=?");
    params.push(req.body.nickname);
  }
  if (req.body.phone !== undefined) {
    fields.push("phone=?");
    params.push(req.body.phone);
  }
  if (req.body.email !== undefined) {
    fields.push("email=?");
    params.push(req.body.email);
  }

  if (!fields.length)
    return res.json({ success: false, error: "Нечего обновлять" });
  try {
    params.push(uid);
    await run("UPDATE users SET " + fields.join(",") + " WHERE id=?", params);
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка обновления пользователя:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/user/:id/benches
app.get("/api/user/:id/benches", async (req, res) => {
  const uid = parseInt(req.params.id);
  try {
    const benches = await q(
      "SELECT id, name, description, status, admin_comment, created_at, rating FROM benches WHERE user_id=? ORDER BY created_at DESC",
      [uid],
    );
    res.json({ success: true, benches });
  } catch (err) {
    console.error("Ошибка получения скамеек пользователя:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/user/:id/favorites
app.get("/api/user/:id/favorites", async (req, res) => {
  const uid = parseInt(req.params.id);
  try {
    const favs = await q(
      "SELECT b.id, b.name, b.description, b.latitude, b.longitude, b.status, b.admin_comment FROM benches b JOIN bench_favorites f ON b.id=f.bench_id WHERE f.user_id=? ORDER BY f.created_at DESC",
      [uid],
    );
    res.json({ success: true, favorites: favs });
  } catch (err) {
    console.error("Ошибка получения избранного:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/user/:id/received-reviews
app.get("/api/user/:id/received-reviews", async (req, res) => {
  const uid = parseInt(req.params.id);
  try {
    const reviews = await q(
      "SELECT r.id, r.rating, r.comment, r.created_at, u.nickname as reviewer, u.avatar as reviewer_avatar FROM bench_ratings r JOIN benches b ON r.bench_id=b.id LEFT JOIN users u ON r.user_id=u.id WHERE b.user_id=? ORDER BY r.created_at DESC",
      [uid],
    );
    const withPhotos = await attachPhotos(
      reviews,
      "id",
      "review_photos",
      "review_id",
    );
    res.json({ success: true, reviews: withPhotos });
  } catch (err) {
    console.error("Ошибка получения полученных отзывов:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/user/:id/reports
app.get("/api/user/:id/reports", async (req, res) => {
  const uid = parseInt(req.params.id);
  try {
    const reports = await q(
      "SELECT r.*, b.name as bench_name FROM bench_reports r LEFT JOIN benches b ON r.bench_id=b.id WHERE r.user_id=? ORDER BY r.created_at DESC",
      [uid],
    );
    const withPhotos = await attachPhotos(
      reports,
      "id",
      "report_photos",
      "report_id",
    );
    res.json({ success: true, reports: withPhotos });
  } catch (err) {
    console.error("Ошибка получения жалоб:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// DELETE /api/user/reports/:id
app.delete("/api/user/reports/:id", requireAuth, async (req, res) => {
  const rid = parseInt(req.params.id);
  try {
    await run("DELETE FROM bench_reports WHERE id=?", [rid]);
    await run("DELETE FROM report_photos WHERE report_id=?", [rid]);
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка удаления жалобы:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/user/:id/notifications
app.get("/api/user/:id/notifications", async (req, res) => {
  const uid = parseInt(req.params.id);
  try {
    const notices = await q(
      "SELECT id, user_id, message, type, read, related_id, created_at FROM user_notice WHERE user_id=? ORDER BY created_at DESC",
      [uid],
    );
    res.json({ success: true, notifications: notices });
  } catch (err) {
    console.error("Ошибка получения уведомлений:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/user/:id/notifications/read
app.post("/api/user/:id/notifications/read", requireAuth, async (req, res) => {
  const uid = parseInt(req.params.id);
  try {
    await run("UPDATE user_notice SET read=1 WHERE user_id=?", [uid]);
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка пометки уведомлений прочитанными:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/user/:id/notifications/clear
app.post("/api/user/:id/notifications/clear", requireAuth, async (req, res) => {
  const uid = parseInt(req.params.id);
  try {
    await run("DELETE FROM user_notice WHERE user_id=? AND read=1", [uid]);
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка очистки уведомлений:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/user/:id/badges
app.get("/api/user/:id/badges", async (req, res) => {
  const uid = parseInt(req.params.id);
  try {
    const user = await q(
      "SELECT total_benches, reputation, total_reviews_received FROM users WHERE id=?",
      [uid],
    );
    const badges = [];
    if (user.length) {
      const u = user[0];
      if (u.total_benches >= 1)
        badges.push({ icon: "fa-solid fa-chair", name: "Первая скамейка" });
      if (u.total_benches >= 5)
        badges.push({ icon: "fa-solid fa-seedling", name: "Эксперт" });
      if (u.reputation >= 5)
        badges.push({ icon: "fa-solid fa-star", name: "Популярный" });
      if (u.total_reviews_received >= 10)
        badges.push({ icon: "fa-solid fa-comments", name: "Рецензируемый" });
    }
    res.json({ success: true, badges });
  } catch (err) {
    console.error("Ошибка получения достижений:", err.message);
    res.json({ success: true, badges: [] });
  }
});

// GET /api/stats (cached)
app.get("/api/stats", async (req, res) => {
  try {
    const cached = getCache("stats");
    if (cached) return res.json(cached);
    const benches = await q(
      "SELECT COUNT(*) as c FROM benches WHERE status='active'",
    );
    const users = await q("SELECT COUNT(*) as c FROM users");
    const result = {
      success: true,
      total_benches: benches.length ? benches[0].c : 0,
      total_users: users.length ? users[0].c : 0,
    };
    setCache("stats", result);
    res.json(result);
  } catch (err) {
    console.error("Ошибка получения статистики:", err.message);
    res.json({ success: true, total_benches: 0, total_users: 0 });
  }
});

// GET /api/top-users (cached)
app.get("/api/top-users", async (req, res) => {
  try {
    const cached = getCache("top-users");
    if (cached) return res.json(cached);
    const users = await q(
      "SELECT id, avatar, nickname, reputation FROM users ORDER BY reputation DESC, total_benches DESC LIMIT 20",
    );
    const result = { success: true, users };
    setCache("top-users", result);
    res.json(result);
  } catch (err) {
    console.error("Ошибка получения топ пользователей:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/geocode — прокси для Nominatim с кэшированием и User-Agent
app.get("/api/geocode", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ success: false, error: "Пустой запрос" });
  const cacheKey = "geocode:" + q.toLowerCase();
  try {
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=5&q=" +
      encodeURIComponent(q);
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "TverBenchesMiniApp/1.0 (contact@tver-benches.onrender.com)",
      },
    });
    const data = await response.json();
    const result = { success: true, data };
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("Ошибка геокодирования:", err.message);
    res.json({ success: false, error: "Ошибка сервиса геокодирования" });
  }
});

// GET /api/benches (batched enrichment)
app.get("/api/benches", async (req, res) => {
  const uid = req.user_id || req.query.user_id;
  const uidNum = uid ? parseInt(uid) : null;
  try {
    const benches = await q(
      "SELECT b.*, u.avatar as user_avatar FROM benches b LEFT JOIN users u ON b.user_id=u.id WHERE b.status='active' ORDER BY b.created_at DESC",
    );
    const enriched = await enrichBenches(benches, uidNum);
    res.json({ success: true, benches: enriched });
  } catch (err) {
    console.error("Ошибка получения списка скамеек:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/benches
app.post(
  "/api/benches",
  requireAuth,
  upload.array("photos", 10),
  async (req, res) => {
    const d = req.body.description,
      lat = req.body.latitude,
      lng = req.body.longitude,
      uid = req.user_id,
      un = req.body.user_name;
    if (!lat || !lng)
      return res.json({ success: false, error: "Нужны координаты" });
    if (!req.files || !req.files.length)
      return res.json({ success: false, error: "Фото обязательно!" });

    try {
      await run(
        "INSERT INTO benches(name,description,latitude,longitude,user_id,user_name,status) VALUES (?,?,?,?,?,?,?)",
        ["Скамейка", d || "", lat, lng, uid, un, "pending"],
      );
      const benchId = await d1LastInsertRowid("benches");
      if (!benchId)
        return res.json({ success: false, error: "Ошибка создания скамейки" });

      for (const f of req.files) {
        await run("INSERT INTO bench_photos(bench_id,photo_url) VALUES (?,?)", [
          benchId,
          fileToDataURL(f),
        ]);
      }
      if (uid)
        await run("UPDATE users SET total_benches=total_benches+1 WHERE id=?", [
          uid,
        ]);
      await createNotification(
        null,
        "Новая скамейка #" + benchId + " на модерации",
        "admin",
        benchId,
      );

      res.json({
        success: true,
        message: "Отправлено на модерацию",
        bench_id: benchId,
      });
    } catch (e) {
      console.error("Error creating bench:", e.message);
      res.json({ success: false, error: "Ошибка сервера: " + e.message });
    }
  },
);

// GET /api/benches/:id/reviews
app.get("/api/benches/:id/reviews", async (req, res) => {
  const benchId = parseInt(req.params.id);
  try {
    const reviews = await q(
      "SELECT r.*, u.nickname, u.avatar as reviewer_avatar FROM bench_ratings r LEFT JOIN users u ON r.user_id=u.id WHERE r.bench_id=? ORDER BY r.created_at DESC",
      [benchId],
    );
    const withPhotos = await attachPhotos(
      reviews,
      "id",
      "review_photos",
      "review_id",
    );
    res.json({ success: true, reviews: withPhotos });
  } catch (err) {
    console.error("Ошибка получения отзывов:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/benches/:id/review
app.post(
  "/api/benches/:id/review",
  requireAuth,
  upload.array("photos", 10),
  async (req, res) => {
    const benchId = parseInt(req.params.id);
    const uid = req.user_id;
    const rating = parseInt(req.body.rating);
    const comment = req.body.comment || "";
    if (!rating || rating < 1 || rating > 5)
      return res.json({ success: false, error: "Нужна оценка" });

    try {
      const bench = await q("SELECT user_id FROM benches WHERE id=?", [
        benchId,
      ]);
      if (!bench.length)
        return res.json({ success: false, error: "Скамейка не найдена" });
      if (bench[0].user_id == uid)
        return res.json({
          success: false,
          error: "Нельзя оставлять отзыв самому себе",
        });

      await run(
        "INSERT INTO bench_ratings(bench_id,user_id,rating,comment) VALUES (?,?,?,?)",
        [benchId, uid, rating, comment],
      );
      const reviewId = await d1LastInsertRowid("bench_ratings");

      if (req.files && req.files.length) {
        for (const f of req.files) {
          await run(
            "INSERT INTO review_photos(review_id,photo_url) VALUES (?,?)",
            [reviewId, fileToDataURL(f)],
          );
        }
      }
      await q(
        "UPDATE benches SET rating=(SELECT AVG(rating) FROM bench_ratings WHERE bench_id=?) WHERE id=?",
        [benchId, benchId],
      );
      await run(
        "UPDATE users SET total_reviews_received=total_reviews_received+1 WHERE id=?",
        [bench[0].user_id],
      );
      await createUserNotice(
        bench[0].user_id,
        "На вашу скамейку #" + benchId + " оставили отзыв",
        "info",
        benchId,
      );

      res.json({ success: true });
    } catch (err) {
      console.error("Ошибка создания отзыва:", err.message);
      res.json({ success: false, error: "Ошибка сервера" });
    }
  },
);

// POST /api/benches/:id/like
app.post("/api/benches/:id/like", requireAuth, async (req, res) => {
  const benchId = parseInt(req.params.id);
  const uid = req.user_id;
  try {
    const existing = await q(
      "SELECT id FROM bench_likes WHERE bench_id=? AND user_id=?",
      [benchId, uid],
    );
    let liked;
    if (existing.length) {
      await run("DELETE FROM bench_likes WHERE bench_id=? AND user_id=?", [
        benchId,
        uid,
      ]);
      liked = false;
    } else {
      await run("INSERT INTO bench_likes(bench_id,user_id) VALUES (?,?)", [
        benchId,
        uid,
      ]);
      liked = true;
    }
    const likes = await q(
      "SELECT COUNT(*) as count FROM bench_likes WHERE bench_id=?",
      [benchId],
    );
    res.json({
      success: true,
      liked,
      likes: likes.length ? likes[0].count : 0,
    });
  } catch (err) {
    console.error("Ошибка лайка:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/benches/:id/favorite
app.post("/api/benches/:id/favorite", requireAuth, async (req, res) => {
  const benchId = parseInt(req.params.id);
  const uid = req.user_id;
  try {
    const existing = await q(
      "SELECT id FROM bench_favorites WHERE bench_id=? AND user_id=?",
      [benchId, uid],
    );
    let favorited;
    if (existing.length) {
      await run("DELETE FROM bench_favorites WHERE bench_id=? AND user_id=?", [
        benchId,
        uid,
      ]);
      favorited = false;
    } else {
      await run("INSERT INTO bench_favorites(bench_id,user_id) VALUES (?,?)", [
        benchId,
        uid,
      ]);
      favorited = true;
    }
    res.json({ success: true, favorited });
  } catch (err) {
    console.error("Ошибка избранного:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/benches/:id/report
app.post(
  "/api/benches/:id/report",
  requireAuth,
  upload.array("photos", 10),
  async (req, res) => {
    const benchId = parseInt(req.params.id);
    const uid = req.user_id;
    const reason = req.body.reason || "";
    try {
      await run(
        "INSERT INTO bench_reports(bench_id,user_id,reason,status) VALUES (?,?,?,?)",
        [benchId, uid, reason, "pending"],
      );
      const reportId = await d1LastInsertRowid("bench_reports");
      if (req.files && req.files.length) {
        for (const f of req.files) {
          await run(
            "INSERT INTO report_photos(report_id,photo_url) VALUES (?,?)",
            [reportId, fileToDataURL(f)],
          );
        }
      }
      await createNotification(
        null,
        "Новая жалоба #" + reportId + " на скамейку #" + benchId,
        "admin",
        benchId,
      );
      res.json({ success: true, report_id: reportId });
    } catch (err) {
      console.error("Ошибка создания жалобы:", err.message);
      res.json({ success: false, error: "Ошибка сервера" });
    }
  },
);

// POST /api/reviews/:id/report
app.post("/api/reviews/:id/report", requireAuth, async (req, res) => {
  const reviewId = parseInt(req.params.id);
  const uid = req.user_id;
  const reason = req.body.reason || "spam";
  try {
    await run(
      "INSERT INTO review_reports(review_id,user_id,reason) VALUES (?,?,?)",
      [reviewId, uid, reason],
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка жалобы на отзыв:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// ---- Admin endpoints ------------------------------------------------------

// GET /api/admin/benches
app.get("/api/admin/benches", requireAdmin, async (req, res) => {
  try {
    const benches = await q(
      "SELECT b.*, u.avatar as user_avatar FROM benches b LEFT JOIN users u ON b.user_id=u.id ORDER BY b.created_at DESC",
    );
    const enriched = await enrichBenches(benches, null);
    res.json({ success: true, benches: enriched });
  } catch (err) {
    console.error("Ошибка получения скамеек админом:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/admin/users
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await q(
      "SELECT id, login, nickname, reputation, total_benches, is_admin, banned, ban_reason, avatar, created_at FROM users ORDER BY created_at DESC",
    );
    res.json({ success: true, users });
  } catch (err) {
    console.error("Ошибка получения пользователей:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/admin/reports
app.get("/api/admin/reports", requireAdmin, async (req, res) => {
  try {
    const reports = await q(
      "SELECT r.*, u.nickname, b.name as bench_name FROM bench_reports r LEFT JOIN users u ON r.user_id=u.id LEFT JOIN benches b ON r.bench_id=b.id ORDER BY r.created_at DESC",
    );
    const withPhotos = await attachPhotos(
      reports,
      "id",
      "report_photos",
      "report_id",
    );
    res.json({ success: true, reports: withPhotos });
  } catch (err) {
    console.error("Ошибка получения жалоб:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/admin/reviews
app.get("/api/admin/reviews", requireAdmin, async (req, res) => {
  try {
    const reviews = await q(
      "SELECT r.*, u.nickname, b.name as bench_name FROM bench_ratings r LEFT JOIN users u ON r.user_id=u.id LEFT JOIN benches b ON r.bench_id=b.id ORDER BY r.created_at DESC",
    );
    const withPhotos = await attachPhotos(
      reviews,
      "id",
      "review_photos",
      "review_id",
    );
    res.json({ success: true, reviews: withPhotos });
  } catch (err) {
    console.error("Ошибка получения отзывов:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// GET /api/admin/notifications
app.get("/api/admin/notifications", requireAdmin, async (req, res) => {
  try {
    const notes = await q(
      "SELECT id, message, type, read, related_id, created_at FROM notifications WHERE user_id IS NULL OR type='admin' ORDER BY created_at DESC",
    );
    res.json({ success: true, notifications: notes });
  } catch (err) {
    console.error("Ошибка получения уведомлений:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/admin/benches/:id/status
app.post("/api/admin/benches/:id/status", requireAdmin, async (req, res) => {
  const benchId = parseInt(req.params.id);
  const newStatus = req.body.status;
  const adminComment = req.body.admin_comment || null;
  try {
    const bench = await q("SELECT user_id, user_name FROM benches WHERE id=?", [
      benchId,
    ]);
    if (!bench.length)
      return res.json({ success: false, error: "Скамейка не найдена" });

    await run("UPDATE benches SET status=?, admin_comment=? WHERE id=?", [
      newStatus,
      adminComment,
      benchId,
    ]);

    if (newStatus === "active" && bench[0].user_id) {
      await createUserNotice(
        bench[0].user_id,
        "Ваша скамейка #" + benchId + " одобрена!",
        "success",
        benchId,
      );
    } else if (newStatus === "rejected" && bench[0].user_id) {
      await createUserNotice(
        bench[0].user_id,
        "Скамейка #" + benchId + " отклонена",
        "error",
        benchId,
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка изменения статуса:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/admin/benches/:id/comment
app.post("/api/admin/benches/:id/comment", requireAdmin, async (req, res) => {
  const benchId = parseInt(req.params.id);
  const comment = (req.body.comment || "").trim();
  try {
    const bench = await q("SELECT id FROM benches WHERE id=?", [benchId]);
    if (!bench.length)
      return res.json({ success: false, error: "Скамейка не найдена" });
    await run("UPDATE benches SET admin_comment=? WHERE id=?", [
      comment,
      benchId,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка сохранения комментария:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// DELETE /api/admin/benches/:id
app.delete("/api/admin/benches/:id", requireAdmin, async (req, res) => {
  const benchId = parseInt(req.params.id);
  try {
    await run("DELETE FROM bench_likes WHERE bench_id=?", [benchId]);
    await run("DELETE FROM bench_favorites WHERE bench_id=?", [benchId]);
    await run("DELETE FROM bench_ratings WHERE bench_id=?", [benchId]);
    await run(
      "DELETE FROM review_photos WHERE review_id IN (SELECT id FROM bench_ratings WHERE bench_id=?)",
      [benchId],
    );
    await run("DELETE FROM bench_reports WHERE bench_id=?", [benchId]);
    await run(
      "DELETE FROM report_photos WHERE report_id IN (SELECT id FROM bench_reports WHERE bench_id=?)",
      [benchId],
    );
    await run("DELETE FROM bench_photos WHERE bench_id=?", [benchId]);
    await run("DELETE FROM benches WHERE id=?", [benchId]);
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка удаления скамейки:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/admin/users/:id/admin
app.post("/api/admin/users/:id/admin", requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id);
  const isAdmin = req.body.is_admin ? 1 : 0;
  try {
    await run("UPDATE users SET is_admin=? WHERE id=?", [isAdmin, uid]);
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка изменения прав админа:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/admin/users/:id/ban
app.post("/api/admin/users/:id/ban", requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id);
  const reason = (req.body.reason || "").trim();
  const isBanned = req.body.is_banned ? 1 : 0;
  try {
    if (uid === req.user_id) {
      return res.json({ success: false, error: "Нельзя забанить самого себя" });
    }
    const users = await q("SELECT id FROM users WHERE id=?", [uid]);
    if (!users.length) {
      return res.json({ success: false, error: "Пользователь не найден" });
    }
    await run("UPDATE users SET banned=?, ban_reason=? WHERE id=?", [
      isBanned,
      isBanned ? reason : null,
      uid,
    ]);
    if (isBanned) {
      await createUserNotice(uid, "Вы забанены: " + reason, "error", null);
    }
    res.json({
      success: true,
      message: isBanned ? "Пользователь забанен" : "Пользователь разбанен",
    });
  } catch (err) {
    console.error("Ошибка изменения бана:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/admin/users/:id/message
app.post("/api/admin/users/:id/message", requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id);
  const message = (req.body.message || "").trim();
  try {
    if (!message) {
      return res.json({ success: false, error: "Введите сообщение" });
    }
    if (uid === req.user_id) {
      return res.json({
        success: false,
        error: "Нельзя отправить себе сообщение",
      });
    }
    const users = await q("SELECT id FROM users WHERE id=?", [uid]);
    if (!users.length) {
      return res.json({ success: false, error: "Пользователь не найден" });
    }
    await run("INSERT INTO admin_messages(user_id, message) VALUES (?, ?)", [
      uid,
      message,
    ]);
    await createUserNotice(uid, message, "admin", null);
    res.json({ success: true, message: "Сообщение отправлено" });
  } catch (err) {
    console.error("Ошибка отправки сообщения:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/admin/reports/:id/respond
app.post("/api/admin/reports/:id/respond", requireAdmin, async (req, res) => {
  const reportId = parseInt(req.params.id);
  const responseText = req.body.response || "";
  try {
    await run(
      "UPDATE bench_reports SET admin_response=?, status='resolved' WHERE id=?",
      [responseText, reportId],
    );
    const report = await q("SELECT user_id FROM bench_reports WHERE id=?", [
      reportId,
    ]);
    if (report.length && report[0].user_id) {
      await createUserNotice(
        report[0].user_id,
        "Ваша жалоба получила ответ от администратора",
        "info",
        reportId,
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка ответа на жалобу:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/admin/reports/:id/resolve
app.post("/api/admin/reports/:id/resolve", requireAdmin, async (req, res) => {
  const reportId = parseInt(req.params.id);
  try {
    await run("UPDATE bench_reports SET status='resolved' WHERE id=?", [
      reportId,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка разрешения жалобы:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// DELETE /api/admin/reviews/:id
app.delete("/api/admin/reviews/:id", requireAdmin, async (req, res) => {
  const reviewId = parseInt(req.params.id);
  try {
    await run("DELETE FROM review_photos WHERE review_id=?", [reviewId]);
    await run("DELETE FROM bench_ratings WHERE id=?", [reviewId]);
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка удаления отзыва:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/admin/notifications/clear
app.post("/api/admin/notifications/clear", requireAdmin, async (req, res) => {
  try {
    await run("DELETE FROM notifications WHERE `read`=1");
    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка очистки уведомлений:", err.message);
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// POST /api/admin/notifications/read
app.post("/api/admin/notifications/read", requireAdmin, async (req, res) => {
  try {
    await run("UPDATE notifications SET `read`=1");
    res.json({ success: true });
  } catch (err) {
    console.error(
      "Ошибка маркировки уведомлений как прочитанных:",
      err.message,
    );
    res.json({ success: false, error: "Ошибка сервера" });
  }
});

// ---- Error handler ------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE")
      return res.json({ success: false, error: "Файл слишком большой" });
    if (err.code === "LIMIT_FILE_COUNT")
      return res.json({ success: false, error: "Слишком много файлов" });
    if (err.code === "LIMIT_UNEXPECTED_FILE_TYPE")
      return res.json({
        success: false,
        error: "Разрешены только изображения",
      });
    return res.json({ success: false, error: "Ошибка загрузки файла" });
  }
  console.error("Необработанная ошибка:", err);
  res.json({ success: false, error: "Ошибка сервера" });
});

// ============================================================================
//  Server startup
// ============================================================================
initDatabase()
  .then(() => {
    app.listen(PORT, () => console.log("Сервер: http://localhost:" + PORT));
  })
  .catch((err) => {
    console.error(" Ошибка инициализации БД:", err.message);
    process.exit(1);
  });
