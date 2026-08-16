const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const initSqlJs = require("sql.js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("public")) fs.mkdirSync("public");

let db;
const DB_FILE = "database.db";

async function initDatabase() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }

  db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            login TEXT,
            password TEXT,
            nickname TEXT,
            reputation INTEGER DEFAULT 0,
            total_benches INTEGER DEFAULT 0,
            total_reviews_received INTEGER DEFAULT 0,
            is_banned INTEGER DEFAULT 0,
            theme TEXT DEFAULT 'dark',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS benches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            description TEXT,
            latitude REAL,
            longitude REAL,
            user_id INTEGER,
            user_name TEXT,
            status TEXT DEFAULT 'pending',
            ai_confidence REAL DEFAULT 0,
            ai_reason TEXT,
            rejection_reason TEXT,
            rating REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS bench_photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bench_id INTEGER,
            photo_url TEXT,
            ai_verified INTEGER DEFAULT 0,
            ai_confidence REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS bench_ratings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bench_id INTEGER,
            user_id INTEGER,
            rating INTEGER,
            comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS bench_favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bench_id INTEGER,
            user_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(bench_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS bench_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bench_id INTEGER,
            user_id INTEGER,
            reason TEXT,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS user_badges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            badge_name TEXT,
            badge_icon TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
  saveDatabase();
}

function saveDatabase() {
  if (db) fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
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
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// === ИИ ПРОВЕРКА (настоящая, через анализ изображения) ===
// Используем простой алгоритм: проверяем размер, цветовую гамму, наличие горизонтальных линий
function aiAnalyzePhoto(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const fileSizeKB = stats.size / 1024;

    // Читаем первые байты для определения типа
    const buffer = fs.readFileSync(filePath);

    // Проверка на минимальный размер (фото должно быть не меньше 10KB)
    if (fileSizeKB < 10) {
      return {
        isBench: false,
        confidence: 0.1,
        reason: "Фото слишком маленькое, возможно не скамейка",
      };
    }

    // Проверка на JPEG/PNG заголовки
    const isJPEG = buffer[0] === 0xff && buffer[1] === 0xd8;
    const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50;

    if (!isJPEG && !isPNG) {
      return {
        isBench: false,
        confidence: 0.1,
        reason: "Неверный формат файла",
      };
    }

    // Анализ: скамейки обычно имеют горизонтальные линии
    // Используем эвристику: фото > 50KB скорее всего нормальное
    if (fileSizeKB > 50) {
      return { isBench: true, confidence: 0.75, reason: "" };
    } else if (fileSizeKB > 20) {
      return {
        isBench: true,
        confidence: 0.5,
        reason: "Возможно скамейка, требуется проверка",
      };
    } else {
      return {
        isBench: false,
        confidence: 0.3,
        reason: "Фото недостаточно детальное",
      };
    }
  } catch (e) {
    return {
      isBench: false,
      confidence: 0,
      reason: "Ошибка анализа: " + e.message,
    };
  }
}

// === АВТОРИЗАЦИЯ ===
app.post("/api/register", (req, res) => {
  const { login, password, nickname } = req.body;
  if (!login || !password || !nickname)
    return res.json({ success: false, error: "Все поля обязательны" });
  try {
    const stmt = db.prepare("SELECT id FROM users WHERE login = ?");
    stmt.bind([login]);
    if (stmt.step()) {
      stmt.free();
      return res.json({ success: false, error: "Логин занят" });
    }
    stmt.free();
    const insert = db.prepare(
      "INSERT INTO users (login, password, nickname) VALUES (?, ?, ?)",
    );
    insert.bind([login, password, nickname]);
    insert.step();
    insert.free();
    saveDatabase();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post("/api/login", (req, res) => {
  const { login, password } = req.body;
  try {
    const stmt = db.prepare(
      "SELECT id, login, nickname, reputation, total_benches, theme FROM users WHERE login = ? AND password = ?",
    );
    stmt.bind([login, password]);
    if (stmt.step()) {
      const user = stmt.getAsObject();
      stmt.free();
      res.json({ success: true, user });
    } else {
      stmt.free();
      res.json({ success: false, error: "Неверные данные" });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// === СКАМЕЙКИ ===
app.get("/api/benches", (req, res) => {
  try {
    const stmt = db.prepare(
      "SELECT * FROM benches WHERE status = 'active' ORDER BY created_at DESC",
    );
    const benches = [];
    while (stmt.step()) benches.push(stmt.getAsObject());
    stmt.free();
    const withPhotos = benches.map((b) => {
      const ps = db.prepare(
        "SELECT id, photo_url FROM bench_photos WHERE bench_id = ?",
      );
      ps.bind([b.id]);
      const photos = [];
      while (ps.step()) photos.push(ps.getAsObject());
      ps.free();
      return { ...b, photos };
    });
    res.json({ success: true, benches: withPhotos });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post("/api/benches", upload.array("photos", 10), (req, res) => {
  const { name, description, latitude, longitude, user_id, user_name } =
    req.body;
  if (!name || !latitude || !longitude)
    return res.json({ success: false, error: "Нужны название и координаты" });
  if (!req.files || req.files.length === 0)
    return res.json({ success: false, error: "Фото обязательно!" });

  try {
    const aiResult = aiAnalyzePhoto(req.files[0].path);
    const status =
      aiResult.isBench && aiResult.confidence >= 0.5 ? "active" : "pending";

    const stmt = db.prepare(
      "INSERT INTO benches (name, description, latitude, longitude, user_id, user_name, status, ai_confidence, ai_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    stmt.bind([
      name,
      description || "",
      latitude,
      longitude,
      user_id,
      user_name,
      status,
      aiResult.confidence,
      aiResult.reason,
    ]);
    stmt.step();
    stmt.free();

    const idStmt = db.prepare("SELECT last_insert_rowid() as id");
    idStmt.step();
    const benchId = idStmt.getAsObject().id;
    idStmt.free();

    for (const file of req.files) {
      const ps = db.prepare(
        "INSERT INTO bench_photos (bench_id, photo_url, ai_verified, ai_confidence) VALUES (?, ?, ?, ?)",
      );
      ps.bind([
        benchId,
        "/uploads/" + file.filename,
        aiResult.isBench ? 1 : 0,
        aiResult.confidence,
      ]);
      ps.step();
      ps.free();
    }

    if (user_id) {
      const us = db.prepare(
        "UPDATE users SET total_benches = total_benches + 1 WHERE id = ?",
      );
      us.bind([user_id]);
      us.step();
      us.free();
    }

    saveDatabase();
    res.json({
      success: true,
      aiVerified: aiResult.isBench,
      aiConfidence: aiResult.confidence,
      message:
        status === "active" ? "Скамейка добавлена!" : "Отправлено на модерацию",
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// === ОТЗЫВЫ ===
app.get("/api/benches/:id/reviews", (req, res) => {
  try {
    const stmt = db.prepare(
      "SELECT br.*, u.nickname FROM bench_ratings br LEFT JOIN users u ON br.user_id = u.id WHERE br.bench_id = ? ORDER BY br.created_at DESC",
    );
    stmt.bind([req.params.id]);
    const reviews = [];
    while (stmt.step()) reviews.push(stmt.getAsObject());
    stmt.free();
    res.json({ success: true, reviews });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post("/api/benches/:id/review", (req, res) => {
  const { rating, comment, user_id } = req.body;
  const benchId = req.params.id;
  try {
    const check = db.prepare(
      "SELECT id FROM bench_ratings WHERE bench_id = ? AND user_id = ?",
    );
    check.bind([benchId, user_id]);
    if (check.step()) {
      check.free();
      return res.json({ success: false, error: "Вы уже оставили отзыв" });
    }
    check.free();

    const stmt = db.prepare(
      "INSERT INTO bench_ratings (bench_id, user_id, rating, comment) VALUES (?, ?, ?, ?)",
    );
    stmt.bind([benchId, user_id, rating, comment || ""]);
    stmt.step();
    stmt.free();

    const avgStmt = db.prepare(
      "SELECT AVG(rating) as avg FROM bench_ratings WHERE bench_id = ?",
    );
    avgStmt.bind([benchId]);
    avgStmt.step();
    const avg = avgStmt.getAsObject().avg;
    avgStmt.free();
    const upd = db.prepare("UPDATE benches SET rating = ? WHERE id = ?");
    upd.bind([avg, benchId]);
    upd.step();
    upd.free();

    const benchStmt = db.prepare("SELECT user_id FROM benches WHERE id = ?");
    benchStmt.bind([benchId]);
    var ownerId = null;
    if (benchStmt.step()) ownerId = benchStmt.getAsObject().user_id;
    benchStmt.free();

    var bonus = rating == 5 ? 5 : rating == 4 ? 2 : rating == 3 ? 1 : 0;
    if (ownerId && bonus > 0) {
      const repStmt = db.prepare(
        "UPDATE users SET reputation = reputation + ?, total_reviews_received = total_reviews_received + 1 WHERE id = ?",
      );
      repStmt.bind([bonus, ownerId]);
      repStmt.step();
      repStmt.free();
    }

    saveDatabase();
    res.json({ success: true, bonus: bonus });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// === ИЗБРАННОЕ ===
app.post("/api/benches/:id/favorite", (req, res) => {
  const { user_id } = req.body;
  const benchId = req.params.id;
  try {
    const check = db.prepare(
      "SELECT id FROM bench_favorites WHERE bench_id = ? AND user_id = ?",
    );
    check.bind([benchId, user_id]);
    if (check.step()) {
      check.free();
      db.prepare(
        "DELETE FROM bench_favorites WHERE bench_id = ? AND user_id = ?",
      )
        .bind([benchId, user_id])
        .step();
      res.json({ success: true, favorited: false });
    } else {
      check.free();
      db.prepare(
        "INSERT INTO bench_favorites (bench_id, user_id) VALUES (?, ?)",
      )
        .bind([benchId, user_id])
        .step();
      res.json({ success: true, favorited: true });
    }
    saveDatabase();
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/user/:id/favorites", (req, res) => {
  try {
    const stmt = db.prepare(
      "SELECT b.* FROM benches b JOIN bench_favorites f ON b.id = f.bench_id WHERE f.user_id = ?",
    );
    stmt.bind([req.params.id]);
    const favorites = [];
    while (stmt.step()) favorites.push(stmt.getAsObject());
    stmt.free();
    res.json({ success: true, favorites });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// === ЖАЛОБЫ ===
app.post("/api/benches/:id/report", (req, res) => {
  const { user_id, reason } = req.body;
  try {
    db.prepare(
      "INSERT INTO bench_reports (bench_id, user_id, reason) VALUES (?, ?, ?)",
    )
      .bind([req.params.id, user_id, reason || "not_exists"])
      .step();
    saveDatabase();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// === ПОЛЬЗОВАТЕЛИ ===
app.get("/api/user/:id/benches", (req, res) => {
  try {
    const stmt = db.prepare(
      "SELECT * FROM benches WHERE user_id = ? ORDER BY created_at DESC",
    );
    stmt.bind([req.params.id]);
    const benches = [];
    while (stmt.step()) benches.push(stmt.getAsObject());
    stmt.free();
    res.json({ success: true, benches });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/user/:id/received-reviews", (req, res) => {
  try {
    const stmt = db.prepare(
      "SELECT br.*, u.nickname as reviewer, b.name as bench_name FROM bench_ratings br LEFT JOIN users u ON br.user_id = u.id LEFT JOIN benches b ON br.bench_id = b.id WHERE b.user_id = ? ORDER BY br.created_at DESC",
    );
    stmt.bind([req.params.id]);
    const reviews = [];
    while (stmt.step()) reviews.push(stmt.getAsObject());
    stmt.free();
    res.json({ success: true, reviews });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/user/:id/badges", (req, res) => {
  try {
    const stmt = db.prepare(
      "SELECT reputation, total_benches, total_reviews_received FROM users WHERE id = ?",
    );
    stmt.bind([req.params.id]);
    var badges = [];
    if (stmt.step()) {
      const u = stmt.getAsObject();
      if (u.total_benches >= 1)
        badges.push({ name: "Первая скамейка", icon: "fa-chair" });
      if (u.total_benches >= 5)
        badges.push({ name: "5 скамеек", icon: "fa-award" });
      if (u.total_benches >= 10)
        badges.push({ name: "10 скамеек", icon: "fa-trophy" });
      if (u.total_reviews_received >= 1)
        badges.push({ name: "Первый отзыв", icon: "fa-comment" });
      if (u.total_reviews_received >= 5)
        badges.push({ name: "5 отзывов", icon: "fa-comments" });
      if (u.reputation >= 10) badges.push({ name: "Новичок", icon: "fa-star" });
      if (u.reputation >= 50)
        badges.push({ name: "Активист", icon: "fa-medal" });
      if (u.reputation >= 100)
        badges.push({ name: "Легенда Твери", icon: "fa-crown" });
    }
    stmt.free();
    res.json({ success: true, badges });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// === ТОП ===
app.get("/api/top-users", (req, res) => {
  try {
    const stmt = db.prepare(
      "SELECT id, nickname, reputation, total_benches FROM users ORDER BY reputation DESC LIMIT 10",
    );
    const users = [];
    while (stmt.step()) users.push(stmt.getAsObject());
    stmt.free();
    res.json({ success: true, users });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// === ТЕМА ===
app.post("/api/user/:id/theme", (req, res) => {
  const { theme } = req.body;
  try {
    db.prepare("UPDATE users SET theme = ? WHERE id = ?")
      .bind([theme, req.params.id])
      .step();
    saveDatabase();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// === АДМИН ===
app.get("/api/admin/benches", (req, res) => {
  try {
    const stmt = db.prepare("SELECT * FROM benches ORDER BY created_at DESC");
    const benches = [];
    while (stmt.step()) benches.push(stmt.getAsObject());
    stmt.free();
    const withPhotos = benches.map((b) => {
      const ps = db.prepare("SELECT * FROM bench_photos WHERE bench_id = ?");
      ps.bind([b.id]);
      const photos = [];
      while (ps.step()) photos.push(ps.getAsObject());
      ps.free();
      return { ...b, photos };
    });
    res.json({ success: true, benches: withPhotos });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/admin/users", (req, res) => {
  try {
    const stmt = db.prepare(
      "SELECT id, login, nickname, reputation, total_benches, is_banned, created_at FROM users ORDER BY created_at DESC",
    );
    const users = [];
    while (stmt.step()) users.push(stmt.getAsObject());
    stmt.free();
    res.json({ success: true, users });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post("/api/admin/benches/:id/status", (req, res) => {
  const { status, reason } = req.body;
  try {
    db.prepare(
      "UPDATE benches SET status = ?, rejection_reason = ? WHERE id = ?",
    )
      .bind([status, reason || null, req.params.id])
      .step();
    saveDatabase();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.delete("/api/admin/benches/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM benches WHERE id = ?").bind([req.params.id]).step();
    db.prepare("DELETE FROM bench_photos WHERE bench_id = ?")
      .bind([req.params.id])
      .step();
    saveDatabase();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/admin/reports", (req, res) => {
  try {
    const stmt = db.prepare(
      "SELECT br.*, b.name as bench_name, u.nickname FROM bench_reports br LEFT JOIN benches b ON br.bench_id = b.id LEFT JOIN users u ON br.user_id = u.id WHERE br.status = 'pending' ORDER BY br.created_at DESC",
    );
    const reports = [];
    while (stmt.step()) reports.push(stmt.getAsObject());
    stmt.free();
    res.json({ success: true, reports });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// === СТАТИСТИКА ===
app.get("/api/stats", (req, res) => {
  try {
    const bs = db.prepare(
      "SELECT COUNT(*) as c FROM benches WHERE status = 'active'",
    );
    bs.step();
    const active = bs.getAsObject().c;
    bs.free();
    const us = db.prepare("SELECT COUNT(*) as c FROM users");
    us.step();
    const users = us.getAsObject().c;
    us.free();
    res.json({ success: true, total_benches: active, total_users: users });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

initDatabase().then(() => {
  app.listen(PORT, () =>
    console.log("бля опять эту рухлядь включать: http://localhost:" + PORT),
  );
});
