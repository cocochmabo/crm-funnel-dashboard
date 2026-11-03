import { PortalError } from "./portal.js";

const DAY = 86_400_000;
const PRESETS = new Map([
  ["all", "За всё время"],
  ["7d", "7 дней"],
  ["30d", "30 дней"],
  ["90d", "90 дней"],
  ["quarter", "Квартал"],
  ["year", "Год"],
  ["custom", "Свой период"],
]);

function toDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const iso = (d) => d.toISOString().slice(0, 10);

// The browser never gets to dictate a raw range: only a known preset or a
// validated pair of dates. Everything else falls back to "all time".
export function parsePeriod(searchParams) {
  const preset = searchParams.get("period") || "30d";
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (preset === "custom") {
    const fromRaw = searchParams.get("from");
    const toRaw = searchParams.get("to");
    let from = toDate(fromRaw);
    let to = toDate(toRaw);
    if (from && to && from > to) [from, to] = [to, from];
    if (from || to) {
      return {
        key: `custom:${from ? iso(from) : ".." }:${to ? iso(to) : ".."}`,
        preset: "custom",
        label: `${from ? iso(from) : "начало"} — ${to ? iso(to) : "сегодня"}`,
        from: from ? iso(from) : null,
        to: to ? iso(to) : null,
      };
    }
    return periodFromDays(30, today, "30d");
  }

  if (preset === "all") {
    return { key: "all", preset: "all", label: PRESETS.get("all"), from: null, to: null };
  }
  if (preset === "year") return periodFromDays(365, today, "year");
  if (preset === "quarter") return periodFromDays(90, today, "quarter");
  if (preset === "7d") return periodFromDays(7, today, "7d");
  if (preset === "90d") return periodFromDays(90, today, "90d");
  return periodFromDays(30, today, "30d");
}

function periodFromDays(days, today, preset) {
  const from = new Date(today.getTime() - (days - 1) * DAY);
  const to = new Date(today.getTime() + DAY - 1);
  return {
    key: `${preset}:${iso(from)}:${iso(today)}`,
    preset,
    label: PRESETS.get(preset) || `${days} дней`,
    from: iso(from),
    to: iso(to),
  };
}

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.groups)) return payload.groups;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Aggregate responses name metric fields differently across routes
// (`sum`, `amount_sum`, `sum_amount`), so read the value by intent.
function metric(row, fn, field) {
  if (!row || typeof row !== "object") return 0;
  // Portal aggregate answers carry metrics under `aggregates.<field>.<fn>`,
  // both on the root object and on every group.
  const nested = row.aggregates?.[field]?.[fn];
  if (nested !== undefined && nested !== null) return num(nested);
  const keys = [
    `${field}_${fn}`, `${fn}_${field}`, fn,
    fn === "count" ? "count" : null,
    fn === "sum" ? "total" : null,
  ].filter(Boolean);
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return num(row[k]);
  }
  return 0;
}

export function parseCategory(searchParams) {
  const raw = searchParams.get("category") || "0";
  return /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
}

function groupKey(row, groupBy) {
  const value = row?.[groupBy] ?? row?.key ?? row?.group ?? row?.value;
  return value === undefined || value === null || value === "" ? "—" : String(value);
}

function stageLabel(stageId, dictionary, categories) {
  const known = dictionary.get(stageId);
  if (known) {
    const match = /^C(\d+):/.exec(stageId);
    const pipeline = match ? categories?.get(Number(match[1])) : null;
    return pipeline ? `${pipeline} · ${known}` : known;
  }
  if (stageId === "—") return "Без стадии";
  const bare = stageId.includes(":") ? stageId.split(":").slice(1).join(":") : stageId;
  if (bare === "WON") return "Сделка успешна";
  if (bare === "LOSE") return "Сделка провалена";
  return bare.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

function semanticOf(stageId) {
  const bare = String(stageId).includes(":") ? String(stageId).split(":").pop() : String(stageId);
  if (bare === "WON") return "S";
  if (bare === "LOSE") return "F";
  return "P";
}

function windowFilter(field, period) {
  if (!period.from && !period.to) return {};
  const range = {};
  if (period.from) range.$gte = `${period.from}T00:00:00+03:00`;
  if (period.to) range.$lt = `${period.to}T23:59:59+03:00`;
  return { [field]: range };
}

export function createDashboard({ portal, portalDomain, refreshMs = 5 * 60_000 }) {
  const dictionaries = { data: null, at: 0, building: false };
  const snapshots = new Map();
  let queue = Promise.resolve();

  // All portal reads go through one sequential queue: the portal is shared with
  // the user's other Bitrix24 work, and parallel fan-out degrades it.
  function enqueue(task) {
    queue = queue.then(task, task);
    return queue;
  }

  async function loadDictionaries() {
    if (dictionaries.building) return dictionaries.data;
    if (dictionaries.data && Date.now() - dictionaries.at < 60 * 60_000) return dictionaries.data;
    dictionaries.building = true;
    try {
      const stages = new Map();
      const order = new Map();
      const stageCategory = new Map();
      try {
        const statuses = rowsOf(await portal("/statuses", { params: { limit: 500 } }));
        for (const row of statuses) {
          const entityId = String(row.entityId ?? row.ENTITY_ID ?? "");
          if (!entityId.startsWith("DEAL_STAGE")) continue;
          const id = String(row.statusId ?? row.STATUS_ID ?? "");
          if (!id) continue;
          stages.set(id, String(row.name ?? row.NAME ?? id));
          order.set(id, num(row.sort ?? row.SORT));
          const match = /^DEAL_STAGE_(\d+)$/.exec(entityId);
          stageCategory.set(id, match ? Number(match[1]) : 0);
        }
      } catch (err) {
        console.log(`[dict] statuses unavailable: ${err.message}`);
      }

      const categories = new Map();
      try {
        const list = rowsOf(await portal("/deal-categories", { params: { limit: 100 } }));
        for (const row of list) {
          const id = num(row.id ?? row.ID);
          const name = String(row.name ?? row.NAME ?? `Воронка ${id}`);
          categories.set(id, name);
        }
      } catch (err) {
        console.log(`[dict] categories unavailable: ${err.message}`);
      }

      const users = new Map();
      try {
        const list = rowsOf(await portal("/users", { params: { limit: 200 } }));
        for (const row of list) {
          const id = String(row.id ?? row.ID ?? "");
          if (!id) continue;
          const name = [row.name ?? row.NAME, row.lastName ?? row.LAST_NAME].filter(Boolean).join(" ").trim();
          if (name) users.set(id, name);
        }
      } catch (err) {
        console.log(`[dict] users unavailable: ${err.message}`);
      }

      dictionaries.data = { stages, order, users, stageCategory, categories };
      dictionaries.at = Date.now();
    } finally {
      dictionaries.building = false;
    }
    return dictionaries.data;
  }

  async function build(period, categoryId) {
    const dict = await loadDictionaries().catch(() => ({
      stages: new Map(), order: new Map(), users: new Map(),
      stageCategory: new Map(), categories: new Map(),
    }));
    const scope = categoryId > 0 ? { categoryId } : {};
    const created = { ...windowFilter("createdAt", period), ...scope };
    const closed = { ...windowFilter("closedAt", period), ...scope };
    let truncated = false;

    const funnelRaw = await portal("/deals/aggregate", {
      method: "POST",
      body: {
        aggregate: [{ field: "*", function: "count" }, { field: "amount", function: "sum" }],
        groupBy: "stageId",
        filter: created,
      },
    });
    if (funnelRaw?.meta?.truncated) truncated = true;

    const openRaw = await portal("/deals/aggregate", {
      method: "POST",
      body: {
        aggregate: [{ field: "*", function: "count" }, { field: "amount", function: "sum" }],
        filter: { ...created, stageSemanticId: "P" },
      },
    });

    const wonRaw = await portal("/deals/aggregate", {
      method: "POST",
      body: {
        aggregate: [
          { field: "*", function: "count" },
          { field: "amount", function: "sum" },
          { field: "amount", function: "avg" },
        ],
        filter: { ...closed, stageSemanticId: "S" },
      },
    });

    let recent = [];
    try {
      recent = rowsOf(await portal("/deals/search", {
        method: "POST",
        body: {
          select: ["id", "title", "amount", "currencyId", "currency", "stageId", "assignedById", "createdAt"],
          sort: { createdAt: "desc" },
          limit: 15,
        },
      }));
    } catch (err) {
      console.log(`[dashboard] recent deals failed: ${err.message}`);
    }

    const stages = rowsOf(funnelRaw).map((row) => {
      const stageId = groupKey(row, "stageId");
      return {
        stageId,
        name: stageLabel(stageId, dict.stages, dict.categories),
        categoryId: dict.stageCategory.get(stageId) ?? 0,
        semantic: semanticOf(stageId),
        count: metric(row, "count", "*"),
        amount: metric(row, "sum", "amount"),
      };
    }).sort((a, b) => {
      const oa = dict.order.has(a.stageId) ? dict.order.get(a.stageId) : 10_000;
      const ob = dict.order.has(b.stageId) ? dict.order.get(b.stageId) : 10_000;
      return oa - ob || a.name.localeCompare(b.name, "ru");
    });

    const dealsCount = stages.reduce((sum, s) => sum + s.count, 0);
    const currencies = new Map();
    const recentList = recent.slice(0, 15).map((row) => {
      const currency = String(row.currencyId ?? row.currency ?? row.CURRENCY_ID ?? "");
      if (currency) currencies.set(currency, (currencies.get(currency) || 0) + 1);
      const stageId = String(row.stageId ?? row.STAGE_ID ?? "");
      const assignedId = String(row.assignedById ?? row.ASSIGNED_BY_ID ?? "");
      return {
        id: num(row.id ?? row.ID),
        title: String(row.title ?? row.TITLE ?? "Без названия"),
        amount: num(row.amount ?? row.OPPORTUNITY ?? row.opportunity),
        currency,
        stageId,
        stageName: stageLabel(stageId, dict.stages, dict.categories),
        assignedId,
        assignedName: dict.users.get(assignedId) || (assignedId ? `Сотрудник #${assignedId}` : "—"),
        createdAt: String(row.createdAt ?? row.CREATED_AT ?? row.DATE_CREATE ?? ""),
      };
    });

    const currency = [...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "RUB";

    return {
      portalDomain: portalDomain || null,
      period,
      categoryId,
      categories: [...dict.categories.entries()].map(([id, name]) => ({ id, name })),
      currency,
      summary: {
        dealsCount,
        openAmount: metric(openRaw, "sum", "amount"),
        openCount: metric(openRaw, "count", "*"),
        wonCount: metric(wonRaw, "count", "*"),
        wonAmount: metric(wonRaw, "sum", "amount"),
        avgCheck: metric(wonRaw, "avg", "amount"),
      },
      stages,
      recent: recentList,
      truncated,
    };
  }

  const entryKey = (period, categoryId) => `${period.key}|cat:${categoryId}`;

  function entryFor(period, categoryId) {
    const key = entryKey(period, categoryId);
    let entry = snapshots.get(key);
    if (!entry) {
      entry = { data: null, at: 0, error: null, building: false, period, categoryId };
      snapshots.set(key, entry);
      if (snapshots.size > 8) {
        const oldest = [...snapshots.entries()]
          .filter(([, v]) => v.at > 0)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest && oldest[0] !== key) snapshots.delete(oldest[0]);
      }
    }
    entry.period = period;
    entry.categoryId = categoryId;
    return entry;
  }

  function refresh(period, categoryId = 0) {
    const entry = entryFor(period, categoryId);
    if (entry.building) return entry;
    entry.building = true;
    enqueue(async () => {
      try {
        entry.data = await build(period, categoryId);
        entry.at = Date.now();
        entry.error = null;
        console.log(`[dashboard] snapshot ${entryKey(period, categoryId)} ready: ${entry.data.recent.length} recent, ${entry.data.stages.length} stages`);
      } catch (err) {
        entry.error = {
          kind: err instanceof PortalError ? err.kind : "portal_error",
          message: err?.message || "unknown",
          code: err?.code ?? null,
          scope: err?.scope ?? null,
          userMessage: err?.userMessage ?? null,
          switchUrl: err?.switchUrl ?? null,
        };
        console.log(`[dashboard] snapshot ${entryKey(period, categoryId)} failed: ${entry.error.kind}${entry.error.code ? ` (${entry.error.code})` : ""} — ${entry.error.message}`);
      } finally {
        entry.building = false;
      }
    });
    return entry;
  }

  function get(period, categoryId, { force = false } = {}) {
    const existing = snapshots.get(entryKey(period, categoryId));
    // A visitor may ask for a fresh rebuild, but never more often than the portal
    // can absorb: the queue is shared with the user's other Bitrix24 work.
    if (force && existing && existing.at && Date.now() - existing.at < 30_000) return existing;
    if (!force && existing && existing.data && Date.now() - existing.at < refreshMs) return existing;
    return refresh(period, categoryId);
  }

  function start() {
    refresh(parsePeriod(new URLSearchParams("period=30d")), 0);
    refresh(parsePeriod(new URLSearchParams("period=all")), 0);
    setInterval(() => {
      for (const entry of snapshots.values()) {
        if (entry.period) refresh(entry.period, entry.categoryId || 0);
      }
    }, refreshMs).unref();
  }

  return { get, start };
}
