# Onboarding — how your device gets set up

You got a Wemos D1 Mini + DHT22 with a **QR sticker**. Here's the whole journey
from "just unboxed" to "live readings on the dashboard" — no command line, no
account juggling.

## What you do

1. **Scan the QR sticker** on your device. It opens the tissue Sense setup page.
2. **Create your free account** on that page (or sign in if you already have one).
3. **Power on the device** (USB). It creates a temporary Wi-Fi network named
   `tissue-sense-XXXX`.
4. **Join that network** from your phone or laptop. A setup page opens
   automatically — pick your home Wi-Fi and enter its password.
5. **Done.** The device connects to your Wi-Fi, links itself to your account,
   and starts reporting. Within a few seconds your temperature and humidity
   readings appear on the live dashboard.

That's it — the device figures out which account is yours (via the QR-code
setup page) and starts reporting. You never type anything device-specific.

## Watching it happen (optional)

Plug the device into your computer and open a serial monitor at 115200 baud
(`make monitor` — see [`README.md`](README.md)) to watch every step: Wi-Fi
connect, account link, and each published reading. It's also the fastest way to
diagnose a problem.

## Re-doing setup

Hold the **FLASH button** while powering on to factory-reset — the device
forgets its saved Wi-Fi *and* its account link, and the setup network reopens.
Handy if you move it to a new network or pass it on to someone else.

## Troubleshooting readings

If the serial log shows `read failed (NaN)`, it's the sensor wiring — most
often a loose jumper, or (with a bare 4-pin sensor) a missing pull-up resistor.
See the wiring section in [`README.md`](README.md).
