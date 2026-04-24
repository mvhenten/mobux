MOBUX_PORT ?= 5151
MOBUX_USER ?= mvhenten
MOBUX_PIN  ?= 30879
CARGO      := $(HOME)/.cargo/bin/cargo
PID        := $(shell lsof -ti :$(MOBUX_PORT) 2>/dev/null)

.PHONY: build start stop restart status logs

build:
	$(CARGO) build

start: build
	@if [ -n "$(PID)" ]; then echo "already running (pid $(PID))"; exit 1; fi
	nohup env MOBUX_AUTH_USER=$(MOBUX_USER) MOBUX_PIN=$(MOBUX_PIN) PORT=$(MOBUX_PORT) \
		./target/debug/mobux > /tmp/mobux.log 2>&1 &
	@sleep 2 && lsof -i :$(MOBUX_PORT) >/dev/null 2>&1 && echo "mobux running on port $(MOBUX_PORT)" || echo "FAILED to start"

stop:
	@if [ -z "$(PID)" ]; then echo "not running"; exit 0; fi
	kill $(PID) && echo "stopped (pid $(PID))"

restart: stop
	@sleep 2
	@$(MAKE) start

status:
	@if [ -n "$(PID)" ]; then echo "running (pid $(PID)) on port $(MOBUX_PORT)"; else echo "not running"; fi

logs:
	@tail -f /tmp/mobux.log

test:
	npx playwright test
