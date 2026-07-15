const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const DB = path.join(DATA, "maps.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(DB)) fs.writeFileSync(DB, "[]", "utf8");

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

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
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

function serveIndex(res) {
  send(res, 200, fs.readFileSync(publicFile("index.html"), "utf8"), "text/html; charset=utf-8");
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

  if (req.method === "GET" && url.pathname === "/api/maps") {
    return send(res, 200, maps.map(({ points, ...map }) => map));
  }

  if (req.method === "POST" && url.pathname === "/api/maps") {
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

  const match = url.pathname.match(/^\/api\/maps\/([^/]+)$/);
  if (match && req.method === "GET") {
    const map = maps.find(item => item.id === match[1]);
    return map ? send(res, 200, map) : send(res, 404, { error: "Карта не найдена" });
  }

  if (match && req.method === "DELETE") {
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
    if (serveStatic(req, res)) return;
    return serveIndex(res);
  } catch (error) {
    return send(res, 500, { error: error.message || "Ошибка сервера" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`DSP Tools server: http://127.0.0.1:${PORT}`);
});
