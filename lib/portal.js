import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Loads `.env` for a LOCAL run, searching upwards from this file's directory.
// On the deployed server the three managed variables arrive via the process
// environment, so this is a no-op there. Values already present win.
export function loadEnvUpwards(startDir, maxLevels = 1) {
  const environmentKeys = new Set(Object.keys(process.env));
  let dir = path.resolve(startDir);
  for (let level = 0; level <= maxLevels; level += 1) {
    const file = path.join(dir, ".env");
    if (existsSync(file)) {
      try {
        for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
          if (!m || environmentKeys.has(m[1])) continue;
          process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
        }
      } catch {
        // Unreadable file — treat as absent.
      }
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export class PortalError extends Error {
  constructor(kind, message, status, extra = {}) {
    super(message);
    this.kind = kind;
    this.status = status ?? null;
    this.code = extra.code ?? null;
    this.scope = extra.scope ?? null;
    this.userMessage = extra.userMessage ?? null;
    this.switchUrl = extra.switchUrl ?? null;
  }
}

const KIND_BY_CODE = new Map([
  ["MISSING_API_KEY", "no_key"],
  ["TOKEN_MISSING", "no_portal_access"],
  ["SCOPE_DENIED", "scope_denied"],
  ["WRITE_BLOCKED_READONLY_KEY", "read_only_key"],
  ["BITRIX_ACCESS_DENIED", "access_denied"],
  ["B24_TARIFF_RESTRICTION", "tariff"],
]);

function missingScope(message, details) {
  if (typeof details?.requiredScope === "string") return details.requiredScope;
  const m = /(?:'|")([\w:-]+(?:\.[\w:-]+)*)(?:'|")/.exec(message || "")
    || /\b(vibe:[\w-]+(?:\.[\w-]+)*)/.exec(message || "")
    || /scope:\s*([\w:-]+(?:\.[\w:-]+)*)/i.exec(message || "");
  return m ? m[1] : null;
}

function cabinetLink(switchUrl, base) {
  if (typeof switchUrl !== "string" || !switchUrl) return null;
  try {
    const origin = new URL(base).origin;
    const url = new URL(switchUrl, origin);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

function toPortalError(status, data, base) {
  const nested = data?.error && typeof data.error === "object" ? data.error : {};
  const code = nested.code ?? data?.code ?? null;
  const message = nested.message
    ?? (typeof data?.error === "string" ? data.error : null)
    ?? `portal_error_${status}`;
  const details = nested.details ?? data?.details ?? {};
  const userMessage = [nested.userMessage, data?.userMessage]
    .find((v) => typeof v === "string" && v.trim()) ?? null;
  const kind = status === 429 ? "rate_limited"
    : KIND_BY_CODE.get(code) ?? (status === 401 ? "denied" : status === 403 ? "forbidden" : "portal_error");
  return new PortalError(kind, message, status, {
    code,
    userMessage,
    scope: kind === "scope_denied" ? missingScope(message, details) : null,
    switchUrl: kind === "read_only_key" ? cabinetLink(details.switchUrl, base) : null,
  });
}

// Portal refusals must never be presented as "the portal is broken" or, worse,
// as key advice when they are not about the key at all.
export const HTTP_BY_KIND = {
  no_key: 503, timeout: 504, unreachable: 504, rate_limited: 429, portal_error: 502,
  denied: 403, no_portal_access: 403, scope_denied: 403, read_only_key: 403,
  access_denied: 403, tariff: 403, forbidden: 403,
};

export const TEXT_BY_KIND = {
  no_key: "Приложение запущено без ключа приложения — данные портала недоступны.",
  timeout: "Портал отвечает дольше обычного, данные ещё не обновились. Он под нагрузкой — попробуйте через несколько минут.",
  unreachable: "Не удалось связаться с порталом. Похоже на временный сбой сети.",
  rate_limited: "Слишком много запросов к порталу. Данные обновятся через несколько минут.",
  denied: "Ключ приложения больше не действует: он отозван, истёк или недействителен.",
  no_portal_access: "У ключа приложения нет действующего подключения к порталу Битрикс24. Причина видна на странице ключа в кабинете VibeCode; иногда доступ должен выдать администратор портала.",
  scope_denied: "Ключу приложения не хватает права на эти данные.",
  read_only_key: "Ключ приложения открыт только на чтение.",
  access_denied: "Битрикс24 отказал в доступе: у сотрудника, от имени которого работает приложение, нет прав на эти данные. Права выдаёт администратор портала.",
  tariff: "Тариф портала Битрикс24 не включает эту возможность.",
  forbidden: "Платформа VibeCode отказала в доступе к данным портала.",
  portal_error: "Портал вернул ошибку при запросе данных.",
};

export function failureText(error) {
  if (!error) return null;
  if (error.userMessage) return error.userMessage;
  if (error.kind === "scope_denied" && error.scope) {
    return `Ключу приложения не хватает права «${error.scope}».`;
  }
  return TEXT_BY_KIND[error.kind] || TEXT_BY_KIND.portal_error;
}

export function createPortal({ base, key, timeoutMs }) {
  async function portal(pathname, { method = "GET", body, params } = {}) {
    if (!key || !base) throw new PortalError("no_key", "portal env vars are absent");
    const query = params
      ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString()
      : "";
    const url = `${base}${pathname}${query ? `?${query}` : ""}`;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": key,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      });
    } catch (err) {
      const kind = err?.name === "AbortError" ? "timeout" : "unreachable";
      throw new PortalError(kind, `${pathname} ${kind} after ${Date.now() - startedAt}ms`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (!res.ok) throw toPortalError(res.status, data, base);
    console.log(`[portal] ${method} ${pathname} -> ${res.status} in ${Date.now() - startedAt}ms`);
    return data?.data ?? data;
  }
  return portal;
}
