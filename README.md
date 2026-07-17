# tissue Sense — Cascadia Builders Club demo

This is the **Cascadia Builders Club demo** for [tissue.systems](https://tissue.systems):
a small Wi-Fi board with a temperature/humidity sensor that reports over MQTT to a
tissue **Cell**, which stores the readings in a **c3** database and serves a live
web dashboard with charts.

| Directory | What it is |
|---|---|
| [`cell/`](cell/) | Everything needed to deploy the **backend** to tissue.systems: the Cell code (`cell.js`, which ingests readings, stores them, and serves the dashboard) and its configuration (`ribo.toml`). |
| [`firmware/`](firmware/) | What you **flash onto the Wemos D1 Mini** device, with the sensor wired the way the firmware expects. Handles Wi-Fi setup (captive portal), links the device to a tissue account, and reports readings over MQTT/TLS. |

```
D1 Mini + DHT22 ──MQTT over TLS──▶ tissue ──▶ your Cell's sensor() handler ──▶ c3 database
                                                        ▲
                     your browser ◀── live dashboard ───┘
```

---

## The hardware

Around $12 total, no soldering if you buy the breakout version of the sensor:

- **Sensor — DHT22 / AM2302 on a breakout board**:
  [Amazon B0BBDSMSK6](https://www.amazon.com/dp/B0BBDSMSK6) or equivalent.
  Get the 3-pin *breakout board* version if you can — it has the required
  pull-up resistor built in, so it wires straight to the D1 Mini with three
  jumper wires. (A bare 4-pin DHT22 works too; you just add a 10 kΩ resistor —
  see [`firmware/README.md`](firmware/README.md).)
- **Board — Wemos D1 Mini V4.0.0 (ESP8266, USB-C)**:
  [Amazon B0CL9CTXZH](https://www.amazon.com/dp/B0CL9CTXZH) or any equivalent
  "Wemos D1 mini" / ESP8266 board (the older micro-USB versions work exactly
  the same).

Wiring (breakout board): sensor `+` → `3V3`, sensor `out` → `D4`, sensor `−` → `G`.
Full details and a diagram in [`firmware/README.md`](firmware/README.md).

---

## I have a tissue demo device — how do I onboard it?

If you picked up a pre-built demo device at a Builders Club event, the cloud
side is already prepared for you: the device is pre-provisioned, and the Cell
code and c3 database in this repo are already deployed. The QR code on the
device sets up a **free account of your own**:

1. **Scan the QR code** on the device — it opens the tissue Sense setup page.
   **Create your free account** there (it's yours, not shared — each demo
   device's QR link creates one for its owner).
2. **Power the device from USB.** It creates a temporary Wi-Fi network named
   `tissue-sense-XXXX`.
3. **Join that network** from your phone or laptop. A setup page opens
   automatically — pick your home Wi-Fi and enter its password.
4. Done. The device connects, links itself to your new account, and readings
   appear on your live dashboard within a few seconds.

To change what the device runs (different sensor, different cadence, your own
ideas), see [How do I create or change firmware?](#how-do-i-create-or-change-firmware)
— the exact firmware it ships with is in [`firmware/`](firmware/).

> **Note on reporting cadence:** demo devices report every **2 seconds** purely
> for show-floor effect, on a specially provisioned demo account. On a regular
> tissue account, report **once a minute** — that's the supported cadence for
> normal use (and plenty for temperature, which doesn't change faster than that).

---

## Bring your own device

Any board that speaks MQTT 3.1.1 over TLS — an ESP32 with MicroPython, a
Raspberry Pi, a Tasmota device, a Python script — can report to tissue. The full
walkthrough is [Connect Your Own Device](https://docs.tissue.systems/docs/synapse/byo-device/);
the short version:

**1. Provision the device.** Register it under one of your Cells — this mints
its credentials (shown once, save them):

```bash
ribo sensor add my-sensors
#   device_id  dev_a1b2c3d4      ← MQTT username
#   token      key_<64 hex>      ← MQTT password
#   topic      tissue/<account>/<device>/<metric>
```

You can also register from the dashboard (Synapse section) or the
[REST API](https://docs.tissue.systems/docs/synapse/api/).

**2. Topics.** There's nothing to "create" — every device gets its own topic
namespace, `tissue/<account>/<device>/…`, and can publish to any topic inside
it. The last topic segment is the metric name your Cell sees. This demo uses
`…/env/temperature` and `…/env/humidity`.

**3. Publish a reading.** Connect to `ingest.tissue.dev:8883` (TLS), username =
`device_id`, password = token, and publish JSON:

```bash
mosquitto_pub -h ingest.tissue.dev -p 8883 \
  --cafile /etc/ssl/certs/ca-certificates.crt \
  -u dev_a1b2c3d4 -P key_... \
  -t 'tissue/acct_9c3f21ab/dev_a1b2c3d4/env/temperature' \
  -m '{"value":21.4,"unit":"C"}'
```

Each publish is delivered to your Cell's `sensor(event, env)` handler —
[`cell/cell.js`](cell/cell.js) is a complete, commented example of what to do
with it.

**4. Send data *to* the device (downlink).** Have the device subscribe to a
topic inside its own namespace (say `tissue/<account>/<device>/cmd/#`). A Cell
can't hold an MQTT connection itself, so it publishes through the downlink
endpoint using the device's credentials, with the topic given *relative* to the
device's namespace:

```js
// inside a Cell — turn something on/off on the device
await fetch("https://ingest.tissue.dev/publish", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    device_id: "dev_a1b2c3d4",
    token: "key_...",             // store this in a vault binding, never in code
    topic: "cmd/led",             // → tissue/<account>/dev_a1b2c3d4/cmd/led
    payload: { on: true },
  }),
});
```

Rate limits, payload sizes, disabling and rotating device credentials:
[Managing Devices](https://docs.tissue.systems/docs/synapse/devices/).

---

## How do I create or change firmware?

The firmware for the demo device lives in [`firmware/`](firmware/) — full
instructions in [`firmware/README.md`](firmware/README.md). The quick version:

**1. Get this repo:**

```bash
git clone https://github.com/tissue-systems/demo-cbc-sense.git
cd demo-cbc-sense/firmware
```

**2. Install PlatformIO** (the build tool — it fetches the compiler and all
libraries automatically):

- **macOS**: `brew install platformio` (or `pipx install platformio`)
- **Linux**: `pipx install platformio` (or `pip install --user platformio`).
  Also add yourself to the serial port group: `sudo usermod -aG dialout $USER`,
  then log out and back in.
- **Windows**: install [VS Code](https://code.visualstudio.com/) and add the
  **PlatformIO IDE** extension (which includes the `pio` command), or
  `pip install platformio` in a terminal. Most D1 Mini boards need the
  [CH340 USB driver](https://www.wch-ic.com/downloads/CH341SER_ZIP.html) on
  Windows; macOS and Linux ship with it.

**3. Flash the board** (plug it in over USB first):

```bash
make config      # one-time: creates include/config.h from the example
make upload      # build + flash
make monitor     # watch the live serial log (115200 baud)
```

On **Windows** (no `make`), run the underlying commands directly:

```powershell
copy include\config.h.example include\config.h
pio run -t upload
pio device monitor -b 115200
```

If the upload can't find your board, name the port explicitly — macOS:
`make upload PORT=/dev/cu.usbserial-210`, Linux: `PORT=/dev/ttyUSB0`,
Windows: `pio run -t upload --upload-port COM5`.

From there, [`firmware/src/main.cpp`](firmware/src/main.cpp) is fully commented
— change the report interval, add a sensor, invent something. (An AI coding
agent is great at this — see below.)

---

## How do I create a Cell?

A Cell is a JavaScript function on a live URL — [`cell/cell.js`](cell/cell.js)
in this repo is a real one you can read top to bottom. Start with
[Get Started](https://docs.tissue.systems/docs/get-started/), then
[Writing Cells](https://docs.tissue.systems/docs/cells/writing/). The minimum:

```js
// cell.js
export default {
  async fetch(request, env) {
    return new Response("hello from tissue!");
  }
};
```

```toml
# ribo.toml
[cell]
name = "hello"
js   = "./cell.js"
```

```bash
ribo deploy    # → https://hello.<your-subdomain>.tissue.dev
```

**Add a c3 database** (SQL, backed by SQLite) when you need to store things:

```bash
ribo db create readings
```

```toml
[[bindings]]
type     = "c3"
binding  = "DB"          # available in code as env.DB
database = "readings"
```

```js
await env.DB.exec("INSERT INTO readings (value) VALUES (?)", 21.4);
const rows = await env.DB.query("SELECT * FROM readings ORDER BY rowid DESC LIMIT 20");
```

See [c3 Overview](https://docs.tissue.systems/docs/c3/overview/) and the
[c3 API](https://docs.tissue.systems/docs/c3/api/).

**Charts and graphs**: a Cell serves ordinary HTML, so any browser charting
library works — load it from a CDN in the page you return:

- [Chart.js](https://www.chartjs.org/) — easiest all-rounder
- [uPlot](https://github.com/leeoniya/uPlot) — tiny and very fast for time series
- [Plotly.js](https://plotly.com/javascript/) — scientific/interactive plots
- Plain inline **SVG** — zero dependencies; that's what this demo's dashboard
  does (see the `drawChart` function in [`cell/cell.js`](cell/cell.js))

---

## Building with AI (Claude Code or any LLM agent)

You don't have to write any of this by hand — Claude Code or any other LLM/agent
can generate Cells, firmware changes, and dashboards. tissue also has an **MCP
server**, so an agent can create databases, deploy Cells, and register devices
for you directly: [MCP Overview](https://docs.tissue.systems/docs/mcp/overview/)
and [MCP Tools](https://docs.tissue.systems/docs/mcp/tools/).

Example prompts that work well:

> Read https://docs.tissue.systems/docs/get-started/ and
> https://docs.tissue.systems/docs/cells/writing/. Create a tissue Cell with a
> `sensor()` handler that stores incoming readings in a c3 database, and a
> `fetch()` handler that serves a page charting the last hour of readings as a
> line graph with Chart.js. Give me the cell.js, the ribo.toml, and the ribo
> commands to deploy it.

> Using the tissue MCP server, create a c3 database called `plants`, deploy a
> Cell called `plant-monitor` that logs soil-moisture readings from my sensor
> and shows a live graph, and register a device for it. Report readings once a
> minute.

> Modify firmware/src/main.cpp to also read a BMP280 pressure sensor over I2C
> and publish it as a third metric, `env/pressure`.

---

## Documentation

Everything lives under [docs.tissue.systems](https://docs.tissue.systems):

| Topic | Link |
|---|---|
| Platform overview | https://docs.tissue.systems/docs/overview/ |
| Get started (first Cell in ~5 min) | https://docs.tissue.systems/docs/get-started/ |
| Cells — writing | https://docs.tissue.systems/docs/cells/writing/ |
| Cells — configuration (`ribo.toml`) | https://docs.tissue.systems/docs/cells/configuration/ |
| c3 — SQL databases | https://docs.tissue.systems/docs/c3/overview/ |
| g7 — object storage | https://docs.tissue.systems/docs/g7/overview/ |
| Pulse — scheduled invocations (cron) | https://docs.tissue.systems/docs/pulse/overview/ |
| Synapse — sensors & MQTT ingest | https://docs.tissue.systems/docs/synapse/overview/ |
| Connect your own device | https://docs.tissue.systems/docs/synapse/byo-device/ |
| Managing devices | https://docs.tissue.systems/docs/synapse/devices/ |
| ribo CLI reference | https://docs.tissue.systems/docs/ribo/reference/ |
| MCP server (for AI agents) | https://docs.tissue.systems/docs/mcp/overview/ |

---

## Deploying the backend yourself

The demo Cell is already live for demo devices, but the whole backend is
reproducible from [`cell/`](cell/) on your own account:

```bash
ribo db create cbc-sense
# optional — Telegram push alerts (sensor offline / threshold crossed);
# setup walkthrough at the top of cell/cell.js:
ribo vault set cbc-sense TELEGRAM_BOT_TOKEN
ribo vault set cbc-sense TELEGRAM_CHAT_ID
cd cell && ribo deploy
```

Then register a device for it (`ribo sensor add cbc-sense`), point your board at
those credentials, and open the Cell's URL — the dashboard goes live with the
first reading.
