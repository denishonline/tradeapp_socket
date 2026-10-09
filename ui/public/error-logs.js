"use strict";

const state = { entries: [], loading: false, timer: null };
const elements = {
  summary: document.querySelector("#summary"),
  status: document.querySelector("#status"),
  list: document.querySelector("#log-list"),
  template: document.querySelector("#log-row-template"),
  refresh: document.querySelector("#refresh"),
  autoRefresh: document.querySelector("#auto-refresh"),
  level: document.querySelector("#level-filter"),
  component: document.querySelector("#component-filter"),
  search: document.querySelector("#search-filter"),
  limit: document.querySelector("#limit-filter"),
};

function displayTime(entry) {
  if (entry.timestampIst) return entry.timestampIst.replace("T", " ");
  if (!entry.timestamp) return "Unknown time";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(entry.timestamp));
}

function filteredEntries() {
  const level = elements.level.value;
  const component = elements.component.value;
  const query = elements.search.value.trim().toLowerCase();
  return state.entries.filter((entry) => {
    if (level && entry.level !== level) return false;
    if (component && entry.component !== component) return false;
    if (!query) return true;
    return JSON.stringify(entry).toLowerCase().includes(query);
  });
}

function render() {
  const entries = filteredEntries();
  elements.list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.entries.length ? "No logs match these filters." : "No log entries have been recorded yet.";
    elements.list.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const row = elements.template.content.firstElementChild.cloneNode(true);
    const level = entry.level || "error";
    row.dataset.level = level;
    row.querySelector(".log-time").textContent = displayTime(entry);
    row.querySelector(".log-level").textContent = level;
    row.querySelector(".log-component").textContent = entry.component || "server";
    row.querySelector(".log-event").textContent = entry.event || "error";
    row.querySelector(".log-message").textContent = entry.message || "No message";
    row.querySelector("pre").textContent = JSON.stringify(entry, null, 2);
    fragment.append(row);
  }
  elements.list.append(fragment);
}

function updateComponents() {
  const selected = elements.component.value;
  const components = [...new Set(state.entries.map((entry) => entry.component).filter(Boolean))].sort();
  elements.component.replaceChildren(new Option("All components", ""));
  for (const component of components) elements.component.add(new Option(component, component));
  if (components.includes(selected)) elements.component.value = selected;
}

async function loadLogs() {
  if (state.loading) return;
  state.loading = true;
  elements.refresh.disabled = true;
  elements.status.className = "status";
  elements.status.textContent = "Refreshing…";
  try {
    const response = await fetch(`/api/error-logs?limit=${encodeURIComponent(elements.limit.value)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const payload = await response.json();
    state.entries = Array.isArray(payload.entries) ? payload.entries : [];
    updateComponents();
    render();
    const refreshed = new Intl.DateTimeFormat("en-IN", { timeStyle: "medium" }).format(new Date());
    elements.summary.textContent = `${state.entries.length.toLocaleString("en-IN")} entries · newest first`;
    elements.status.textContent = `Last refreshed ${refreshed}`;
  } catch (error) {
    elements.status.className = "status error";
    elements.status.textContent = `Could not load logs: ${error.message}`;
  } finally {
    state.loading = false;
    elements.refresh.disabled = false;
  }
}

function scheduleRefresh() {
  clearInterval(state.timer);
  if (elements.autoRefresh.checked) state.timer = setInterval(loadLogs, 5000);
}

elements.refresh.addEventListener("click", loadLogs);
elements.autoRefresh.addEventListener("change", scheduleRefresh);
elements.limit.addEventListener("change", loadLogs);
elements.level.addEventListener("change", render);
elements.component.addEventListener("change", render);
elements.search.addEventListener("input", render);

scheduleRefresh();
loadLogs();
