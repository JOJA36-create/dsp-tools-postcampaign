const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const DB = path.join(DATA, "maps.json");
const USERS_DB = path.join(DATA, "users.json");
const PORTAL_USER = process.env.PORTAL_USER || "evgeny@agency.ru";
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || "demo-password";
const MAP_PROVIDER = process.env.MAP_PROVIDER || "osm";
const YANDEX_MAPS_API_KEY = process.env.YANDEX_MAPS_API_KEY || "";
const LEGAL_OPERATOR_NAME = process.env.LEGAL_OPERATOR_NAME || "Евгений К., физическое лицо";
const PRIVACY_CONTACT_EMAIL = process.env.PRIVACY_CONTACT_EMAIL || "";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = "dsp_session";
const sessions = new Map();
const loginAttempts = new Map();

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(DB)) fs.writeFileSync(DB, "[]", "utf8");
if (!fs.existsSync(USERS_DB)) fs.writeFileSync(USERS_DB, "[]", "utf8");

function readMaps() {
  try {
    return JSON.parse(fs.readFileSync(DB, "utf8"));
  } catch {
    return [];
  }
}

function writeMaps(maps) {
  fs.writeFileSync(DB, JSON.stringify(maps, null, 2), "utf8");
}

function readUsers() {
  try {
    const users = JSON.parse(fs.readFileSync(USERS_DB, "utf8"));
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_DB, JSON.stringify(users, null, 2), "utf8");
}

function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}

function passwordMatches(password, user) {
  if (!user?.salt || !user?.passwordHash) return false;
  return safeEqual(crypto.scryptSync(String(password), user.salt, 64).toString("hex"), user.passwordHash);
}

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(Buffer.isBuffer(body) ? body : (typeof body === "string" ? body : JSON.stringify(body)));
}

function safeEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left)).digest();
  const b = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(item => {
    const index = item.indexOf("=");
    if (index < 0) return ["", ""];
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))];
  }).filter(([key]) => key));
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function sessionCookie(req, token, maxAge) {
  const secure = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    send(res, 401, { error: "Требуется вход в портал" });
    return null;
  }
  return session;
}

function loginKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function loginAllowed(req) {
  const key = loginKey(req);
  const attempt = loginAttempts.get(key);
  if (!attempt || attempt.resetAt <= Date.now()) {
    loginAttempts.set(key, { count: 0, resetAt: Date.now() + 10 * 60 * 1000 });
    return true;
  }
  return attempt.count < 10;
}

function recordFailedLogin(req) {
  const key = loginKey(req);
  const attempt = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  attempt.count += 1;
  loginAttempts.set(key, attempt);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Слишком большой запрос"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function publicFile(file) {
  return path.join(PUBLIC, file);
}

function requireAdmin(req, res) {
  const session = requireSession(req, res);
  if (!session) return null;
  if (session.role !== "admin") {
    send(res, 403, { error: "Access denied" });
    return null;
  }
  return session;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function serveIndex(res) {
  send(res, 200, fs.readFileSync(publicFile("index.html"), "utf8"), "text/html; charset=utf-8");
}

function servePrivacy(res) {
  const contactEmail = escapeHtml(PRIVACY_CONTACT_EMAIL);
  const contactSection = PRIVACY_CONTACT_EMAIL
    ? `<h2>Обращения</h2><p>По вопросам обработки данных, удаления карты или реализации прав субъекта персональных данных обращайтесь: <a href="mailto:${contactEmail}">${contactEmail}</a>.</p>`
    : "";
  const html = fs.readFileSync(publicFile("privacy.html"), "utf8")
    .replaceAll("{{operatorName}}", escapeHtml(LEGAL_OPERATOR_NAME))
    .replaceAll("{{contactSection}}", contactSection);
  send(res, 200, html, "text/html; charset=utf-8");
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cleanPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const full = path.normalize(path.join(PUBLIC, cleanPath));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return false;
  }
  const ext = path.extname(full).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml"
  };
  send(res, 200, fs.readFileSync(full), types[ext] || "application/octet-stream");
  return true;
}

async function handleApi(req, res, url) {
  const maps = readMaps();

  if (req.method === "GET" && url.pathname === "/api/public-config") {
    return send(res, 200, {
      mapProvider: MAP_PROVIDER,
      yandexMapsApiKey: YANDEX_MAPS_API_KEY
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (!loginAllowed(req)) return send(res, 429, { error: "Слишком много попыток. Повторите через 10 минут" });
    const payload = JSON.parse(await readBody(req) || "{}");
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");
    let account = null;
    if (safeEqual(username, PORTAL_USER) && safeEqual(password, PORTAL_PASSWORD)) {
      account = { id: "admin", username: PORTAL_USER, displayName: "Евгений", role: "admin" };
    } else {
      const user = readUsers().find(item => String(item.username || "").toLowerCase() === username.toLowerCase());
      if (user && passwordMatches(password, user)) {
        account = { id: user.id, username: user.username, displayName: user.name, role: "member" };
      }
    }
    if (!account) {
      recordFailedLogin(req);
      return send(res, 401, { error: "Неверный логин или пароль" });
    }
    loginAttempts.delete(loginKey(req));
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, { ...account, expiresAt: Date.now() + SESSION_TTL_MS });
    return send(res, 200, account, "application/json; charset=utf-8", {
      "Set-Cookie": sessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000))
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    return send(res, 200, { ok: true }, "application/json; charset=utf-8", {
      "Set-Cookie": sessionCookie(req, "", 0)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/session") {
    const session = getSession(req);
    if (session) return send(res, 200, { username: session.username, displayName: session.displayName, role: session.role });
    return session ? send(res, 200, { username: session.username }) : send(res, 401, { error: "Нет активной сессии" });
  }

  if (url.pathname === "/api/users") {
    if (!requireAdmin(req, res)) return;
    if (req.method === "GET") {
      return send(res, 200, readUsers().map(({ passwordHash, salt, ...user }) => user));
    }
    if (req.method === "POST") {
      const payload = JSON.parse(await readBody(req) || "{}");
      const name = String(payload.name || "").trim().slice(0, 80);
      const username = String(payload.username || "").trim().toLowerCase().slice(0, 140);
      const password = String(payload.password || "");
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) || password.length < 10) {
        return send(res, 400, { error: "Enter a name, a valid email and a password of at least 10 characters" });
      }
      const users = readUsers();
      const exists = username === PORTAL_USER.toLowerCase() || users.some(user => user.username.toLowerCase() === username);
      if (exists) return send(res, 409, { error: "This email is already registered" });
      const credentials = passwordRecord(password);
      const user = { id: crypto.randomUUID(), name, username, role: "member", createdAt: new Date().toISOString(), passwordHash: credentials.hash, salt: credentials.salt };
      users.unshift(user);
      writeUsers(users);
      const { passwordHash, salt, ...safeUser } = user;
      return send(res, 201, safeUser);
    }
  }

  const match = url.pathname.match(/^\/api\/maps\/([^/]+)$/);
  if (match && req.method === "GET") {
    const map = maps.find(item => item.id === match[1]);
    return map ? send(res, 200, map) : send(res, 404, { error: "Карта не найдена" });
  }

  if (req.method === "GET" && url.pathname === "/api/maps") {
    if (!requireSession(req, res)) return;
    return send(res, 200, maps.map(({ points, ...map }) => map));
  }

  if (req.method === "POST" && url.pathname === "/api/maps") {
    const session = requireSession(req, res);
    if (!session) return;
    const payload = JSON.parse(await readBody(req) || "{}");
    if (!payload.title || !Array.isArray(payload.points) || !payload.points.length) {
      return send(res, 400, { error: "Не хватает названия или точек карты" });
    }
    const now = new Date();
    const contacts = payload.points.reduce((s, p) => s + Number(p.contacts || 0), 0);
    const plays = payload.points.reduce((s, p) => s + Number(p.plays || 0), 0);
    const spend = payload.points.reduce((s, p) => s + Number(p.spend || 0), 0);
    const map = {
      id: crypto.randomUUID(),
      title: String(payload.title).slice(0, 140),
      client: String(payload.client || "Без клиента").slice(0, 140),
      owner: "Евгений",
      owner: session.displayName || session.username,
      ownerId: session.id,
      createdAt: now.toISOString(),
      pointsCount: payload.points.length,
      citiesCount: new Set(payload.points.map(p => p.city).filter(Boolean)).size,
      formatsCount: new Set(payload.points.map(p => p.format).filter(Boolean)).size,
      contacts,
      plays,
      spend,
      points: payload.points
    };
    maps.unshift(map);
    writeMaps(maps);
    return send(res, 201, map);
  }

  if (match && req.method === "DELETE") {
    const session = requireSession(req, res);
    if (!session) return;
    const map = maps.find(item => item.id === match[1]);
    if (!map) return send(res, 404, { error: "Map not found" });
    if (session.role !== "admin" && map.ownerId !== session.id) {
      return send(res, 403, { error: "Only the map owner can delete this map" });
    }
    const next = maps.filter(item => item.id !== match[1]);
    writeMaps(next);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "API не найден" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    if (url.pathname === "/privacy") return servePrivacy(res);
    if (serveStatic(req, res)) return;
    return serveIndex(res);
  } catch (error) {
    return send(res, 500, { error: error.message || "Ошибка сервера" });
  }
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log(`DSP Tools server: http://${shownHost}:${PORT}`);
  if (PORTAL_PASSWORD === "demo-password") {
    console.warn("WARNING: set PORTAL_PASSWORD before publishing the portal.");
  }
});
