/**
 * cbc-sense — live temperature/humidity dashboard for the CBC demo device
 *
 * A tissue Sense device (Wemos D1 Mini + DHT22, ../firmware) publishes
 * temperature + humidity over MQTTS every 2 seconds. synapse dispatches each
 * reading into sensor(event, env) here; the dashboard polls /api/series at the
 * same 2s cadence and renders two live charts.
 *
 * NOTE: the 2-second cadence is show-floor flair on a specially provisioned
 * demo account. Running this on your own account? Report once a minute from
 * the device (firmware config.h) — everything here works unchanged, the
 * charts just update less often.
 *
 * Routes:
 *   GET /                        — live dashboard (two chart panels + stat tiles)
 *   GET /api/series?window=<sec>&device=<id>
 *                                — JSON time series for temperature + humidity
 *
 * Pulse (every minute): offline dead-man's switch — alerts when the sensor has
 * been silent for OFFLINE_AFTER_S. The minute-0 run also prunes readings older
 * than 24h (2s cadence ⇒ ~86k rows/day).
 *
 * ── Telegram alerts (optional — enabled by providing credentials) ────────────
 * When the TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID vault bindings are set, the
 * cell pushes alerts straight to your phone (Telegram app = free mobile push):
 *   - sensor offline / back online (pulse-driven, OFFLINE_AFTER_S of silence)
 *   - threshold crossed / recovered (checked inline on every reading against
 *     ALERT_TEMP_MIN_C / ALERT_TEMP_MAX_C / ALERT_HUM_MIN / ALERT_HUM_MAX,
 *     with hysteresis so a value hovering at the limit doesn't flap)
 * Alerts fire on STATE CHANGE only (ok→alarm, alarm→ok), never per reading —
 * state lives in the alert_state table because cells are stateless.
 *
 * How to configure Telegram so alerts reach your mobile device:
 *   1. Install Telegram on the phone, talk to @BotFather → /newbot → copy the
 *      HTTP token ("1234567890:AA...").
 *   2. Get your numeric chat id from @userinfobot (for a group: add the bot,
 *      send a message, read chat.id from /getUpdates).
 *   3. Message your bot once (bots can't start a conversation).
 *   4. BEFORE deploying:  ribo vault set cbc-sense TELEGRAM_BOT_TOKEN
 *                         ribo vault set cbc-sense TELEGRAM_CHAT_ID
 *      (deploying with the vault unset stores a "***REMOVED***" placeholder —
 *       detected below, alerting silently disabled, dashboard unaffected)
 *   5. ribo deploy — thresholds are ribo.toml text bindings, edit + redeploy.
 *
 * Deploy (under the demo account):
 *   ribo db create cbc-sense
 *   ribo vault set cbc-sense TELEGRAM_BOT_TOKEN    # optional, for alerts
 *   ribo vault set cbc-sense TELEGRAM_CHAT_ID      # optional, for alerts
 *   ribo deploy
 */

const SCHEMA_READINGS = `
  CREATE TABLE IF NOT EXISTS readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device      TEXT NOT NULL,
    metric      TEXT NOT NULL,
    value       REAL,
    unit        TEXT,
    recorded_at TEXT NOT NULL
  )
`;
const SCHEMA_READINGS_IDX = `
  CREATE INDEX IF NOT EXISTS idx_readings_dev_metric_t
    ON readings(device, metric, recorded_at)
`;

// Per-check alert state ('offline', 'temperature', 'humidity') — cells are
// stateless between requests, so ok/alarm lives here and alerts fire only on
// transitions.
const SCHEMA_ALERT_STATE = `
  CREATE TABLE IF NOT EXISTS alert_state (
    key   TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    since TEXT NOT NULL
  )
`;

async function ensureSchema(DB) {
  await DB.exec(SCHEMA_READINGS);
  await DB.exec(SCHEMA_READINGS_IDX);
  await DB.exec(SCHEMA_ALERT_STATE);
}

/**
 * parseReading — { device, metric, value, unit, recorded_at } from a synapse
 * sensor event. The firmware publishes to tissue/<acct>/<dev>/env/<metric>;
 * the metric is the LAST topic segment ("temperature", "humidity").
 * Payload is JSON { value, unit } (see firmware publishMetric) or a bare number.
 */
function parseReading(event) {
  const segs = event.topic.split("/");
  const metric = segs[segs.length - 1] || "value";
  let value = null, unit = null, ts = null;
  try {
    const b = event.json();
    value = Number(b.value);
    unit  = b.unit ?? null;
    ts    = b.ts   ?? null;
  } catch {
    const n = Number(event.text());
    value = Number.isNaN(n) ? null : n;
  }
  let recorded_at;
  if (ts) recorded_at = ts;
  else if (event.receivedTime instanceof Date) recorded_at = event.receivedTime.toISOString();
  else recorded_at = new Date().toISOString();
  return { device: event.device, metric, value: Number.isNaN(value) ? null : value, unit, recorded_at };
}

// ─── Alerting (Telegram) ──────────────────────────────────────────────────────

// ribo stores unset vault bindings as this literal — treat it as "not configured".
const PLACEHOLDER = "***REMOVED***";

// Re-arm margin per metric: after an alarm, the value must come back INSIDE the
// range by this much before we call it recovered (stops flapping at the limit).
const HYSTERESIS = { temperature: 0.3, humidity: 1.0 };

function telegramConfigured(env) {
  const t = env.TELEGRAM_BOT_TOKEN, c = env.TELEGRAM_CHAT_ID;
  return !!(t && c && t !== PLACEHOLDER && c !== PLACEHOLDER);
}

async function sendTelegram(env, text) {
  if (!telegramConfigured(env)) {
    console.warn(`alert suppressed (Telegram vault not configured): ${text}`);
    return;
  }
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      });
    if (!resp.ok) {
      console.error(`Telegram sendMessage failed: HTTP ${resp.status} ${await resp.text()}`);
    }
  } catch (e) {
    console.error(`Telegram sendMessage failed: ${e}`);
  }
}

function numBinding(env, name) {
  const v = (env[name] ?? "").toString().trim();
  if (v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Flip alert_state[key] to `state`; returns true when this is a transition. */
async function transition(DB, key, state, now) {
  const row = await DB.prepare("SELECT state FROM alert_state WHERE key = ?")
    .bind(key).first();
  if ((row?.state ?? "ok") === state) return false;
  await DB.prepare(
    "INSERT INTO alert_state (key, state, since) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET state = excluded.state, since = excluded.since"
  ).bind(key, state, now).run();
  // A fresh row starting in 'ok' isn't news — only alert on real changes.
  return !(row == null && state === "ok");
}

/**
 * checkThreshold — inline on every reading (the urgent path lives on ingest,
 * not on pulse). No-op unless a min/max is configured for the metric.
 */
async function checkThreshold(env, metric, value, unit, device) {
  const min = numBinding(env, metric === "temperature" ? "ALERT_TEMP_MIN_C" : "ALERT_HUM_MIN");
  const max = numBinding(env, metric === "temperature" ? "ALERT_TEMP_MAX_C" : "ALERT_HUM_MAX");
  if (min == null && max == null) return;

  const h = HYSTERESIS[metric] ?? 0;
  const out = (max != null && value > max) || (min != null && value < min);
  const backIn = (max == null || value <= max - h) && (min == null || value >= min + h);
  const now = new Date().toISOString();

  if (out) {
    if (await transition(env.DB, metric, "alarm", now)) {
      const bound = max != null && value > max ? `above max ${max}` : `below min ${min}`;
      await sendTelegram(env,
        `🔴 cbc-sense: ${metric} ${value.toFixed(1)} ${unit ?? ""} ${bound} ` +
        `(device ${device})\n${env.DASHBOARD_URL ?? ""}`);
    }
  } else if (backIn) {
    if (await transition(env.DB, metric, "ok", now)) {
      await sendTelegram(env,
        `✅ cbc-sense: ${metric} back in range: ${value.toFixed(1)} ${unit ?? ""}`);
    }
  }
  // between the limit and the hysteresis margin: keep the current state
}

/**
 * checkOffline — the dead-man's switch, called from pulse() every minute.
 * Silence is the one alarm no incoming event can raise, so a scheduled job has
 * to notice the absence of data. Never alarms before the first-ever reading.
 */
async function checkOffline(env) {
  const offlineAfterS = numBinding(env, "OFFLINE_AFTER_S") ?? 90;
  const last = await env.DB.prepare(
    "SELECT device, recorded_at FROM readings ORDER BY id DESC LIMIT 1"
  ).first();
  if (!last) return;

  const ageS = (Date.now() - new Date(last.recorded_at).getTime()) / 1000;
  const now = new Date().toISOString();
  if (ageS > offlineAfterS) {
    if (await transition(env.DB, "offline", "alarm", now)) {
      await sendTelegram(env,
        `🔴 cbc-sense: sensor ${last.device} OFFLINE — no data for ${Math.round(ageS)} s\n` +
        `${env.DASHBOARD_URL ?? ""}`);
    }
  } else {
    if (await transition(env.DB, "offline", "ok", now)) {
      await sendTelegram(env, `✅ cbc-sense: sensor ${last.device} back online`);
    }
  }
}

// ─── Dashboard page ───────────────────────────────────────────────────────────
// One HTML page, no build step, no external assets. The client script avoids
// backticks/${} so it can live inside this template literal untouched.

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tissue Sense — live</title>
<style>
  :root{
    --bg:#f6faf8; --card:#ffffff; --ink:#15251d; --muted:#66796f;
    --line:#dcebe2; --grid:rgba(21,37,29,.08);
    --temp:#00875e; --hum:#0b76b8;
    --ok:#00875e; --stale:#b45309;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#0d1512; --card:#131f19; --ink:#e7f2ec; --muted:#8ba295;
      --line:#22332b; --grid:rgba(231,242,236,.09);
      --temp:#00a476; --hum:#2e96cd;
      --ok:#00a476; --stale:#d97706;
    }
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);padding:1.4rem 1rem 3rem;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:1rem}
  header{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap}
  header svg{width:38px;height:38px;flex:none}
  header h1{font-size:1.15rem;font-weight:650;letter-spacing:-.01em}
  header .sub{font-size:.8rem;color:var(--muted)}
  .chip{font-family:ui-monospace,Menlo,monospace;font-size:.75rem;color:var(--muted);
        border:1px solid var(--line);border-radius:999px;padding:.15em .7em}
  .dot{display:inline-block;width:.55em;height:.55em;border-radius:50%;background:var(--ok);
       margin-right:.4em;vertical-align:.02em}
  .dot.stale{background:var(--stale)}
  @media (prefers-reduced-motion: no-preference){
    .dot.live{animation:pulse 2s ease-in-out infinite}
    @keyframes pulse{50%{opacity:.35}}
  }
  .status{margin-left:auto;font-size:.8rem;color:var(--muted)}

  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem}
  .tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem 1.1rem}
  .tile .lbl{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .tile .lbl i{display:inline-block;width:.6em;height:.6em;border-radius:2px;margin-right:.45em;font-style:normal}
  .tile .val{font-size:2rem;font-weight:650;font-variant-numeric:tabular-nums;margin-top:.15rem}
  .tile .val small{font-size:.9rem;font-weight:500;color:var(--muted);margin-left:.15em}
  .tile .rng{font-size:.75rem;color:var(--muted);font-variant-numeric:tabular-nums;margin-top:.2rem}

  .filters{display:flex;gap:.4rem;align-items:center}
  .filters span{font-size:.78rem;color:var(--muted);margin-right:.2rem}
  .filters button{font:inherit;font-size:.8rem;padding:.3em .9em;border-radius:999px;cursor:pointer;
                  border:1px solid var(--line);background:var(--card);color:var(--muted)}
  .filters button[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
  .filters button:focus-visible{outline:2px solid var(--temp);outline-offset:2px}

  .panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem 1.1rem}
  .panel h2{font-size:.85rem;font-weight:600;margin-bottom:.6rem}
  .panel h2 small{font-weight:400;color:var(--muted)}
  .chart{position:relative}
  .chart svg{display:block;width:100%;height:190px}
  .tip{position:absolute;pointer-events:none;background:var(--ink);color:var(--bg);
       font-size:.75rem;padding:.3em .6em;border-radius:6px;white-space:nowrap;
       transform:translate(-50%,-130%);display:none;font-variant-numeric:tabular-nums}

  /* offline alarm: full-screen red tint that blinks + steady banner. Plain
     background-color on a fixed layer only — no mask/backdrop-filter (Safari). */
  #alarm{position:fixed;inset:0;z-index:10;pointer-events:none}
  #alarm[hidden]{display:none}
  #alarm .ablink{position:absolute;inset:0;background:#c81e2e;animation:ablink 1s steps(2,jump-none) infinite}
  @keyframes ablink{0%,49%{opacity:.12}50%,100%{opacity:.42}}
  #alarm .abox{position:absolute;top:18px;left:50%;transform:translateX(-50%);
    background:#a5111f;color:#fff;font-weight:700;font-size:1.05rem;letter-spacing:.02em;
    padding:.7em 1.5em;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);
    text-align:center;white-space:nowrap}
  #alarm .abox span{display:block;font-weight:500;font-size:.8rem;margin-top:.25em;
    opacity:.92;font-variant-numeric:tabular-nums}
  @media (prefers-reduced-motion: reduce){#alarm .ablink{animation:none;opacity:.3}}

  details{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem 1.1rem}
  summary{font-size:.85rem;font-weight:600;cursor:pointer}
  table{width:100%;border-collapse:collapse;font-size:.82rem;margin-top:.7rem}
  th{text-align:left;font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;
     color:var(--muted);padding:.35rem .5rem;border-bottom:1px solid var(--line)}
  td{padding:.35rem .5rem;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
  tr:last-child td{border-bottom:none}
  .num{text-align:right}
  footer{font-size:.75rem;color:var(--muted);text-align:center}
</style>
</head>
<body>
<div id="alarm" role="alert" hidden>
  <div class="ablink"></div>
  <div class="abox">&#9888; SENSOR OFFLINE<span id="aage"></span></div>
</div>
<div class="wrap">
  <header>
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="22" cy="22" r="22" fill="#7cd1f7"/>
      <circle cx="78" cy="22" r="22" fill="#addcb9"/>
      <circle cx="22" cy="78" r="22" fill="#addcb9"/>
      <circle cx="78" cy="78" r="20" fill="none" stroke="#00b57e" stroke-width="4"/>
    </svg>
    <div>
      <h1>tissue Sense — live</h1>
      <div class="sub">temperature &amp; humidity, reported every 2 seconds</div>
    </div>
    <span class="chip" id="device">—</span>
    <span class="status"><span class="dot live" id="dot"></span><span id="status">connecting…</span></span>
  </header>

  <div class="filters" role="group" aria-label="time window">
    <span>Window</span>
    <button data-w="120" aria-pressed="true">2 min</button>
    <button data-w="600" aria-pressed="false">10 min</button>
    <button data-w="3600" aria-pressed="false">1 hour</button>
  </div>

  <div class="panel">
    <h2>Temperature <small>°C</small></h2>
    <div class="chart" id="tchart"><svg role="img" aria-label="temperature over time"></svg><div class="tip"></div></div>
  </div>
  <div class="panel">
    <h2>Humidity <small>%RH</small></h2>
    <div class="chart" id="hchart"><svg role="img" aria-label="humidity over time"></svg><div class="tip"></div></div>
  </div>

  <div class="tiles">
    <div class="tile">
      <div class="lbl"><i style="background:var(--temp)"></i>Temperature</div>
      <div class="val" id="tval">—<small>°C</small></div>
      <div class="rng" id="trng">&nbsp;</div>
    </div>
    <div class="tile">
      <div class="lbl"><i style="background:var(--hum)"></i>Humidity</div>
      <div class="val" id="hval">—<small>%RH</small></div>
      <div class="rng" id="hrng">&nbsp;</div>
    </div>
  </div>

  <details>
    <summary>Recent readings</summary>
    <table>
      <thead><tr><th>Time</th><th class="num">Temperature °C</th><th class="num">Humidity %RH</th></tr></thead>
      <tbody id="rows"><tr><td colspan="3">no data yet</td></tr></tbody>
    </table>
  </details>

  <footer>cbc-sense · a tissue Cell · data via synapse (MQTTS) · retained 24 h</footer>
</div>

<script>
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var windowSec = 120;
  var series = { temperature: [], humidity: [] };
  var timer = null;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function fmtClock(t) {
    var d = new Date(t);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) +
           ':' + ('0' + d.getSeconds()).slice(-2);
  }
  function decimate(pts, max) {
    if (pts.length <= max) return pts;
    var out = [], step = pts.length / max;
    for (var i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
    out[out.length - 1] = pts[pts.length - 1];
    return out;
  }

  // ── chart ──────────────────────────────────────────────────────────────────
  // Single-series line panel: faint grid, 2px line, soft area fill, emphasized
  // last point with a direct value label, crosshair + tooltip on hover.
  function drawChart(rootId, pts, colorVar, unit) {
    var root = document.getElementById(rootId);
    var svg = root.querySelector('svg');
    var tip = root.querySelector('.tip');
    var W = root.clientWidth || 600, H = 190;
    var padL = 34, padR = 46, padT = 10, padB = 20;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.onmousemove = null; svg.onmouseleave = null;
    if (!pts.length) {
      var t = document.createElementNS(NS, 'text');
      t.setAttribute('x', W / 2); t.setAttribute('y', H / 2);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('fill', cssVar('--muted')); t.setAttribute('font-size', '12');
      t.textContent = 'waiting for readings…';
      svg.appendChild(t);
      tip.style.display = 'none';
      return;
    }
    pts = decimate(pts, 500);
    var color = cssVar(colorVar);
    var t0 = Date.now() - windowSec * 1000, t1 = Date.now();
    var vs = pts.map(function (p) { return p[1]; });
    var vMin = Math.min.apply(null, vs), vMax = Math.max.apply(null, vs);
    var span = Math.max(vMax - vMin, 1);           // never flatter than 1 unit
    var v0 = vMin - span * 0.15, v1 = vMax + span * 0.15;
    var sx = function (t) { return padL + (t - t0) / (t1 - t0) * (W - padL - padR); };
    var sy = function (v) { return H - padB - (v - v0) / (v1 - v0) * (H - padT - padB); };

    // grid: 4 horizontal lines + value labels; 3 time ticks
    var grid = cssVar('--grid'), muted = cssVar('--muted');
    for (var g = 0; g <= 3; g++) {
      var gv = v0 + (v1 - v0) * g / 3, gy = sy(gv);
      var ln = document.createElementNS(NS, 'line');
      ln.setAttribute('x1', padL); ln.setAttribute('x2', W - padR);
      ln.setAttribute('y1', gy); ln.setAttribute('y2', gy);
      ln.setAttribute('stroke', grid); ln.setAttribute('stroke-width', '1');
      svg.appendChild(ln);
      var gt = document.createElementNS(NS, 'text');
      gt.setAttribute('x', padL - 6); gt.setAttribute('y', gy + 3.5);
      gt.setAttribute('text-anchor', 'end'); gt.setAttribute('font-size', '10');
      gt.setAttribute('fill', muted);
      gt.textContent = gv.toFixed(1);
      svg.appendChild(gt);
    }
    for (var k = 0; k <= 2; k++) {
      var tt = t0 + (t1 - t0) * k / 2;
      var tx = document.createElementNS(NS, 'text');
      tx.setAttribute('x', sx(tt));
      tx.setAttribute('y', H - 5);
      tx.setAttribute('text-anchor', k === 0 ? 'start' : (k === 2 ? 'end' : 'middle'));
      tx.setAttribute('font-size', '10'); tx.setAttribute('fill', muted);
      tx.textContent = fmtClock(tt);
      svg.appendChild(tx);
    }

    // area + line
    var dLine = '', dArea = '';
    for (var i = 0; i < pts.length; i++) {
      var X = sx(pts[i][0]).toFixed(1), Y = sy(pts[i][1]).toFixed(1);
      dLine += (i ? 'L' : 'M') + X + ',' + Y;
      dArea += (i ? 'L' : 'M') + X + ',' + Y;
    }
    dArea += 'L' + sx(pts[pts.length - 1][0]).toFixed(1) + ',' + (H - padB) +
             'L' + sx(pts[0][0]).toFixed(1) + ',' + (H - padB) + 'Z';
    var area = document.createElementNS(NS, 'path');
    area.setAttribute('d', dArea); area.setAttribute('fill', color);
    area.setAttribute('opacity', '0.08'); area.setAttribute('stroke', 'none');
    svg.appendChild(area);
    var line = document.createElementNS(NS, 'path');
    line.setAttribute('d', dLine); line.setAttribute('fill', 'none');
    line.setAttribute('stroke', color); line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linejoin', 'round'); line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);

    // emphasized endpoint + direct label
    var last = pts[pts.length - 1];
    var dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', sx(last[0])); dot.setAttribute('cy', sy(last[1]));
    dot.setAttribute('r', '3.5'); dot.setAttribute('fill', color);
    dot.setAttribute('stroke', cssVar('--card')); dot.setAttribute('stroke-width', '2');
    svg.appendChild(dot);
    var lbl = document.createElementNS(NS, 'text');
    lbl.setAttribute('x', Math.min(sx(last[0]) + 8, W - 2));
    lbl.setAttribute('y', sy(last[1]) + 3.5);
    lbl.setAttribute('font-size', '11'); lbl.setAttribute('font-weight', '600');
    lbl.setAttribute('fill', cssVar('--ink'));
    lbl.textContent = last[1].toFixed(1);
    svg.appendChild(lbl);

    // crosshair + tooltip
    var cross = document.createElementNS(NS, 'line');
    cross.setAttribute('y1', padT); cross.setAttribute('y2', H - padB);
    cross.setAttribute('stroke', muted); cross.setAttribute('stroke-width', '1');
    cross.setAttribute('stroke-dasharray', '3 3'); cross.setAttribute('visibility', 'hidden');
    svg.appendChild(cross);
    var hdot = document.createElementNS(NS, 'circle');
    hdot.setAttribute('r', '4'); hdot.setAttribute('fill', color);
    hdot.setAttribute('stroke', cssVar('--card')); hdot.setAttribute('stroke-width', '2');
    hdot.setAttribute('visibility', 'hidden');
    svg.appendChild(hdot);

    svg.onmousemove = function (ev) {
      var box = svg.getBoundingClientRect();
      var mx = (ev.clientX - box.left) * (W / box.width);
      var tAt = t0 + (mx - padL) / (W - padL - padR) * (t1 - t0);
      var best = 0, bd = Infinity;
      for (var j = 0; j < pts.length; j++) {
        var d = Math.abs(pts[j][0] - tAt);
        if (d < bd) { bd = d; best = j; }
      }
      var p = pts[best], px = sx(p[0]);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px);
      cross.setAttribute('visibility', 'visible');
      hdot.setAttribute('cx', px); hdot.setAttribute('cy', sy(p[1]));
      hdot.setAttribute('visibility', 'visible');
      tip.textContent = fmtClock(p[0]) + ' · ' + p[1].toFixed(1) + ' ' + unit;
      tip.style.display = 'block';
      tip.style.left = (px / W * 100) + '%';
      tip.style.top = (sy(p[1]) / H * 100) + '%';
    };
    svg.onmouseleave = function () {
      cross.setAttribute('visibility', 'hidden');
      hdot.setAttribute('visibility', 'hidden');
      tip.style.display = 'none';
    };
  }

  // ── stat tiles, table, status ─────────────────────────────────────────────
  function fmtRange(pts) {
    if (!pts.length) return ' ';
    var vs = pts.map(function (p) { return p[1]; });
    return 'min ' + Math.min.apply(null, vs).toFixed(1) +
           ' · max ' + Math.max.apply(null, vs).toFixed(1);
  }
  function setTile(valId, rngId, pts, unitHtml) {
    var v = document.getElementById(valId), r = document.getElementById(rngId);
    if (pts.length) {
      v.innerHTML = pts[pts.length - 1][1].toFixed(1) + '<small>' + unitHtml + '</small>';
      r.textContent = fmtRange(pts);
    }
  }
  function renderTable() {
    var byT = {};
    series.temperature.forEach(function (p) { byT[p[0]] = { t: p[1] }; });
    series.humidity.forEach(function (p) { (byT[p[0]] = byT[p[0]] || {}).h = p[1]; });
    var keys = Object.keys(byT).sort(function (a, b) { return b - a; }).slice(0, 15);
    var html = '';
    keys.forEach(function (k) {
      var row = byT[k];
      html += '<tr><td>' + fmtClock(Number(k)) + '</td>' +
              '<td class="num">' + (row.t != null ? row.t.toFixed(1) : '—') + '</td>' +
              '<td class="num">' + (row.h != null ? row.h.toFixed(1) : '—') + '</td></tr>';
    });
    document.getElementById('rows').innerHTML =
      html || '<tr><td colspan="3">no data yet</td></tr>';
  }
  // ── offline alarm ──────────────────────────────────────────────────────────
  // The device reports every 2s; >ALARM_AFTER_S of silence means it's gone.
  // Runs on a 1s ticker off the newest reading's age, so it also fires when the
  // dashboard itself loses connectivity (the last reading just keeps aging) and
  // the "no data for Ns" counter climbs smoothly between polls. No alarm before
  // the first reading — a freshly deployed cell isn't an emergency.
  var lastSeenT = 0, fetchErr = false;
  var ALARM_AFTER_S = 10;

  function tick() {
    var dot = document.getElementById('dot'), st = document.getElementById('status');
    var age = lastSeenT ? (Date.now() - lastSeenT) / 1000 : null;
    var offline = age !== null && age > ALARM_AFTER_S;
    document.getElementById('alarm').hidden = !offline;
    if (offline) {
      document.getElementById('aage').textContent = 'no data for ' + Math.round(age) + ' s';
      dot.className = 'dot stale';
      st.textContent = 'OFFLINE · last reading ' + Math.round(age) + ' s ago';
      document.title = '⚠ OFFLINE — tissue Sense';
      return;
    }
    document.title = 'tissue Sense — live';
    if (fetchErr) { dot.className = 'dot stale'; st.textContent = 'connection error'; }
    else if (age === null) { dot.className = 'dot stale'; st.textContent = 'no readings yet'; }
    else if (age < 8) { dot.className = 'dot live'; st.textContent = 'live'; }
    else { dot.className = 'dot stale'; st.textContent = 'last seen ' + Math.round(age) + 's ago'; }
  }

  function redraw() {
    drawChart('tchart', series.temperature, '--temp', '°C');
    drawChart('hchart', series.humidity, '--hum', '%RH');
    setTile('tval', 'trng', series.temperature, '°C');
    setTile('hval', 'hrng', series.humidity, '%RH');
    renderTable();
  }

  function poll() {
    fetch('/api/series?window=' + windowSec)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        series = data.series;
        if (data.device) document.getElementById('device').textContent = data.device;
        ['temperature', 'humidity'].forEach(function (m) {
          var s = series[m];
          if (s.length) lastSeenT = Math.max(lastSeenT, s[s.length - 1][0]);
        });
        fetchErr = false;
        tick();
        redraw();
      })
      .catch(function () { fetchErr = true; tick(); });
  }

  document.querySelectorAll('.filters button').forEach(function (b) {
    b.addEventListener('click', function () {
      windowSec = Number(b.dataset.w);
      document.querySelectorAll('.filters button').forEach(function (o) {
        o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
      });
      poll();
    });
  });

  var ticker = null;
  function start() {
    if (!timer) { poll(); timer = setInterval(poll, 2000); }
    if (!ticker) { ticker = setInterval(tick, 1000); }
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (ticker) { clearInterval(ticker); ticker = null; }
  }
  document.addEventListener('visibilitychange', function () {
    document.hidden ? stop() : start();
  });
  window.addEventListener('resize', redraw);
  start();
})();
</script>
</body>
</html>`;

// ─── Main export ──────────────────────────────────────────────────────────────

export default {
  // sensor() — readings delivered by synapse (x-tissue-event: sensor)
  async sensor(event, env) {
    await ensureSchema(env.DB);
    const r = parseReading(event);
    if (r.value == null) return; // unparseable payload — drop
    await env.DB.prepare(
      "INSERT INTO readings (device, metric, value, unit, recorded_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(r.device, r.metric, r.value, r.unit, r.recorded_at).run();

    // Threshold alerts run inline on ingest — sub-second from bad reading to
    // phone buzz. No-op unless ALERT_* bindings are set.
    if (r.metric === "temperature" || r.metric === "humidity") {
      await checkThreshold(env, r.metric, r.value, r.unit, r.device);
    }
  },

  // pulse() — every minute: offline dead-man's switch; minute-0 run also
  // prunes raw readings older than 24h (plenty for the demo).
  async pulse(event, env) {
    await ensureSchema(env.DB);
    await checkOffline(env);
    if (new Date(event.scheduledTime).getUTCMinutes() === 0) {
      const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
      await env.DB.prepare("DELETE FROM readings WHERE recorded_at < ?").bind(cutoff).run();
    }
  },

  async fetch(request, env) {
    await ensureSchema(env.DB);
    const url = new URL(request.url);

    // GET /api/series?window=<sec>&device=<id> — both metrics as [t_ms, value]
    if (url.pathname === "/api/series") {
      const windowSec = Math.min(Math.max(Number(url.searchParams.get("window")) || 120, 10), 86400);
      let device = url.searchParams.get("device");
      if (!device) {
        const row = await env.DB.prepare(
          "SELECT device FROM readings ORDER BY id DESC LIMIT 1"
        ).first();
        device = row?.device ?? null;
      }
      const since = new Date(Date.now() - windowSec * 1000).toISOString();
      const series = { temperature: [], humidity: [] };
      if (device) {
        const { results } = await env.DB.prepare(
          "SELECT metric, value, recorded_at FROM readings " +
          "WHERE device = ? AND metric IN ('temperature','humidity') AND recorded_at >= ? " +
          "ORDER BY id ASC LIMIT 4000"
        ).bind(device, since).all();
        for (const r of results) {
          if (r.value == null) continue;
          series[r.metric]?.push([new Date(r.recorded_at).getTime(), r.value]);
        }
      }
      return Response.json(
        { device, window: windowSec, series },
        { headers: { "cache-control": "no-store" } }
      );
    }

    if (url.pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
};
