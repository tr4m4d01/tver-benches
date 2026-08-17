const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const initSqlJs = require("sql.js");

const app = express();
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(__dirname + "/uploads"))
  fs.mkdirSync(__dirname + "/uploads");
if (!fs.existsSync(__dirname + "/public")) fs.mkdirSync(__dirname + "/public");

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
        CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT UNIQUE, password TEXT, nickname TEXT, reputation INTEGER DEFAULT 0, total_benches INTEGER DEFAULT 0, total_reviews_received INTEGER DEFAULT 0, theme TEXT DEFAULT 'dark', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS benches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT DEFAULT 'Скамейка', description TEXT, latitude REAL, longitude REAL, user_id INTEGER, user_name TEXT, status TEXT DEFAULT 'pending', rating REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS bench_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, bench_id INTEGER, photo_url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS bench_ratings (id INTEGER PRIMARY KEY AUTOINCREMENT, bench_id INTEGER, user_id INTEGER, rating INTEGER, comment TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS bench_favorites (id INTEGER PRIMARY KEY AUTOINCREMENT, bench_id INTEGER, user_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(bench_id, user_id));
        CREATE TABLE IF NOT EXISTS bench_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, bench_id INTEGER, user_id INTEGER, reason TEXT, status TEXT DEFAULT 'pending', admin_response TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS report_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER, photo_url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS review_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id INTEGER, photo_url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS bench_likes (id INTEGER PRIMARY KEY AUTOINCREMENT, bench_id INTEGER, user_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(bench_id, user_id));
    `);
  saveDatabase();
}

function saveDatabase() {
  if (db) fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}
function q(sql, params) {
  var stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  var results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}
function run(sql, params) {
  var stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  stmt.step();
  stmt.free();
  saveDatabase();
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/uploads", express.static(__dirname + "/uploads"));
app.use(express.static(__dirname + "/public"));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, __dirname + "/uploads/");
  },
  filename: function (req, file, cb) {
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

app.post("/api/register", function (req, res) {
  var l = req.body.login,
    n = req.body.nickname,
    p = req.body.password;
  if (!l || !p || !n)
    return res.json({ success: false, error: "Все поля обязательны" });
  var existingLogin = q("SELECT id FROM users WHERE login=?", [l]);
  if (existingLogin.length)
    return res.json({ success: false, error: "Логин занят" });
  var existingNick = q("SELECT id FROM users WHERE nickname=?", [n]);
  if (existingNick.length)
    return res.json({ success: false, error: "Никнейм занят" });
  run("INSERT INTO users(login,password,nickname)VALUES(?,?,?)", [l, p, n]);
  res.json({ success: true });
});

app.post("/api/login", function (req, res) {
  var l = req.body.login,
    p = req.body.password;
  var users = q(
    "SELECT id,login,nickname,reputation,total_benches,theme FROM users WHERE login=? AND password=?",
    [l, p],
  );
  if (users.length) {
    res.json({ success: true, user: users[0] });
  } else {
    res.json({ success: false, error: "Неверные данные" });
  }
});

app.get("/api/benches", function (req, res) {
  var uid = req.query.user_id;
  var benches = q(
    "SELECT * FROM benches WHERE status='active' ORDER BY created_at DESC",
  );
  var withPhotos = benches.map(function (b) {
    var photos = q("SELECT id,photo_url FROM bench_photos WHERE bench_id=?", [
      b.id,
    ]);
    var likes = q(
      "SELECT COUNT(*) as count FROM bench_likes WHERE bench_id=?",
      [b.id],
    );
    var liked = false;
    if (uid) {
      var likedRows = q(
        "SELECT id FROM bench_likes WHERE bench_id=? AND user_id=?",
        [b.id, uid],
      );
      liked = likedRows.length > 0;
    }
    return Object.assign({}, b, {
      photos: photos,
      likes: likes.length ? likes[0].count : 0,
      liked: liked,
    });
  });
  res.json({ success: true, benches: withPhotos });
});

app.post("/api/benches", upload.array("photos", 10), function (req, res) {
  console.log("POST /api/benches");
  console.log("  files count:", req.files ? req.files.length : 0);
  if (req.files) {
    req.files.forEach(function (file, i) {
      console.log(
        "  file",
        i,
        ":",
        file.originalname,
        "->",
        file.filename,
        "size:",
        file.size,
      );
    });
  }
  console.log("  body:", req.body);

  var d = req.body.description,
    lat = req.body.latitude,
    lng = req.body.longitude,
    uid = req.body.user_id,
    un = req.body.user_name;
  if (!lat || !lng)
    return res.json({ success: false, error: "Нужны координаты" });
  if (!req.files || !req.files.length)
    return res.json({ success: false, error: "Фото обязательно!" });

  try {
    run(
      "INSERT INTO benches(name,description,latitude,longitude,user_id,user_name,status)VALUES(?,?,?,?,?,?,?)",
      ["Скамейка", d || "", lat, lng, uid, un, "pending"],
    );
    var benchId = null;
    try {
      var idRows = db.exec("SELECT last_insert_rowid() as id");
      if (idRows.length > 0 && idRows[0].values.length > 0) {
        benchId = idRows[0].values[0][0];
      }
    } catch (e) {
      console.warn("last_insert_rowid failed:", e.message);
    }
    if (!benchId) {
      var maxResult = db.exec("SELECT MAX(id) as id FROM benches");
      benchId = maxResult.length > 0 ? maxResult[0].values[0][0] : null;
    }
    if (!benchId) {
      console.error("Failed to get bench ID after insert");
      return res.json({ success: false, error: "Ошибка создания скамейки" });
    }
    console.log("New bench created:", benchId, "files:", req.files.length);

    for (var i = 0; i < req.files.length; i++) {
      var photoUrl = "/uploads/" + req.files[i].filename;
      run("INSERT INTO bench_photos(bench_id,photo_url)VALUES(?,?)", [
        benchId,
        photoUrl,
      ]);
      console.log("Photo saved:", photoUrl, "for bench:", benchId);
    }

    if (uid) {
      run("UPDATE users SET total_benches=total_benches+1 WHERE id=?", [uid]);
    }
    res.json({ success: true, message: "Отправлено на модерацию" });
  } catch (e) {
    console.error("Error creating bench:", e);
    res.json({ success: false, error: "Ошибка сервера: " + e.message });
  }
});

app.get("/api/benches/:id/reviews", function (req, res) {
  var reviews = q(
    "SELECT br.*,u.nickname FROM bench_ratings br LEFT JOIN users u ON br.user_id=u.id WHERE br.bench_id=? ORDER BY br.created_at DESC",
    [req.params.id],
  );
  var withPhotos = reviews.map(function (rev) {
    var photos = q("SELECT id,photo_url FROM review_photos WHERE review_id=?", [
      rev.id,
    ]);
    return Object.assign({}, rev, { photos: photos });
  });
  res.json({ success: true, reviews: withPhotos });
});

app.post(
  "/api/benches/:id/review",
  upload.array("photos", 5),
  function (req, res) {
    var r = req.body.rating,
      c = req.body.comment,
      uid = req.body.user_id,
      bid = req.params.id;
    var bench = q("SELECT user_id FROM benches WHERE id=?", [bid]);
    if (bench.length && bench[0].user_id == uid) {
      return res.json({
        success: false,
        error: "Нельзя оставить отзыв самому себе",
      });
    }
    var existing = q(
      "SELECT id FROM bench_ratings WHERE bench_id=? AND user_id=?",
      [bid, uid],
    );
    if (existing.length)
      return res.json({ success: false, error: "Вы уже оставили отзыв" });
    run(
      "INSERT INTO bench_ratings(bench_id,user_id,rating,comment)VALUES(?,?,?,?)",
      [bid, uid, r, c || ""],
    );
    var reviewId = db.getLastInsertRowId();
    if (!reviewId) {
      var rows = db.exec("SELECT MAX(id) as id FROM bench_ratings");
      reviewId = rows.length > 0 ? rows[0].values[0][0] : null;
    }
    if (req.files && req.files.length && reviewId) {
      req.files.forEach(function (file) {
        run("INSERT INTO review_photos(review_id,photo_url)VALUES(?,?)", [
          reviewId,
          "/uploads/" + file.filename,
        ]);
      });
    }
    var avgResult = q(
      "SELECT AVG(rating) as a FROM bench_ratings WHERE bench_id=?",
      [bid],
    );
    var avg = avgResult[0].a;
    run("UPDATE benches SET rating=? WHERE id=?", [avg, bid]);
    var benchResult = q("SELECT user_id FROM benches WHERE id=?", [bid]);
    var owner = benchResult.length ? benchResult[0].user_id : null;
    var bonus = r == 5 ? 5 : r == 4 ? 2 : r == 3 ? 1 : 0;
    if (owner && bonus > 0 && owner !== uid) {
      run(
        "UPDATE users SET reputation=reputation+?,total_reviews_received=total_reviews_received+1 WHERE id=?",
        [bonus, owner],
      );
    }
    res.json({ success: true, bonus: bonus });
  },
);

app.get("/api/admin/reviews", function (req, res) {
  var reviews = q(
    "SELECT br.*, b.description as bench_name, u.nickname FROM bench_ratings br LEFT JOIN benches b ON br.bench_id=b.id LEFT JOIN users u ON br.user_id=u.id ORDER BY br.created_at DESC",
  );
  var withPhotos = reviews.map(function (rev) {
    var photos = q("SELECT id,photo_url FROM review_photos WHERE review_id=?", [
      rev.id,
    ]);
    return Object.assign({}, rev, { photos: photos });
  });
  res.json({ success: true, reviews: withPhotos });
});

app.delete("/api/admin/reviews/:id", function (req, res) {
  var reviewId = req.params.id;
  var review = q("SELECT bench_id FROM bench_ratings WHERE id=?", [reviewId]);
  if (!review.length) {
    return res.json({ success: false, error: "Отзыв не найден" });
  }
  var benchId = review[0].bench_id;
  run("DELETE FROM review_photos WHERE review_id=?", [reviewId]);
  run("DELETE FROM bench_ratings WHERE id=?", [reviewId]);
  if (benchId) {
    var avgResult = q(
      "SELECT AVG(rating) as a FROM bench_ratings WHERE bench_id=?",
      [benchId],
    );
    var avg = avgResult[0].a || 0;
    run("UPDATE benches SET rating=? WHERE id=?", [avg, benchId]);
  }
  res.json({ success: true });
});

app.post("/api/benches/:id/favorite", function (req, res) {
  var uid = req.body.user_id,
    bid = req.params.id;
  var existing = q(
    "SELECT id FROM bench_favorites WHERE bench_id=? AND user_id=?",
    [bid, uid],
  );
  if (existing.length) {
    run("DELETE FROM bench_favorites WHERE bench_id=? AND user_id=?", [
      bid,
      uid,
    ]);
    res.json({ success: true, favorited: false });
  } else {
    run("INSERT INTO bench_favorites(bench_id,user_id)VALUES(?,?)", [bid, uid]);
    res.json({ success: true, favorited: true });
  }
});

app.post("/api/benches/:id/like", function (req, res) {
  var uid = req.body.user_id,
    bid = req.params.id;
  if (!uid) {
    return res.json({ success: false, error: "Войдите" });
  }
  var existing = q(
    "SELECT id FROM bench_likes WHERE bench_id=? AND user_id=?",
    [bid, uid],
  );
  var liked = false;
  if (existing.length) {
    run("DELETE FROM bench_likes WHERE bench_id=? AND user_id=?", [bid, uid]);
  } else {
    run("INSERT INTO bench_likes(bench_id,user_id)VALUES(?,?)", [bid, uid]);
    liked = true;
  }
  var likes = q(
    "SELECT COUNT(*) as count FROM bench_likes WHERE bench_id=?",
    [bid],
  );
  res.json({
    success: true,
    liked: liked,
    likes: likes.length ? likes[0].count : 0,
  });
});

app.get("/api/benches/:id/likes", function (req, res) {
  var likes = q("SELECT COUNT(*) as count FROM bench_likes WHERE bench_id=?", [
    req.params.id,
  ]);
  res.json({ success: true, likes: likes.length ? likes[0].count : 0 });
});

app.get("/api/user/:id/favorites", function (req, res) {
  var favs = q(
    "SELECT b.* FROM benches b JOIN bench_favorites f ON b.id=f.bench_id WHERE f.user_id=?",
    [req.params.id],
  );
  res.json({ success: true, favorites: favs });
});

app.post(
  "/api/benches/:id/report",
  upload.array("photos", 5),
  function (req, res) {
    var reportId = null;
    try {
      run("INSERT INTO bench_reports(bench_id,user_id,reason)VALUES(?,?,?)", [
        req.params.id,
        req.body.user_id,
        req.body.reason || "not_exists",
      ]);
      reportId = db.getLastInsertRowId();
      if (!reportId) {
        var rows = db.exec("SELECT MAX(id) as id FROM bench_reports");
        reportId = rows.length > 0 ? rows[0].values[0][0] : null;
      }
      if (req.files && req.files.length && reportId) {
        req.files.forEach(function (file) {
          run("INSERT INTO report_photos(report_id,photo_url)VALUES(?,?)", [
            reportId,
            "/uploads/" + file.filename,
          ]);
        });
      }
      res.json({ success: true });
    } catch (e) {
      console.error("Error creating report:", e);
      res.json({ success: false, error: "Ошибка создания жалобы" });
    }
  },
);

app.get("/api/user/:id/reports", function (req, res) {
  var reports = q(
    "SELECT br.*,COALESCE(b.name,'Скамейка') as bench_name FROM bench_reports br LEFT JOIN benches b ON br.bench_id=b.id WHERE br.user_id=? ORDER BY br.created_at DESC",
    [req.params.id],
  );
  var withPhotos = reports.map(function (rp) {
    var photos = q("SELECT id,photo_url FROM report_photos WHERE report_id=?", [
      rp.id,
    ]);
    return Object.assign({}, rp, { photos: photos });
  });
  res.json({ success: true, reports: withPhotos });
});

app.post("/api/reviews/:id/report", function (req, res) {
  var reviewId = req.params.id;
  var review = q("SELECT id FROM bench_ratings WHERE id=?", [reviewId]);
  if (!review.length) {
    return res.json({ success: false, error: "Отзыв не найден" });
  }
  run("INSERT INTO bench_reports(bench_id,user_id,reason)VALUES(?,?,?)", [
    req.body.bench_id || 0,
    req.body.user_id,
    req.body.reason || "spam",
  ]);
  res.json({ success: true });
});

app.delete("/api/user/reports/:id", function (req, res) {
  var reportId = req.params.id;
  var report = q("SELECT id FROM bench_reports WHERE id=?", [reportId]);
  if (!report.length) {
    return res.json({ success: false, error: "Жалоба не найдена" });
  }
  run("DELETE FROM bench_reports WHERE id=?", [reportId]);
  res.json({ success: true });
});

app.get("/api/user/:id/benches", function (req, res) {
  var benches = q(
    "SELECT * FROM benches WHERE user_id=? ORDER BY created_at DESC",
    [req.params.id],
  );
  res.json({ success: true, benches: benches });
});

app.get("/api/user/:id/received-reviews", function (req, res) {
  var reviews = q(
    "SELECT br.*,u.nickname as reviewer FROM bench_ratings br LEFT JOIN users u ON br.user_id=u.id WHERE br.bench_id IN (SELECT id FROM benches WHERE user_id=?) ORDER BY br.created_at DESC",
    [req.params.id],
  );
  var withPhotos = reviews.map(function (rev) {
    var photos = q("SELECT id,photo_url FROM review_photos WHERE review_id=?", [
      rev.id,
    ]);
    return Object.assign({}, rev, { photos: photos });
  });
  res.json({ success: true, reviews: withPhotos });
});

app.get("/api/user/:id/badges", function (req, res) {
  var users = q(
    "SELECT reputation,total_benches,total_reviews_received FROM users WHERE id=?",
    [req.params.id],
  );
  var badges = [];
  if (users.length) {
    var u = users[0];
    if (u.total_benches >= 1)
      badges.push({ name: "Первая скамейка", icon: "fa-chair" });
    if (u.total_benches >= 5)
      badges.push({ name: "5 скамеек", icon: "fa-award" });
    if (u.total_benches >= 10)
      badges.push({ name: "10 скамеек", icon: "fa-trophy" });
    if (u.total_reviews_received >= 1)
      badges.push({ name: "Первый отзыв", icon: "fa-comment" });
    if (u.reputation >= 10) badges.push({ name: "Новичок", icon: "fa-star" });
    if (u.reputation >= 50) badges.push({ name: "Активист", icon: "fa-medal" });
    if (u.reputation >= 100) badges.push({ name: "Легенда", icon: "fa-crown" });
  }
  res.json({ success: true, badges: badges });
});

app.get("/api/top-users", function (req, res) {
  var users = q(
    "SELECT id,nickname,reputation,total_benches FROM users ORDER BY reputation DESC LIMIT 10",
  );
  res.json({ success: true, users: users });
});

app.post("/api/user/:id/theme", function (req, res) {
  run("UPDATE users SET theme=? WHERE id=?", [req.body.theme, req.params.id]);
  res.json({ success: true });
});

app.get("/api/admin/benches", function (req, res) {
  var benches = q("SELECT * FROM benches ORDER BY created_at DESC");
  var withPhotos = benches.map(function (b) {
    var photos = q("SELECT id,photo_url FROM bench_photos WHERE bench_id=?", [
      b.id,
    ]);
    var likes = q(
      "SELECT COUNT(*) as count FROM bench_likes WHERE bench_id=?",
      [b.id],
    );
    return Object.assign({}, b, {
      photos: photos,
      likes: likes.length ? likes[0].count : 0,
    });
  });
  res.json({ success: true, benches: withPhotos });
});

app.get("/api/admin/users", function (req, res) {
  var users = q(
    "SELECT id,login,nickname,reputation,total_benches FROM users ORDER BY created_at DESC",
  );
  res.json({ success: true, users: users });
});

app.get("/api/admin/reports", function (req, res) {
  var reports = q(
    "SELECT br.*,COALESCE(b.name,'Скамейка') as bench_name,u.nickname FROM bench_reports br LEFT JOIN benches b ON br.bench_id=b.id LEFT JOIN users u ON br.user_id=u.id WHERE br.status='pending' ORDER BY br.created_at DESC",
  );
  var withPhotos = reports.map(function (rp) {
    var photos = q("SELECT id,photo_url FROM report_photos WHERE report_id=?", [
      rp.id,
    ]);
    return Object.assign({}, rp, { photos: photos });
  });
  res.json({ success: true, reports: withPhotos });
});

app.post("/api/admin/reports/:id/resolve", function (req, res) {
  run("UPDATE bench_reports SET status='resolved' WHERE id=?", [req.params.id]);
  res.json({ success: true });
});
app.post("/api/admin/reports/:id/respond", function (req, res) {
  run(
    "UPDATE bench_reports SET status='resolved',admin_response=? WHERE id=?",
    [req.body.response, req.params.id],
  );
  res.json({ success: true });
});
app.post("/api/admin/benches/:id/status", function (req, res) {
  run("UPDATE benches SET status=? WHERE id=?", [
    req.body.status,
    req.params.id,
  ]);
  res.json({ success: true });
});
app.delete("/api/admin/benches/:id", function (req, res) {
  run("DELETE FROM bench_likes WHERE bench_id=?", [req.params.id]);
  run("DELETE FROM bench_favorites WHERE bench_id=?", [req.params.id]);
  run("DELETE FROM bench_ratings WHERE bench_id=?", [req.params.id]);
  run("DELETE FROM bench_reports WHERE bench_id=?", [req.params.id]);
  run("DELETE FROM bench_photos WHERE bench_id=?", [req.params.id]);
  run("DELETE FROM benches WHERE id=?", [req.params.id]);
  res.json({ success: true });
});
app.get("/api/stats", function (req, res) {
  var b = q("SELECT COUNT(*) as c FROM benches WHERE status='active'");
  var u = q("SELECT COUNT(*) as c FROM users");
  res.json({ success: true, total_benches: b[0].c, total_users: u[0].c });
});

initDatabase().then(function () {
  app.listen(PORT, function () {
    console.log("Сервер: http://localhost:" + PORT);
  });
});
