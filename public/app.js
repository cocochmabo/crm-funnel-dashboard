const state = {
  preset: "30d",
  category: "0",
  from: "",
  to: "",
  timer: null,
  loading: false,
};

const $ = (id) => document.getElementById(id);

const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });

const SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", KZT: "₸", BYN: "Br", UAH: "₴", GBP: "£" };

let portalDomain = "";

function currencyLabel(code) {
  return SYMBOLS[code] || code || "";
}

function fmtMoney(value, code) {
  const n = Number(value) || 0;
  const body = Math.abs(n) >= 1_000_000 ? compact.format(n) : money.format(n);
  const symbol = currencyLabel(code);
  return symbol ? `${body} ${symbol}` : body;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "2-digit" });
}

function fmtStamp(iso) {
  if (!iso) return "ещё не обновлялось";
  const d = new Date(iso);
  return `обновлено ${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showNotice(message) {
  const box = $("notice");
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.textContent = message;
  box.hidden = false;
}

function showError(message) {
  const box = $("errorBox");
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.textContent = message;
  box.hidden = false;
}

// The frame's height is set by Bitrix24, so report ours when auto-height is on.
function reportHeight() {
  if (window.parent === window) return;
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  window.parent.postMessage({ type: "vibe:resize", height }, "*");
}

function watchHeight() {
  if (typeof ResizeObserver !== "function") return;
  const observer = new ResizeObserver(() => reportHeight());
  observer.observe(document.body);
  window.addEventListener("load", reportHeight);
}

function query() {
  const params = new URLSearchParams({ period: state.preset, category: state.category });
  if (state.preset === "custom") {
    if (state.from) params.set("from", state.from);
    if (state.to) params.set("to", state.to);
  }
  return params.toString();
}

function setLoading(isLoading) {
  state.loading = isLoading;
  $("refreshBtn").disabled = isLoading;
}

function dealHref(id) {
  if (!portalDomain || !id) return "";
  return `https://${portalDomain}/crm/deal/details/${id}/`;
}

function openDeal(id) {
  const href = dealHref(id);
  if (!href) return;
  try {
    (window.top || window).location.href = href;
  } catch {
    window.location.href = href;
  }
}

function renderKpis(payload) {
  const { summary, currency } = payload;
  $("openAmount").textContent = fmtMoney(summary.openAmount, currency);
  $("openCount").textContent = `${money.format(summary.openCount || 0)} открытых сделок`;
  $("wonCount").textContent = money.format(summary.wonCount || 0);
  $("wonAmount").textContent = `на ${fmtMoney(summary.wonAmount, currency)}`;
  $("avgCheck").textContent = fmtMoney(summary.avgCheck, currency);
  $("dealsCount").textContent = money.format(summary.dealsCount || 0);
}

function renderFunnel(payload) {
  const { stages, currency } = payload;
  const chart = $("funnelChart");
  const tbody = document.querySelector("#stageTable tbody");
  chart.textContent = "";
  tbody.textContent = "";

  if (!stages.length) {
    chart.append(el("p", "empty", "За выбранный период сделок нет."));
    return;
  }

  const MAX_BARS = 14;
  const shown = stages.slice(0, MAX_BARS);
  const maxCount = Math.max(...shown.map((s) => s.count), 1);
  shown.forEach((stage, index) => {
    const row = el("div", "bar");
    row.dataset.semantic = stage.semantic;
    row.append(el("span", "bar__name", stage.name));

    const track = el("div", "bar__track");
    const fill = el("div", "bar__fill");
    const share = Math.max(stage.count / maxCount, stage.count ? 0.03 : 0);
    fill.style.width = `${(share * 100).toFixed(2)}%`;
    fill.style.animationDelay = `${Math.min(index * 40, 360)}ms`;
    track.append(fill);
    row.append(track);

    const value = el("span", "bar__value");
    value.append(el("b", "", money.format(stage.count)));
    value.append(document.createTextNode(` · ${fmtMoney(stage.amount, currency)}`));
    row.append(value);
    chart.append(row);

    const tr = el("tr");
    tr.append(el("td", "", stage.name));
    tr.append(el("td", "num", money.format(stage.count)));
    tr.append(el("td", "num", fmtMoney(stage.amount, currency)));
    tbody.append(tr);
  });

  if (stages.length > MAX_BARS) {
    chart.append(el("p", "funnel__more", `На графике первые ${MAX_BARS} стадий, полный список — в таблице ниже.`));
  }
  for (const stage of stages.slice(MAX_BARS)) {
    const tr = el("tr");
    tr.append(el("td", "", stage.name));
    tr.append(el("td", "num", money.format(stage.count)));
    tr.append(el("td", "num", fmtMoney(stage.amount, currency)));
    tbody.append(tr);
  }
}

function renderRecent(payload) {
  const tbody = document.querySelector("#recentTable tbody");
  tbody.textContent = "";
  if (!payload.recent.length) {
    const tr = el("tr");
    const td = el("td", "empty", "Сделок пока нет.");
    td.colSpan = 5;
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const deal of payload.recent) {
    const tr = el("tr");

    const titleCell = el("td");
    const href = dealHref(deal.id);
    if (href) {
      const link = el("a", "deal-link deal-title", deal.title);
      link.href = href;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        openDeal(deal.id);
      });
      titleCell.append(link);
    } else {
      titleCell.append(el("span", "deal-title", deal.title));
    }
    tr.append(titleCell);

    const stageCell = el("td");
    const pill = el("span", "pill", deal.stageName);
    pill.dataset.semantic = deal.stageId.split(":").pop() === "WON"
      ? "S"
      : deal.stageId.split(":").pop() === "LOSE" ? "F" : "P";
    stageCell.append(pill);
    tr.append(stageCell);

    tr.append(el("td", "muted", deal.assignedName));
    tr.append(el("td", "num", fmtMoney(deal.amount, deal.currency || payload.currency)));
    tr.append(el("td", "num muted", fmtDate(deal.createdAt)));
    tbody.append(tr);
  }
}

function fillState(payload) {
  const { period, meta } = payload;
  portalDomain = payload.portalDomain || "";

  renderCategories(payload.categories || []);

  renderKpis(payload);
  renderFunnel(payload);
  renderRecent(payload);

  $("periodNote").textContent = period.preset === "all"
    ? "Все сделки портала без ограничения по дате"
    : `${period.label} · сделки, созданные за период`;
  $("updatedAt").textContent = fmtStamp(meta?.updatedAt);
  $("portalLine").textContent = portalDomain
    ? `Аналитика портала ${portalDomain}`
    : "Аналитика портала Битрикс24";

  const notes = [];
  if (meta?.warning) notes.push(`${meta.warning} Показаны данные от ${fmtStamp(meta.updatedAt).replace("обновлено ", "")}.`);
  if (payload.truncated) notes.push("Данных слишком много для точного подсчёта: сузьте период, чтобы цифры были полными.");
  showNotice(notes.join(" "));
  reportHeight();
}

function renderCategories(categories) {
  const select = $("categorySelect");
  const current = state.category;
  select.textContent = "";
  const all = el("option", "", "Все воронки");
  all.value = "0";
  select.append(all);
  for (const category of categories) {
    const option = el("option", "", category.name);
    option.value = String(category.id);
    select.append(option);
  }
  select.value = [...select.options].some((o) => o.value === current) ? current : "0";
  state.category = select.value;
}

function showSkeleton() {
  for (const id of ["openAmount", "wonCount", "avgCheck", "dealsCount"]) $(id).textContent = "—";
  $("openCount").textContent = "собираем данные";
  $("wonAmount").textContent = "—";
  $("updatedAt").textContent = "обновление…";
}

async function load({ fresh = false } = {}) {
  if (state.loading) return;
  clearTimeout(state.timer);
  setLoading(true);
  showError("");
  if (fresh) $("updatedAt").textContent = "обновление…";

  try {
    const res = await fetch(`/api/dashboard?${query()}${fresh ? "&fresh=1" : ""}`, { cache: "no-store" });
    const json = await res.json().catch(() => null);

    if (res.status === 202) {
      showSkeleton();
      showNotice(json?.error || "Собираем данные портала…");
      state.timer = setTimeout(() => {
        state.loading = false;
        load();
      }, 5000);
      return;
    }
    if (!res.ok || !json) {
      showError(json?.error || `Не удалось получить данные (${res.status}).`);
      return;
    }
    fillState(json);
  } catch {
    showError("Не удалось связаться с сервером приложения. Проверьте соединение и повторите.");
  } finally {
    setLoading(false);
    reportHeight();
  }
}

function markPreset(preset) {
  for (const button of document.querySelectorAll("[data-preset]")) {
    button.classList.toggle("is-active", button.dataset.preset === preset);
  }
  $("customForm").hidden = preset !== "custom";
}

for (const button of document.querySelectorAll("[data-preset]")) {
  button.addEventListener("click", () => {
    state.preset = button.dataset.preset;
    markPreset(state.preset);
    if (state.preset === "custom") {
      if (!$("fromDate").value) {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        $("fromDate").value = d.toISOString().slice(0, 10);
      }
      if (!$("toDate").value) $("toDate").value = new Date().toISOString().slice(0, 10);
      return;
    }
    state.from = "";
    state.to = "";
    load();
  });
}

$("customForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const from = $("fromDate").value;
  const to = $("toDate").value;
  if (!from || !to) return;
  state.preset = "custom";
  state.from = from;
  state.to = to;
  load();
});

$("refreshBtn").addEventListener("click", () => load({ fresh: true }));

$("categorySelect").addEventListener("change", (event) => {
  state.category = event.target.value;
  load();
});

markPreset(state.preset);
watchHeight();
load();
