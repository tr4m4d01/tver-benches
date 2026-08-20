import { it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { spawn } from "node:child_process";
import initSqlJs from "sql.js";

const BASE = "http://localhost:3000";
const TS = Date.now();
const LOGIN = "u1_" + TS;
const NICK = "SmokeU1_" + TS;
const PASS = "pass123";

const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x03, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x54, 0x55, 0xff, 0xd9,
]);

function ok(res) {
  if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
  return res;
}

async function postJSON(url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await ok(await fetch(BASE + url, { method: "POST", headers, body: JSON.stringify(body) }));
  return res.json();
}

async function getJSON(url, token) {
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await ok(await fetch(BASE + url, { headers }));
  return res.json();
}

async function delJSON(url, token) {
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(BASE + url, { method: "DELETE", headers });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function postForm(url, formData, token) {
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await ok(await fetch(BASE + url, { method: "POST", headers, body: formData }));
  return res.json();
}

function makeFormData(extra = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) {
    if (Buffer.isBuffer(v)) {
      fd.append(k, new Blob([v]), "test.jpg");
    } else {
      fd.append(k, String(v));
    }
  }
  return fd;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["server.js"], { stdio: ["pipe", "pipe", "pipe"] });
    const timeout = setTimeout(() => reject(new Error("Server didn't start in 10s")), 10000);
    proc.stdout.on("data", (data) => {
      const text = data.toString();
      if (text.includes("Сервер: http://localhost:3000")) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.stderr.on("data", (data) => {
      console.error("Server stderr:", data.toString());
    });
  });
}

function stopServer(proc) {
  return new Promise((resolve) => {
    proc.kill();
    proc.on("exit", () => resolve());
    setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 3000);
  });
}

async function makeUserAdmin(userId) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync("database.db"));
  db.run("UPDATE users SET is_admin=1 WHERE id=?", [userId]);
  fs.writeFileSync("database.db", Buffer.from(db.export()));
  db.close();
}

it("Smoke tests F-01..F-43 (sequential)", async () => {
  if (fs.existsSync("database.db")) fs.unlinkSync("database.db");

  let serverProc = await startServer();

  try {
    // F-01: register
    let d = await postJSON("/api/register", { login: LOGIN, nickname: NICK, password: PASS });
    assert.strictEqual(d.success, true, "F-01 register failed: " + JSON.stringify(d));

    // F-02: duplicate fails
    d = await postJSON("/api/register", { login: LOGIN, nickname: NICK, password: PASS });
    assert.strictEqual(d.success, false, "F-02 duplicate should fail");

    // F-03: login
    d = await postJSON("/api/login", { login: LOGIN, password: PASS });
    assert.strictEqual(d.success, true, "F-03 login failed");
    const user1Token = d.token;
    const userId = d.user.id;

    // F-04: wrong password
    d = await postJSON("/api/login", { login: LOGIN, password: "wrong" });
    assert.strictEqual(d.success, false, "F-04 wrong password should fail");

    // Register a second user for reviewing
    const LOGIN2 = "u2_" + TS;
    const NICK2 = "SmokeU2_" + TS;
    d = await postJSON("/api/register", { login: LOGIN2, nickname: NICK2, password: PASS });
    assert.strictEqual(d.success, true, "Register user2 failed");
    d = await postJSON("/api/login", { login: LOGIN2, password: PASS });
    assert.strictEqual(d.success, true, "Login user2 failed");
    const user2Token = d.token;

    // Make test user admin — modify DB file then restart server
    await stopServer(serverProc);
    await makeUserAdmin(userId);
    serverProc = await startServer();

    try {
      // F-13: create bench with photo
      const fdBench = makeFormData({
        description: "Скамейка smoke " + TS,
        latitude: "56.8587",
        longitude: "35.9176",
        user_name: NICK,
        photos: MINIMAL_JPEG,
      });
      d = await postForm("/api/benches", fdBench, user1Token);
      assert.strictEqual(d.success, true, "F-13 create bench failed: " + JSON.stringify(d));

      // F-14: find created bench via admin
      const adminBenches = await getJSON("/api/admin/benches", user1Token);
      const bench = adminBenches.benches.find((b) => b.description === "Скамейка smoke " + TS);
      assert.ok(bench, "F-14 bench not found in admin list");
      const benchId = bench.id;

      // F-07/F-08: load benches
      d = await getJSON("/api/benches", user1Token);
      assert.ok(Array.isArray(d.benches), "F-07 benches should be array");

      // F-29: like
      d = await postJSON("/api/benches/" + benchId + "/like", {}, user1Token);
      assert.strictEqual(d.success, true, "F-29 like failed");
      assert.strictEqual(d.liked, true, "F-29 liked should be true");

      // F-30: unlike
      d = await postJSON("/api/benches/" + benchId + "/like", {}, user1Token);
      assert.strictEqual(d.success, true, "F-30 unlike failed");
      assert.strictEqual(d.liked, false, "F-30 liked should be false");

      // F-32: favorite
      d = await postJSON("/api/benches/" + benchId + "/favorite", {}, user1Token);
      assert.strictEqual(d.success, true, "F-32 favorite failed");
      assert.strictEqual(d.favorited, true, "F-32 favorited should be true");

      // F-33: unfavorite
      d = await postJSON("/api/benches/" + benchId + "/favorite", {}, user1Token);
      assert.strictEqual(d.success, true, "F-33 unfavorite failed");
      assert.strictEqual(d.favorited, false, "F-33 unfavorite should be false");

      // F-17: review (user2 reviews user1's bench)
      const fdReview = makeFormData({ rating: "5", comment: "Отлично smoke " + TS, photos: MINIMAL_JPEG });
      d = await postForm("/api/benches/" + benchId + "/review", fdReview, user2Token);
      assert.strictEqual(d.success, true, "F-17 review failed: " + JSON.stringify(d));

      // F-18: self-review
      const fdBench2 = makeFormData({ description: "Моя скамейка self " + TS, latitude: "56.86", longitude: "35.92", user_name: NICK, photos: MINIMAL_JPEG });
      d = await postForm("/api/benches", fdBench2, user1Token);
      assert.strictEqual(d.success, true, "F-18 create bench2 failed");
      const adminBenches2 = await getJSON("/api/admin/benches", user1Token);
      const bench2 = adminBenches2.benches.find((b) => b.description === "Моя скамейка self " + TS);
      assert.ok(bench2, "F-18 bench2 not found");
      const bench2Id = bench2.id;
      const fdReview2 = makeFormData({ rating: "4", comment: "Пробуем", photos: MINIMAL_JPEG });
      d = await postForm("/api/benches/" + bench2Id + "/review", fdReview2, user1Token);
      assert.strictEqual(d.success, false, "F-18 self-review should fail: " + JSON.stringify(d));
      assert.ok(d.error && d.error.includes("самому себе"), "F-18 wrong error: " + d.error);

      // F-24: report
      const fdReport = makeFormData({ reason: "broken" });
      d = await postForm("/api/benches/" + benchId + "/report", fdReport, user1Token);
      assert.strictEqual(d.success, true, "F-24 report failed: " + JSON.stringify(d));
      const userReports = await getJSON("/api/user/" + userId + "/reports", user1Token);
      const report = userReports.reports.find((r) => r.reason === "broken");
      assert.ok(report, "F-24 report not found in user list");
      const reportId = report.id;

      // F-27: admin respond
      d = await postJSON("/api/admin/reports/" + reportId + "/respond", { response: "Спасибо за smoke!" }, user1Token);
      assert.strictEqual(d.success, true, "F-27 admin respond failed");

      // F-27: user sees response
      const userReports2 = await getJSON("/api/user/" + userId + "/reports", user1Token);
      const rp = userReports2.reports.find((r) => r.id === reportId);
      assert.ok(rp, "F-27 report not found after respond");
      assert.strictEqual(rp.admin_response, "Спасибо за smoke!", "F-27 admin response mismatch");

      // F-28: remove report
      d = await delJSON("/api/user/reports/" + reportId, user1Token);
      assert.strictEqual(d.success, true, "F-28 remove report failed");

      // F-34: favorites list
      d = await getJSON("/api/user/" + userId + "/favorites", user1Token);
      assert.ok(Array.isArray(d.favorites), "F-34 favorites should be array");

      // F-35: admin list benches
      d = await getJSON("/api/admin/benches", user1Token);
      assert.strictEqual(d.success, true, "F-35 admin benches failed");

      // F-39: approve bench (with admin_comment)
      d = await postJSON("/api/admin/benches/" + benchId + "/status", { status: "active", admin_comment: "Approved by smoke test" }, user1Token);
      assert.strictEqual(d.success, true, "F-39 approve failed");

      // F-42: admin delete review
      const benchReviews = await getJSON("/api/benches/" + benchId + "/reviews");
      const myReview = benchReviews.reviews.find((r) => r.comment === "Отлично smoke " + TS);
      assert.ok(myReview, "F-42 review not found for delete");
      d = await delJSON("/api/admin/reviews/" + myReview.id, user1Token);
      assert.strictEqual(d.success, true, "F-42 admin delete review failed");

      // F-05: session persists
      d = await getJSON("/api/user/" + userId + "/benches", user1Token);
      assert.strictEqual(d.success, true, "F-05 session persist failed");

      // F-09: search/list benches
      d = await getJSON("/api/benches", user1Token);
      assert.ok(Array.isArray(d.benches), "F-09 benches array");

      // F-22: review with photo (user2 reviews again)
      const fdReviewPhoto = makeFormData({ rating: "4", comment: "С фото " + TS, photos: MINIMAL_JPEG });
      d = await postForm("/api/benches/" + benchId + "/review", fdReviewPhoto, user2Token);
      assert.strictEqual(d.success, true, "F-22 review photo failed: " + JSON.stringify(d));

      // F-26: report with photo
      const fdReportPhoto = makeFormData({ reason: "spam", photos: MINIMAL_JPEG });
      d = await postForm("/api/benches/" + benchId + "/report", fdReportPhoto, user1Token);
      assert.strictEqual(d.success, true, "F-26 report photo failed: " + JSON.stringify(d));

      // F-31: like requires auth
      d = await postJSON("/api/benches/" + benchId + "/like", {});
      assert.strictEqual(d.success, false, "F-31 like without token should fail");

      // F-43: reject bench with admin_comment
      d = await postJSON("/api/admin/benches/" + bench2Id + "/status", { status: "rejected", admin_comment: "Spam bench" }, user1Token);
      assert.strictEqual(d.success, true, "F-43 reject failed: " + JSON.stringify(d));

      // Verify admin_comment is returned
      const benchCheck = (await getJSON("/api/admin/benches", user1Token)).benches.find((b) => b.id === bench2Id);
      assert.ok(benchCheck, "F-43 bench2 not found");
      assert.strictEqual(benchCheck.admin_comment, "Spam bench", "F-43 admin_comment not saved");

      // F-41: user notifications (user should have at least 1 from bench approval)
      const notices = await getJSON("/api/user/" + userId + "/notifications", user1Token);
      assert.ok(notices.notifications && notices.notifications.length >= 1, "F-41 should have notifications");
      const approvedNotice = notices.notifications.find((n) => n.related_id == benchId);
      assert.ok(approvedNotice, "F-41 approved notice not found");
      assert.strictEqual(approvedNotice.type, "success", "F-41 notice type should be success");

      // Mark notifications as read
      d = await postJSON("/api/user/" + userId + "/notifications/read", {}, user1Token);
      assert.strictEqual(d.success, true, "Notifications read failed");

      // Clear notifications
      d = await postJSON("/api/user/" + userId + "/notifications/clear", {}, user1Token);
      assert.strictEqual(d.success, true, "Notifications clear failed");

      console.log("All smoke tests passed!");
    } finally {
      await stopServer(serverProc).catch(() => {});
    }
  } catch (e) {
    await stopServer(serverProc).catch(() => {});
    throw e;
  }
});
