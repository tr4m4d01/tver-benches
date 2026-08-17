/**
 * Load test: simulate 100+ concurrent users hitting /api/benches and POST /api/benches
 * Run: node load-test.js
 */
const http = require("http");
const BASE = "http://localhost:3000";

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (token) options.headers["Authorization"] = "Bearer " + token;
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function registerUser(i) {
  const r = await request("POST", "/api/register", {
    login: "loaduser_" + i,
    nickname: "LoadUser" + i,
    password: "pass123",
  });
  return JSON.parse(r.body);
}

async function loginUser(login) {
  const r = await request("POST", "/api/login", { login, password: "pass123" });
  return JSON.parse(r.body);
}

async function createBench(token) {
  const r = await request(
    "POST",
    "/api/benches",
    {
      description: "Load bench",
      latitude: 56.8587 + Math.random() * 0.01,
      longitude: 35.9176 + Math.random() * 0.01,
      user_name: "Load",
    },
    token,
  );
  return JSON.parse(r.body);
}

async function getBenches(token) {
  const r = await request("GET", "/api/benches", null, token);
  return JSON.parse(r.body);
}

async function runLoadTest() {
  const CONCURRENT = 120;
  const USERS = [];
  for (let i = 0; i < CONCURRENT; i++) {
    USERS.push(i);
  }

  console.log("Registering " + CONCURRENT + " users...");
  const regStart = Date.now();
  const regResults = await Promise.all(USERS.map((i) => registerUser(i)));
  const regTime = Date.now() - regStart;
  const regSuccess = regResults.filter((r) => r.success).length;
  console.log("Registered: " + regSuccess + "/" + CONCURRENT + " in " + regTime + "ms");

  console.log("Logging in users...");
  const loginStart = Date.now();
  const loginResults = await Promise.all(
    regResults.filter((r) => r.success).map((r, idx) => loginUser("loaduser_" + idx)),
  );
  const loginTime = Date.now() - loginStart;
  const tokens = loginResults.filter((r) => r.success).map((r) => r.token);
  console.log("Logged in: " + tokens.length + "/" + CONCURRENT + " in " + loginTime + "ms");

  console.log("Running mixed load (GET /api/benches + POST /api/benches)...");
  const loadStart = Date.now();
  const tasks = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i % 2 === 0) {
      tasks.push(createBench(token));
    } else {
      tasks.push(getBenches(token));
    }
  }
  const loadResults = await Promise.all(tasks);
  const loadTime = Date.now() - loadStart;
  const loadSuccess = loadResults.filter((r) => r.success).length;
  console.log("Load phase: " + loadSuccess + "/" + tasks.length + " succeeded in " + loadTime + "ms");
  console.log("Avg latency per request: " + Math.round(loadTime / tasks.length) + "ms");
  console.log("Throughput: " + Math.round((tasks.length / loadTime) * 1000) + " req/s");

  // Stress: 100 sequential write requests on same bench
  console.log("Stress: 50 concurrent likes on one bench...");
  const stressStart = Date.now();
  if (tokens.length > 0) {
    const stressTasks = [];
    for (let i = 0; i < 50; i++) {
      stressTasks.push(
        request("POST", "/api/benches/1/like", { user_id: 1 }, tokens[i % tokens.length]),
      );
    }
    const stressResults = await Promise.all(stressTasks);
    const stressTime = Date.now() - stressStart;
    const stressSuccess = stressResults.filter((r) => r.status === 200).length;
    console.log("Stress: " + stressSuccess + "/50 succeeded in " + stressTime + "ms");
  }
}

runLoadTest().catch((e) => {
  console.error("Load test error:", e);
  process.exit(1);
});
