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
            avatar TEXT,
            reputation INTEGER DEFAULT 0,
            total_benches INTEGER DEFAULT 0,
            total_reviews INTEGER DEFAULT 0,
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
            status TEXT DEFAULT 'pending',
            rating REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS bench_photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bench_id INTEGER,
            photo_url TEXT,
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
    `);

  saveDatabase();
  console.log("База данных готова");
}

function saveDatabase() {
  if (db) {
    fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
  }
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

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
  const { login, password, nickname } = req.body;

  if (!login || !password || !nickname) {
    return res.json({ success: false, error: "Все поля обязательны" });
  }

  try {
    const stmt = db.prepare("SELECT id FROM users WHERE login = ?");
    stmt.bind([login]);
    if (stmt.step()) {
      stmt.free();
      return res.json({ success: false, error: "Логин уже занят" });
    }
    stmt.free();

    const insertStmt = db.prepare(
      "INSERT INTO users (login, password, nickname) VALUES (?, ?, ?)",
    );
    insertStmt.bind([login, password, nickname]);
    insertStmt.step();
    insertStmt.free();

    saveDatabase();
    res.json({ success: true, message: "Регистрация успешна" });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post("/api/login", (req, res) => {
  const { login, password } = req.body;

  if (!login || !password) {
    return res.json({ success: false, error: "Введите логин и пароль" });
  }

  try {
    const stmt = db.prepare(
      "SELECT id, login, nickname, avatar, reputation, total_benches FROM users WHERE login = ? AND password = ?",
    );
    stmt.bind([login, password]);

    if (stmt.step()) {
      const user = stmt.getAsObject();
      stmt.free();
      res.json({ success: true, user: user });
    } else {
      stmt.free();
      res.json({ success: false, error: "Неверный логин или пароль" });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
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
  const { name, description, latitude, longitude, user_id, user_name } =
    req.body;

  if (!name || !latitude || !longitude) {
    return res.json({ success: false, error: "Нужны название и координаты" });
  }

  try {
    const stmt = db.prepare(`
            INSERT INTO benches (name, description, latitude, longitude, user_id, user_name, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `);
    stmt.bind([
      name,
      description || "",
      latitude,
      longitude,
      user_id || null,
      user_name || "Аноним",
    ]);
    stmt.step();
    stmt.free();

    const idStmt = db.prepare("SELECT last_insert_rowid() as id");
    idStmt.step();
    const benchId = idStmt.getAsObject().id;
    idStmt.free();

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
      message: "Скамейка отправлена на модерацию",
      benchId: benchId,
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post("/api/benches/:id/rate", (req, res) => {
  const { rating, user_id } = req.body;
  const benchId = req.params.id;

  try {
    const stmt = db.prepare(
      "INSERT INTO bench_ratings (bench_id, user_id, rating) VALUES (?, ?, ?)",
    );
    stmt.bind([benchId, user_id, rating]);
    stmt.step();
    stmt.free();

    const avgStmt = db.prepare(
      "SELECT AVG(rating) as avg FROM bench_ratings WHERE bench_id = ?",
    );
    avgStmt.bind([benchId]);
    avgStmt.step();
    const avg = avgStmt.getAsObject().avg;
    avgStmt.free();

    const updateStmt = db.prepare("UPDATE benches SET rating = ? WHERE id = ?");
    updateStmt.bind([avg, benchId]);
    updateStmt.step();
    updateStmt.free();

    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post("/api/benches/:id/review", (req, res) => {
  const { rating, comment, user_id } = req.body;
  const benchId = req.params.id;

  try {
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

    const updateStmt = db.prepare("UPDATE benches SET rating = ? WHERE id = ?");
    updateStmt.bind([avg, benchId]);
    updateStmt.step();
    updateStmt.free();

    var repBonus = 0;
    if (rating == 5) repBonus = 5;
    else if (rating == 4) repBonus = 2;
    else if (rating == 3) repBonus = 1;

    if (repBonus > 0 && user_id) {
      const repStmt = db.prepare(
        "UPDATE users SET reputation = reputation + ?, total_reviews = total_reviews + 1 WHERE id = ?",
      );
      repStmt.bind([repBonus, user_id]);
      repStmt.step();
      repStmt.free();
    }

    saveDatabase();
    res.json({ success: true, reputationBonus: repBonus });
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

app.get("/api/benches/:id/reviews", (req, res) => {
  const benchId = req.params.id;

  try {
    const stmt = db.prepare(`
            SELECT br.*, u.nickname 
            FROM bench_ratings br
            LEFT JOIN users u ON br.user_id = u.id
            WHERE br.bench_id = ?
            ORDER BY br.created_at DESC
        `);
    stmt.bind([benchId]);

    const reviews = [];
    while (stmt.step()) {
      reviews.push(stmt.getAsObject());
    }
    stmt.free();

    res.json({ success: true, reviews: reviews });
  } catch (error) {
    res.json({ success: false, reviews: [], error: error.message });
  }
});

app.post("/api/admin/benches/:id/status", (req, res) => {
  const { status } = req.body;
  const benchId = req.params.id;

  try {
    const stmt = db.prepare("UPDATE benches SET status = ? WHERE id = ?");
    stmt.bind([status, benchId]);
    stmt.step();
    stmt.free();
    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete("/api/admin/benches/:id", (req, res) => {
  try {
    const stmt = db.prepare("DELETE FROM benches WHERE id = ?");
    stmt.bind([req.params.id]);
    stmt.step();
    stmt.free();

    const photoStmt = db.prepare("DELETE FROM bench_photos WHERE bench_id = ?");
    photoStmt.bind([req.params.id]);
    photoStmt.step();
    photoStmt.free();

    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
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

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log("Сервер запущен: http://localhost:" + PORT);
  });
});
