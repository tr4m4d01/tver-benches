const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const initSqlJs = require("sql.js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Создание папок
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("public")) fs.mkdirSync("public");

// База данных
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
            is_banned INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS benches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            description TEXT,
            latitude REAL,
            longitude REAL,
            category TEXT DEFAULT 'other',
            has_backrest INTEGER DEFAULT 0,
            has_roof INTEGER DEFAULT 0,
            user_id INTEGER,
            user_name TEXT,
            status TEXT DEFAULT 'active',
            rating REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS bench_photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bench_id INTEGER,
            photo_url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS bench_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bench_id INTEGER,
            user_id INTEGER,
            reason TEXT,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

  saveDatabase();
  console.log("✅ База данных готова");
}

function saveDatabase() {
  if (db) {
    fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

// Multer для фото
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    cb(
      null,
      Date.now() +
        "-" +
        Math.round(Math.random() * 1e9) +
        path.extname(file.originalname),
    );
  },
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ============ АВТОРИЗАЦИЯ ============

app.post("/api/register", (req, res) => {
  console.log("📝 Запрос на регистрацию:", req.body);

  const { login, password, nickname } = req.body;

  if (!login || !password || !nickname) {
    return res.json({ success: false, error: "Все поля обязательны" });
  }

  try {
    // Проверка логина
    const checkLogin = db.exec("SELECT id FROM users WHERE login = ?");
    // sql.js не поддерживает параметры в exec, используем prepare
    const stmt = db.prepare("SELECT id FROM users WHERE login = ?");
    stmt.bind([login]);

    if (stmt.step()) {
      stmt.free();
      return res.json({ success: false, error: "Логин уже занят" });
    }
    stmt.free();

    // Создание пользователя
    const insertStmt = db.prepare(
      "INSERT INTO users (login, password, nickname) VALUES (?, ?, ?)",
    );
    insertStmt.bind([login, password, nickname]);
    insertStmt.step();
    insertStmt.free();

    saveDatabase();

    res.json({
      success: true,
      message: "Регистрация успешна",
      user: { login, nickname },
    });
  } catch (error) {
    console.error("Ошибка регистрации:", error);
    res.json({ success: false, error: "Ошибка: " + error.message });
  }
});

app.post("/api/login", (req, res) => {
  console.log("🔑 Запрос на вход:", req.body);

  const { login, password } = req.body;

  if (!login || !password) {
    return res.json({ success: false, error: "Введите логин и пароль" });
  }

  try {
    const stmt = db.prepare(
      "SELECT id, login, nickname, reputation, total_benches FROM users WHERE login = ? AND password = ?",
    );
    stmt.bind([login, password]);

    if (stmt.step()) {
      const user = stmt.getAsObject();
      stmt.free();

      res.json({
        success: true,
        message: "Вход выполнен",
        user: user,
      });
    } else {
      stmt.free();
      res.json({ success: false, error: "Неверный логин или пароль" });
    }
  } catch (error) {
    console.error("Ошибка входа:", error);
    res.json({ success: false, error: "Ошибка: " + error.message });
  }
});

// ============ СКАМЕЙКИ ============

app.get("/api/benches", (req, res) => {
  try {
    const stmt = db.prepare(
      "SELECT * FROM benches WHERE status = 'active' ORDER BY created_at DESC",
    );
    const benches = [];

    while (stmt.step()) {
      benches.push(stmt.getAsObject());
    }
    stmt.free();

    // Добавляем фото
    const benchesWithPhotos = benches.map((bench) => {
      const photoStmt = db.prepare(
        "SELECT id, photo_url FROM bench_photos WHERE bench_id = ?",
      );
      photoStmt.bind([bench.id]);
      const photos = [];
      while (photoStmt.step()) {
        photos.push(photoStmt.getAsObject());
      }
      photoStmt.free();
      return { ...bench, photos };
    });

    res.json({ success: true, benches: benchesWithPhotos });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post("/api/benches", upload.array("photos", 10), (req, res) => {
  console.log("➕ Добавление скамейки:", req.body);

  const {
    name,
    description,
    latitude,
    longitude,
    category,
    user_id,
    user_name,
  } = req.body;

  if (!name || !latitude || !longitude) {
    return res.json({ success: false, error: "Нужны название и координаты" });
  }

  try {
    const stmt = db.prepare(`
            INSERT INTO benches (name, description, latitude, longitude, category, user_id, user_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
    stmt.bind([
      name,
      description || "",
      latitude,
      longitude,
      category || "other",
      user_id || null,
      user_name || "Аноним",
    ]);
    stmt.step();
    stmt.free();

    // Получаем ID
    const idStmt = db.prepare("SELECT last_insert_rowid() as id");
    idStmt.step();
    const benchId = idStmt.getAsObject().id;
    idStmt.free();

    // Сохраняем фото
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const photoStmt = db.prepare(
          "INSERT INTO bench_photos (bench_id, photo_url) VALUES (?, ?)",
        );
        photoStmt.bind([benchId, "/uploads/" + file.filename]);
        photoStmt.step();
        photoStmt.free();
      }
    }

    // Обновляем статистику пользователя
    if (user_id) {
      const updateStmt = db.prepare(
        "UPDATE users SET total_benches = total_benches + 1, reputation = reputation + 10 WHERE id = ?",
      );
      updateStmt.bind([user_id]);
      updateStmt.step();
      updateStmt.free();
    }

    saveDatabase();

    res.json({
      success: true,
      message: "Скамейка добавлена",
      benchId: benchId,
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ АДМИН ============

app.get("/api/admin/benches", (req, res) => {
  try {
    const stmt = db.prepare("SELECT * FROM benches ORDER BY created_at DESC");
    const benches = [];
    while (stmt.step()) {
      benches.push(stmt.getAsObject());
    }
    stmt.free();
    res.json({ success: true, benches });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post("/api/admin/benches/:id/status", (req, res) => {
  const { status } = req.body;
  const benchId = req.params.id;

  const stmt = db.prepare("UPDATE benches SET status = ? WHERE id = ?");
  stmt.bind([status, benchId]);
  stmt.step();
  stmt.free();

  saveDatabase();
  res.json({ success: true });
});

app.delete("/api/admin/benches/:id", (req, res) => {
  const stmt = db.prepare("DELETE FROM benches WHERE id = ?");
  stmt.bind([req.params.id]);
  stmt.step();
  stmt.free();

  saveDatabase();
  res.json({ success: true });
});

// ============ СТАТИСТИКА ============

app.get("/api/stats", (req, res) => {
  try {
    const benchesStmt = db.prepare(
      "SELECT COUNT(*) as count FROM benches WHERE status = 'active'",
    );
    benchesStmt.step();
    const benchesCount = benchesStmt.getAsObject().count;
    benchesStmt.free();

    const usersStmt = db.prepare("SELECT COUNT(*) as count FROM users");
    usersStmt.step();
    const usersCount = usersStmt.getAsObject().count;
    usersStmt.free();

    res.json({
      success: true,
      total_benches: benchesCount,
      total_users: usersCount,
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ ЗАПУСК ============

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log("🚀 Сервер запущен: http://localhost:" + PORT);
  });
});
