# Firmware — Wemos D1 Mini + DHT22 → tissue Sense

The firmware that runs on the Cascadia Builders Club demo device: a **Wemos D1
Mini (ESP8266)** with a **DHT22** temperature/humidity sensor.

What it does, in order:

1. **Wi-Fi setup** — on first boot the board opens its own Wi-Fi network
   (`tissue-sense-XXXX`) with a captive portal where you pick your home Wi-Fi.
2. **Account link** — the board calls the tissue setup endpoint and links itself
   to the account you created from the device's QR code. Its reporting
   credentials come back once and are stored in the board's own flash.
3. **Reporting** — it publishes temperature + humidity as JSON over MQTT/TLS to
   `ingest.tissue.dev`, where they're delivered to the Cell in
   [`../cell/`](../cell/) and appear on the live dashboard.

Everything is in one commented file: [`src/main.cpp`](src/main.cpp).
Build-time settings (pins, intervals, endpoints) are in
[`include/config.h.example`](include/config.h.example) — no secrets live there.

## Wiring

The sensor's data line goes to **D4** (the pin silk-printed "2", next to GND).

**Option A — DHT22 breakout board (3 pins, recommended):** the pull-up resistor
is already on the little board, so it's just three jumper wires:

| Breakout pin | → D1 Mini |
|---|---|
| `+` (VCC) | **3V3** |
| `out` (DATA) | **D4** |
| `−` (GND) | **G** |

**Option B — bare 4-pin DHT22:** grille facing you, pins down, numbered
left → right:

| DHT22 pin | Function | → D1 Mini |
|---|---|---|
| 1 | VCC | **3V3** |
| 2 | DATA | **D4** |
| 3 | not connected | — |
| 4 | GND | **G** |

…plus a **10 kΩ resistor between pin 1 (VCC) and pin 2 (DATA)**. Without it the
data line floats and every read comes back `NaN`.

Two things worth knowing:

- **Power the sensor from 3V3, not 5V** — it keeps the data line at safe
  3.3 V logic levels for the ESP8266.
- **The onboard LED won't blink** in this wiring: D4 is also the LED pin, so
  the firmware disables the LED and uses the **serial log** as its status
  channel instead.

## Install the tools

[PlatformIO](https://platformio.org/) does everything — it downloads the
compiler, the ESP8266 toolchain, and all libraries automatically on first build.

- **macOS**: `brew install platformio` (or `pipx install platformio`)
- **Linux**: `pipx install platformio` — and add yourself to the serial-port
  group (`sudo usermod -aG dialout $USER`, then log out and back in)
- **Windows**: install [VS Code](https://code.visualstudio.com/) with the
  **PlatformIO IDE** extension, or `pip install platformio` in a terminal.
  If the board doesn't show up as a COM port, install the
  [CH340 USB driver](https://www.wch-ic.com/downloads/CH341SER_ZIP.html)
  (macOS and Linux have it built in).

## Build & flash

Plug the board in over USB, then — on macOS/Linux:

```bash
make config     # one-time: copies include/config.h from the example
make upload     # build + flash
make monitor    # watch the serial log (115200 baud)
# or both at once:
make flash
```

On Windows (no `make`), the same steps as plain PlatformIO commands:

```powershell
copy include\config.h.example include\config.h
pio run -t upload
pio device monitor -b 115200
```

If auto-detect picks the wrong serial port, name it explicitly:

- macOS: `make upload PORT=/dev/cu.usbserial-210`
- Linux: `make upload PORT=/dev/ttyUSB0`
- Windows: `pio run -t upload --upload-port COM5`

(`make devices` / `pio device list` shows what's connected. Uploads run at
460800 baud — flaky-cable-safe; drop `upload_speed` in `platformio.ini` to
115200 if uploads still fail.)

## What you'll see

Serial log of a healthy first boot:

```
[boot] tissue Sense — D1 Mini + DHT22
[boot] mac=8C:AA:B5:13:E3:01
[portal] setup Wi-Fi up: tissue-sense-13E3
[portal] join it, then follow: https://tissue.systems/sense/start
... you pick your Wi-Fi in the portal ...
[wifi] connected: ssid=home-net ip=192.168.1.42
[time] syncing.... ok
[link] linking this device to your account...
[link] linked. device=dev_db0a2afc
[link] reporting as dev_db0a2afc
[mqtt] connecting to ingest.tissue.dev:8883 ... connected
[dht] 22.4 C  47.1 %RH
[pub] tissue/acct_…/dev_…/env/temperature {"value":22.4,"unit":"C"} ok
[pub] tissue/acct_…/dev_…/env/humidity {"value":47.1,"unit":"%RH"} ok
```

If `[link]` prints "waiting", finish signup on the page from the device's QR
sticker — the board keeps polling and links the moment the account exists.

## Reporting interval

`REPORT_INTERVAL_MS` in `include/config.h` controls the cadence. The demo
device reports every **2 seconds** — that's a show-floor setting on a specially
provisioned demo account (and the DHT22's minimum sample period). **On a
regular tissue account, report once a minute** (`60000UL`) — that's the
supported cadence for normal use.

## Re-provisioning / handing the board to someone else

Hold the **FLASH button** (the one marked FLASH, GPIO0) while powering on or
resetting. This factory-resets the board — saved Wi-Fi *and* the account link
are wiped, and the setup portal opens again.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[dht] read failed (NaN)` | Wiring — usually a loose jumper, or a bare sensor missing its 10 kΩ pull-up. |
| Upload fails / `Invalid head of packet` | Bad cable or USB hub — plug in directly, or lower `upload_speed` to 115200. |
| No serial port appears | Windows: install the CH340 driver (link above). Linux: check you're in the `dialout` group. |
| `[link] not recognized yet` | Scan the QR sticker and finish the setup page first — that's what tells tissue which account this board belongs to. |
| `[link] already linked` | The board belongs to a previous owner/account — factory-reset (hold FLASH at boot). |

## A note on TLS

By default the build encrypts its connections but does not validate the
server's certificate (`-D DEVICE_TLS_INSECURE=1` in `platformio.ini`) — that's
the normal microcontroller trade-off for getting started, and it protects your
credentials from passive eavesdroppers. To fully validate: remove that flag and
create `include/certs.h` defining `ISRG_ROOT_X1` (the Let's Encrypt root
certificate in PEM form) — the firmware then pins it for both the setup call
and MQTT.

## Files

| File | What it is |
|---|---|
| `src/main.cpp` | All the firmware logic, heavily commented |
| `include/config.h.example` | Build-time settings — copy to `config.h` (gitignored) and edit |
| `platformio.ini` | Board, libraries, build flags |
| `Makefile` | Thin convenience wrapper around `pio` commands |
| `data/creds.json` | Per-device reporting credentials — created at runtime by the account link; **never committed** (gitignored). Pre-provisioned demo units have it baked into flash instead (`pio run -t uploadfs`). |
| `reference/mqtt-report.cpp.txt` | Minimal standalone MQTT-reporting example, kept for reference |
