# provision-esp8266 — build / flash a Wemos D1 Mini + DHT22
#
#   make            → build
#   make upload     → build + flash over USB
#   make flash      → build + flash + open serial monitor
#   make monitor    → open serial monitor only
#   make config     → scaffold include/config.h from the example
#   make clean      → remove build artifacts
#
# Override the serial port if auto-detect picks the wrong one:
#   make upload PORT=/dev/tty.usbserial-1420

PIO   ?= pio
PORT  ?=
BAUD  ?= 115200

# Append --upload-port / --monitor-port only when PORT is set.
ifneq ($(PORT),)
  PORT_FLAG := --upload-port $(PORT)
  MON_PORT  := --port $(PORT)
endif

.DEFAULT_GOAL := build

# ── guards ──────────────────────────────────────────────────────────────────
.PHONY: check-pio
check-pio:
	@command -v $(PIO) >/dev/null 2>&1 || { \
	  echo "error: PlatformIO CLI '$(PIO)' not found."; \
	  echo "  install: pipx install platformio   (or  pip install platformio)"; \
	  echo "  docs:    https://docs.platformio.org/en/latest/core/installation/"; \
	  exit 1; }

.PHONY: check-config
check-config:
	@test -f include/config.h || { \
	  echo "error: include/config.h missing. Run 'make config' then edit it."; \
	  exit 1; }

# ── targets ─────────────────────────────────────────────────────────────────
.PHONY: build
build: check-pio check-config
	$(PIO) run

.PHONY: upload
upload: check-pio check-config
	$(PIO) run -t upload $(PORT_FLAG)

# Flash then immediately watch the serial log.
.PHONY: flash
flash: upload monitor

.PHONY: monitor
monitor: check-pio
	$(PIO) device monitor -b $(BAUD) $(MON_PORT)

.PHONY: config
config:
	@test -f include/config.h && echo "include/config.h already exists — leaving it." || { \
	  cp include/config.h.example include/config.h; \
	  echo "created include/config.h — edit Wi-Fi + device credentials, then 'make upload'."; }

.PHONY: devices
devices: check-pio
	$(PIO) device list

.PHONY: clean
clean: check-pio
	$(PIO) run -t clean

.PHONY: fullclean
fullclean:
	rm -rf .pio
