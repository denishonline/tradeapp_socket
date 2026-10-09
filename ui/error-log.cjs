"use strict";

const fs = require("fs");
const path = require("path");
const util = require("util");

const LOG_ROOT = path.resolve(__dirname, "..", "db", "logs");
const DATA_ROOT = path.resolve(__dirname, "..", "db");
const TIME_ZONE = "Asia/Kolkata";
const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 16_000;
const MAX_LOG_QUERY = 2_000;
const MAX_FILE_READ_BYTES = 4 * 1024 * 1024;
const SECRET_KEY = /(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|cookie)/i;

let installed = false;
let writingFallback = false;
let chain = Promise.resolve();
let feedState = "stopped";
let lastFeedDataAt = 0;
let gapReported = false;
let gapTimer = null;
let dataWatcher = null;
let routesAttached = false;
const channelLastAt = new Map();
const channelGapReported = new Set();
const originalConsoleError = console.error.bind(console);
const FEED_GAP_MS = Math.max(15_000, Number(process.env.FEED_GAP_LOG_MS) || 45_000);

function dateInIndia(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function sanitizeString(value) {
  const sanitized = value
    .replace(/(bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password)=)[^&\s]+/gi, `$1${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED);
  return sanitized.length > MAX_STRING_LENGTH
    ? `${sanitized.slice(0, MAX_STRING_LENGTH)}...[truncated]`
    : sanitized;
}

function clean(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) return value.map((item) => clean(item, seen));
  if (typeof value === "string") return sanitizeString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? REDACTED : clean(item, seen);
  }
  return output;
}

function normalizeError(error) {
  if (error instanceof Error) return clean(error);
  if (typeof error === "string") return { message: error };
  return clean(error);
}

function makeEntry({ level = "error", component = "server", event = "error", message, error, context }) {
  const now = new Date();
  const normalized = normalizeError(error);
  return {
    timestamp: now.toISOString(),
    timestampIst: now.toLocaleString("sv-SE", { timeZone: TIME_ZONE }).replace(" ", "T") + "+05:30",
    level,
    component,
    event,
    message: sanitizeString(message || normalized?.message || String(error || event)),
    error: normalized,
    context: clean(context),
    pid: process.pid,
  };
}

function fileFor(date = new Date()) {
  return path.join(LOG_ROOT, `server-errors-${dateInIndia(date)}.jsonl`);
}

async function readFileNewestFirst(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, MAX_FILE_READ_BYTES);
    if (!length) return [];
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } finally {
    await handle.close();
  }
}

async function latestEntries(limit = 500) {
  const safeLimit = Math.max(1, Math.min(MAX_LOG_QUERY, Number(limit) || 500));
  let names = [];
  try {
    names = (await fs.promises.readdir(LOG_ROOT, { withFileTypes: true }))
      .filter((item) => item.isFile() && /^server-errors-\d{4}-\d{2}-\d{2}\.jsonl$/.test(item.name))
      .map((item) => item.name)
      .sort()
      .reverse();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const entries = [];
  for (const name of names) {
    const rows = await readFileNewestFirst(path.join(LOG_ROOT, name));
    entries.push(...rows.slice(0, safeLimit - entries.length));
    if (entries.length >= safeLimit) break;
  }
  return { entries, files: names, limit: safeLimit };
}

function attachRoutes(app) {
  if (routesAttached || !app?.get) return;
  routesAttached = true;
  app.get("/api/error-logs", async (request, response) => {
    try {
      const result = await latestEntries(request.query.limit);
      response.json({
        generatedAt: new Date().toISOString(),
        newestFirst: true,
        ...result,
      });
    } catch (error) {
      record({ component: "error-logger", event: "log_read_failed", error });
      response.status(500).json({ error: "Unable to read the server error log" });
    }
  });
}

function fallback(error) {
  if (writingFallback) return;
  writingFallback = true;
  try {
    originalConsoleError("Persistent error logging failed:", error?.message || error);
  } finally {
    writingFallback = false;
  }
}

function record(details) {
  const entry = makeEntry(details || {});
  const line = `${JSON.stringify(entry)}\n`;
  chain = chain
    .then(() => fs.promises.mkdir(LOG_ROOT, { recursive: true }))
    .then(() => fs.promises.appendFile(fileFor(new Date(entry.timestamp)), line, "utf8"))
    .catch(fallback);
  return entry;
}

function recordSync(details) {
  const entry = makeEntry(details || {});
  try {
    fs.mkdirSync(LOG_ROOT, { recursive: true });
    fs.appendFileSync(fileFor(new Date(entry.timestamp)), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    fallback(error);
  }
  return entry;
}

function argumentsToMessage(args) {
  return util.format(...args);
}

function componentForMessage(message) {
  if (/market depth|depth history/i.test(message)) return "depth-recorder";
  if (/market history|price history/i.test(message)) return "history-recorder";
  if (/candle/i.test(message)) return "candle-recorder";
  if (/strategy|radar|signal/i.test(message)) return "strategy-radar";
  if (/socket|market feed|fyers/i.test(message)) return "market-feed";
  if (/database|\bdb\b/i.test(message)) return "database";
  return "server";
}

function markFeedStatus(state, context) {
  feedState = state || feedState;
  if (state === "live") {
    lastFeedDataAt = Date.now();
    gapReported = false;
    channelLastAt.clear();
    channelGapReported.clear();
  }
  if (state === "error" || state === "reconnecting") {
    record({
      level: state === "error" ? "error" : "warning",
      component: "market-feed",
      event: `feed_${state}`,
      message: context?.message || `Market feed is ${state}`,
      context,
    });
  }
}

function markFeedData(channel, context) {
  const now = Date.now();
  if (gapReported) {
    record({
      level: "info",
      component: "market-feed",
      event: "feed_gap_recovered",
      message: "Market data resumed after a silent feed gap",
      context: { channel, gapMs: lastFeedDataAt ? now - lastFeedDataAt : null, ...context },
    });
  }
  lastFeedDataAt = now;
  gapReported = false;
  if (channelGapReported.has(channel)) {
    record({
      level: "info",
      component: "market-feed",
      event: `${channel.replace(/-/g, "_")}_gap_recovered`,
      message: `${channel} capture resumed`,
      context: { channel, gapMs: channelLastAt.has(channel) ? now - channelLastAt.get(channel) : null },
    });
    channelGapReported.delete(channel);
  }
  channelLastAt.set(channel, now);
}

function checkFeedGap() {
  if (feedState !== "live" || !isMarketHours() || !lastFeedDataAt || gapReported) return;
  const gapMs = Date.now() - lastFeedDataAt;
  if (gapMs < FEED_GAP_MS) return;
  gapReported = true;
  record({
    level: "warning",
    component: "market-feed",
    event: "feed_data_gap",
    message: `No market data received for ${Math.round(gapMs / 1000)} seconds`,
    context: { gapMs, thresholdMs: FEED_GAP_MS },
  });

}

function checkChannelGaps() {
  if (feedState !== "live" || !isMarketHours()) return;
  const now = Date.now();
  const thresholds = {
    "price-history": FEED_GAP_MS,
    "market-depth": FEED_GAP_MS,
    candles: Math.max(120_000, FEED_GAP_MS),
  };
  for (const [channel, lastAt] of channelLastAt) {
    const thresholdMs = thresholds[channel] || FEED_GAP_MS;
    const gapMs = now - lastAt;
    if (gapMs < thresholdMs || channelGapReported.has(channel)) continue;
    channelGapReported.add(channel);
    record({
      level: "warning",
      component: "market-feed",
      event: `${channel.replace(/-/g, "_")}_gap`,
      message: `${channel} capture has stopped for ${Math.round(gapMs / 1000)} seconds`,
      context: { channel, gapMs, thresholdMs },
    });
  }
}

function isMarketHours(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  if (["Sat", "Sun"].includes(get("weekday"))) return false;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

function watchCapturedData() {
  try {
    dataWatcher = fs.watch(DATA_ROOT, { recursive: true }, (_event, filename) => {
      const relative = String(filename || "").replace(/\\/g, "/").toLowerCase();
      if (relative.startsWith("market-history/")) markFeedData("price-history");
      else if (relative.startsWith("cash-depth/")) markFeedData("market-depth");
      else if (relative.startsWith("candles/")) markFeedData("candles");
    });
    dataWatcher.unref?.();
  } catch (error) {
    record({
      level: "warning",
      component: "error-logger",
      event: "data_watch_failed",
      message: "Could not watch captured data files for silent gaps",
      error,
    });
  }
}

function install() {
  if (installed) return module.exports;
  installed = true;

  console.error = (...args) => {
    originalConsoleError(...args);
    const message = argumentsToMessage(args);
    record({
      component: componentForMessage(message),
      event: "console_error",
      message,
      error: args.find((item) => item instanceof Error),
    });
  };

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    recordSync({
      component: "process",
      event: "uncaught_exception",
      message: error?.message,
      error,
      context: { origin },
    });
  });

  process.on("warning", (warning) => {
    record({
      level: "warning",
      component: "process",
      event: "process_warning",
      message: warning?.message,
      error: warning,
    });
  });

  gapTimer = setInterval(() => {
    checkFeedGap();
    checkChannelGaps();
  }, Math.min(10_000, Math.max(5_000, Math.floor(FEED_GAP_MS / 3))));
  gapTimer.unref?.();
  watchCapturedData();

  record({ level: "info", component: "server", event: "logger_started", message: "Persistent error logger started" });
  return module.exports;
}

module.exports = {
  install,
  record,
  recordSync,
  fileFor,
  logRoot: LOG_ROOT,
  markFeedStatus,
  markFeedData,
  attachRoutes,
  latestEntries,
};
