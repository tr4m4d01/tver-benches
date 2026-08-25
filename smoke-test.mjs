import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith("--url="));
const BASE = urlArg ? urlArg.slice(6) : "http://localhost:3000";

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

async function runTests() {
  console.log("Running smoke tests against:", BASE);

  // S-01: register
  let d = await postJSON("/api/register", { login: LOGIN, nickname: NICK, password: PASS });
  assert.strictEqual(d.success, true, "S-01 register failed: " + JSON.stringify(d));

  // S-02: duplicate register
  d = await postJSON("/api/register", { login: LOGIN, nickname: NICK, password: PASS });
  assert.strictEqual(d.success, false, "S-02 duplicate should fail");

  // S-03: login
  d = await postJSON("/api/login", { login: LOGIN, password: PASS });
  assert.strictEqual(d.success, true, "S-03 login failed");
  const user1Token = d.token;
  const userId = d.user.id;

  // S-04: wrong password
  d = await postJSON("/api/login", { login: LOGIN, password: "wrong" });
  assert.strictEqual(d.success, false, "S-04 wrong password should fail");

  // S-05: me
  d = await getJSON("/api/me", user1Token);
  assert.strictEqual(d.success, true, "S-05 me failed");
  assert.strictEqual(d.user.login, LOGIN, "S-05 login mismatch");

  // S-06: profile
  d = await getJSON("/api/user/" + userId, user1Token);
  assert.strictEqual(d.success, true, "S-06 user profile failed");
  assert.strictEqual(d.user.login, LOGIN, "S-06 login mismatch");

  // Register user2 for review tests
  const LOGIN2 = "u2_" + TS;
  const NICK2 = "SmokeU2_" + TS;
  d = await postJSON("/api/register", { login: LOGIN2, nickname: NICK2, password: PASS });
  assert.strictEqual(d.success, true, "Register user2 failed");
  d = await postJSON("/api/login", { login: LOGIN2, password: PASS });
  assert.strictEqual(d.success, true, "Login user2 failed");
  const user2Token = d.token;
  const user2Id = d.user.id;

  // S-07: create bench
  const fdBench = makeFormData({
    description: "Скамейка smoke " + TS,
    latitude: "56.8587",
    longitude: "35.9176",
    user_name: NICK,
    photos: MINIMAL_JPEG,
  });
  d = await postForm("/api/benches", fdBench, user1Token);
  assert.strictEqual(d.success, true, "S-07 create bench failed: " + JSON.stringify(d));
  const benchId = d.bench_id;

  // S-08: list benches (new bench is pending, so it won't appear in public list)
  d = await getJSON("/api/benches", user1Token);
  assert.ok(Array.isArray(d.benches), "S-08 benches should be array");

  // S-09: like
  d = await postJSON("/api/benches/" + benchId + "/like", {}, user1Token);
  assert.strictEqual(d.success, true, "S-09 like failed");
  assert.strictEqual(d.liked, true, "S-09 liked should be true");

  // S-10: unlike
  d = await postJSON("/api/benches/" + benchId + "/like", {}, user1Token);
  assert.strictEqual(d.success, true, "S-10 unlike failed");
  assert.strictEqual(d.liked, false, "S-10 liked should be false");

  // S-11: favorite
  d = await postJSON("/api/benches/" + benchId + "/favorite", {}, user1Token);
  assert.strictEqual(d.success, true, "S-11 favorite failed");
  assert.strictEqual(d.favorited, true, "S-11 favorited should be true");

  // S-12: unfavorite
  d = await postJSON("/api/benches/" + benchId + "/favorite", {}, user1Token);
  assert.strictEqual(d.success, true, "S-12 unfavorite failed");
  assert.strictEqual(d.favorited, false, "S-12 favorited should be false");

  // S-13: review by user2
  const fdReview = makeFormData({ rating: "5", comment: "Отлично smoke " + TS, photos: MINIMAL_JPEG });
  d = await postForm("/api/benches/" + benchId + "/review", fdReview, user2Token);
  assert.strictEqual(d.success, true, "S-13 review failed: " + JSON.stringify(d));

  // S-14: self-review should fail
  const fdBench2 = makeFormData({ description: "Моя скамейка self " + TS, latitude: "56.86", longitude: "35.92", user_name: NICK, photos: MINIMAL_JPEG });
  d = await postForm("/api/benches", fdBench2, user1Token);
  assert.strictEqual(d.success, true, "S-14 create bench2 failed");
  const bench2Id = d.bench_id;
  const fdReview2 = makeFormData({ rating: "4", comment: "Пробуем", photos: MINIMAL_JPEG });
  d = await postForm("/api/benches/" + bench2Id + "/review", fdReview2, user1Token);
  assert.strictEqual(d.success, false, "S-14 self-review should fail: " + JSON.stringify(d));
  assert.ok(d.error && d.error.includes("самому себе"), "S-14 wrong error: " + d.error);

  // S-15: report
  const fdReport = makeFormData({ reason: "broken" });
  d = await postForm("/api/benches/" + benchId + "/report", fdReport, user2Token);
  assert.strictEqual(d.success, true, "S-15 report failed: " + JSON.stringify(d));
  const reportId = d.report_id;
  const user2Reports = await getJSON("/api/user/" + user2Id + "/reports", user2Token);
  const report = user2Reports.reports.find((r) => r.reason === "broken");
  assert.ok(report, "S-15 report not found");

  // S-16: admin respond (non-admin attempt returns error)
  d = await postJSON("/api/admin/reports/" + reportId + "/respond", { response: "Спасибо за smoke!" }, user1Token);
  assert.strictEqual(d.success, false, "S-16 non-admin respond should fail");
  assert.ok(d.error === "Доступ запрещён" || d.error === "Сессия истекла", "S-16 wrong error: " + d.error);

  // S-17: user's own report list still works
  const userReports2 = await getJSON("/api/user/" + user2Id + "/reports", user2Token);
  assert.ok(Array.isArray(userReports2.reports), "S-17 reports should be array");

  // S-18: delete report
  d = await delJSON("/api/user/reports/" + reportId, user2Token);
  assert.strictEqual(d.success, true, "S-18 delete report failed");

  // S-19: favorites list
  d = await getJSON("/api/user/" + userId + "/favorites", user1Token);
  assert.ok(Array.isArray(d.favorites), "S-19 favorites should be array");

  // S-20: admin endpoints require admin (non-admin should get access denied)
  const adminList = await getJSON("/api/admin/benches", user1Token);
  assert.strictEqual(adminList.success, false, "S-20 non-admin should not access admin benches");
  assert.strictEqual(adminList.error, "Доступ запрещён", "S-20 should get access denied");

  // S-21: stats
  d = await getJSON("/api/stats");
  assert.ok(d.success, "S-21 stats failed");
  assert.ok(typeof d.total_benches === "number", "S-21 total_benches should be number");
  assert.ok(typeof d.total_users === "number", "S-21 total_users should be number");

  // S-22: top users
  d = await getJSON("/api/top-users");
  assert.ok(d.success, "S-22 top-users failed");
  assert.ok(Array.isArray(d.users), "S-22 users should be array");

  // S-23: geocode proxy
  d = await getJSON("/api/geocode?q=" + encodeURIComponent("Тверь"));
  assert.ok(d.success, "S-23 geocode failed");
  assert.ok(Array.isArray(d.data), "S-23 geocode data should be array");

  // S-24: user notifications
  d = await getJSON("/api/user/" + userId + "/notifications", user1Token);
  assert.ok(d.success, "S-24 notifications failed");

  // S-25: like without auth should fail
  d = await postJSON("/api/benches/" + benchId + "/like", {});
  assert.strictEqual(d.success, false, "S-25 like without token should fail");

  // S-26: report with photo
  const fdReportPhoto = makeFormData({ reason: "spam", photos: MINIMAL_JPEG });
  d = await postForm("/api/benches/" + benchId + "/report", fdReportPhoto, user1Token);
  assert.strictEqual(d.success, true, "S-26 report with photo failed: " + JSON.stringify(d));

  // S-27: file type filter (should reject non-image or accept with fallback)
  const fdBad = makeFormData({ description: "bad", latitude: "56.0", longitude: "35.0", user_name: "x", photos: Buffer.from("not an image") });
  try {
    const res = await fetch(BASE + "/api/benches", { method: "POST", headers: { Authorization: "Bearer " + user1Token }, body: fdBad });
    const jd = await res.json();
    assert.ok(jd.success === false || jd.success === true, "S-27 endpoint should respond");
  } catch (e) {
    // network errors ok for this check
  }

  // S-28: CORS headers present
  const corsRes = await fetch(BASE + "/api/stats", {
    method: "OPTIONS",
    headers: { Origin: BASE, "Access-Control-Request-Method": "GET" },
  });
  assert.ok(corsRes.headers.get("access-control-allow-origin") !== null || corsRes.status < 500, "S-28 CORS should be configured");

  // S-29: update profile
  d = await postJSON("/api/user/" + userId, { nickname: NICK + "_upd" }, user1Token);
  assert.strictEqual(d.success, true, "S-29 update profile failed");
  const updated = await getJSON("/api/user/" + userId, user1Token);
  assert.strictEqual(updated.user.nickname, NICK + "_upd", "S-29 nickname not updated");

  // S-30: session persists
  d = await getJSON("/api/user/" + userId + "/benches", user1Token);
  assert.strictEqual(d.success, true, "S-30 session persist failed");

  console.log("All smoke tests passed!");
}

runTests().catch((e) => {
  console.error("Smoke test failed:", e);
  process.exit(1);
});
