MOBUX_PORT ?= 5151
MOBUX_USER ?= $(USER)
MOBUX_PIN  ?= $(shell shuf -i 10000-99999 -n 1)
CARGO      := $(HOME)/.cargo/bin/cargo
PID        := $(shell lsof -ti :$(MOBUX_PORT) 2>/dev/null)

.PHONY: build start stop restart status logs test

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
	MOBUX_USER=$$(cat /proc/$$(lsof -ti :$(MOBUX_PORT) 2>/dev/null)/environ 2>/dev/null | tr '\0' '\n' | grep MOBUX_AUTH_USER | cut -d= -f2) \
	MOBUX_PASS=$$(cat /proc/$$(lsof -ti :$(MOBUX_PORT) 2>/dev/null)/environ 2>/dev/null | tr '\0' '\n' | grep MOBUX_PIN | cut -d= -f2) \
	npx playwright test
