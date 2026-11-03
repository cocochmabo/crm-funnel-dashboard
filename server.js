import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPortal, loadEnvUpwards, failureText, HTTP_BY_KIND } from "./lib/portal.js";
import { createDashboard, parseCategory, parsePeriod } from "./lib/dashboard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KEY_FROM_ENVIRONMENT = Boolean(process.env.BITRIX_API_KEY);
const ENV_FILE = loadEnvUpwards(__dirname);

const PORT = process.env.PORT || 3000;
const BASE = process.env.BITRIX_API_BASE_URL || "";
const KEY = process.env.BITRIX_API_KEY || "";
const PORTAL_DOMAIN = process.env.BITRIX_PORTAL_DOMAIN || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const PORTAL_TIMEOUT_MS = Number(process.env.PORTAL_TIMEOUT_MS || 180_000);

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

console.log(
  KEY
    ? `portal key loaded from ${KEY_FROM_ENVIRONMENT ? "the environment" : ENV_FILE}`
    : `NO portal key: ${ENV_FILE ? `${ENV_FILE} has no BITRIX_API_KEY` : "no .env found and none in the environment"}`
      + " — /api/* will report the missing key until it appears",
);

const portal = createPortal({ base: BASE, key: KEY, timeoutMs: PORTAL_TIMEOUT_MS });
const dashboard = createDashboard({ portal, portalDomain: PORTAL_DOMAIN });

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  if (url.pathname === "/api/dashboard") {
    const period = parsePeriod(url.searchParams);
    const categoryId = parseCategory(url.searchParams);
    const entry = dashboard.get(period, categoryId, { force: url.searchParams.get("fresh") === "1" });
    const meta = {
      updatedAt: entry.at ? new Date(entry.at).toISOString() : null,
      ageMs: entry.at ? Date.now() - entry.at : null,
      building: Boolean(entry.building),
      warning: entry.data && entry.error ? failureText(entry.error) : null,
    };

    if (entry.data) {
      json(res, 200, { ...entry.data, meta });
      return;
    }
    if (entry.error) {
      json(res, HTTP_BY_KIND[entry.error.kind] || 500, {
        error: failureText(entry.error),
        kind: entry.error.kind,
        code: entry.error.code ?? null,
        meta,
      });
      return;
    }
    const kind = KEY && BASE ? "loading" : "no_key";
    if (kind === "loading") {
      json(res, 202, {
        error: "Собираем данные портала. Первый сбор занимает до пары минут.",
        kind: "loading",
        meta,
      });
      return;
    }
    json(res, 503, {
      error: failureText({ kind: "no_key" }),
      kind: "no_key",
      code: "MISSING_API_KEY",
      meta,
    });
    return;
  }

  if (url.pathname === "/api/health") {
    json(res, 200, {
      keyPresent: Boolean(KEY),
      keySource: KEY ? (KEY_FROM_ENVIRONMENT ? "environment" : ENV_FILE) : null,
      baseUrlPresent: Boolean(BASE),
      portalDomainPresent: Boolean(PORTAL_DOMAIN),
      portalTimeoutMs: PORTAL_TIMEOUT_MS,
      uptimeSec: Math.round(process.uptime()),
    });
    return;
  }

  // The frame's page request carries the placement context. Log it once, without
  // secrets, so a "wrong id" report is answered by the log instead of guessing.
  if (url.pathname === "/" && url.searchParams.has("placement")) {
    console.log(`[placement] ${url.searchParams.get("placement")} ${url.searchParams.get("placement_options") || ""}`.slice(0, 600));
  }

  let rel;
  try {
    rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  const isDotfile = rel.split(/[\\/]/).some((seg) => seg.startsWith("."));
  const filePath = path.resolve(PUBLIC_DIR, rel);
  const insidePublic = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (isDotfile || !insidePublic) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const file = await readFile(filePath);
    const type = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
    res.end(file);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
  dashboard.start();
});
