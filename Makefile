# All start/stop targets find the running PID by port, never by binary
# path. NEVER use `pkill -f mobux` or `pkill -f target/debug/mobux` — a
# smoke instance and the long-running instance share the same binary
# path, and a broad pkill kills both. Use `make stop` / `make smoke-stop`
# (port-keyed) or kill the PID you captured from `$!` directly.

MOBUX_PORT       ?= 5151
MOBUX_SMOKE_PORT ?= 8281
MOBUX_USER       ?= $(USER)
MOBUX_PIN        ?= 30879
CARGO            := $(HOME)/.cargo/bin/cargo
PID              := $(shell lsof -ti :$(MOBUX_PORT) 2>/dev/null)
SMOKE_PID        := $(shell lsof -ti :$(MOBUX_SMOKE_PORT) 2>/dev/null)

.PHONY: build run clean start stop restart status logs test web setup setup-twa twa \
        smoke-start smoke-stop smoke-logs smoke-status \
        podman-build podman-run podman-stop podman-test

PODMAN_IMAGE     ?= localhost/mobux:dev
PODMAN_PORT      ?= 8381
PODMAN_NAME      ?= mobux-podman

setup:
	./bin/setup

setup-twa:
	./bin/setup-twa

web:
	node web/build.js

clean:
	$(CARGO) clean -p mobux

build: web
	$(CARGO) build

run: build
	env MOBUX_AUTH_USER=$(MOBUX_USER) MOBUX_PIN=$(MOBUX_PIN) PORT=$(MOBUX_PORT) \
		$(CARGO) run

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

# ---------------------------------------------------------------------------
# smoke-*: throw-away mobux instance for local end-to-end verification.
# Distinct port + isolated data dir so the long-running `make start`
# instance is never touched. Always kill by port (SMOKE_PID), never by
# binary pattern.
# ---------------------------------------------------------------------------
smoke-start: build
	@if [ -n "$(SMOKE_PID)" ]; then echo "smoke already running (pid $(SMOKE_PID)) on $(MOBUX_SMOKE_PORT)"; exit 1; fi
	@if [ "$(MOBUX_SMOKE_PORT)" = "$(MOBUX_PORT)" ]; then echo "MOBUX_SMOKE_PORT must differ from MOBUX_PORT"; exit 1; fi
	@mkdir -p /tmp/mobux-smoke
	@nohup env MOBUX_DATA_DIR=/tmp/mobux-smoke MOBUX_TLS=0 \
		PORT=$(MOBUX_SMOKE_PORT) MOBUX_AUTH_USER=smoke MOBUX_PIN=00000 \
		./target/debug/mobux > /tmp/mobux-smoke/mobux.log 2>&1 < /dev/null & disown
	@sleep 2 && lsof -i :$(MOBUX_SMOKE_PORT) >/dev/null 2>&1 \
		&& echo "smoke mobux running on port $(MOBUX_SMOKE_PORT) (data /tmp/mobux-smoke)" \
		|| { echo "smoke FAILED to start"; tail /tmp/mobux-smoke/mobux.log; exit 1; }

smoke-stop:
	@if [ -z "$(SMOKE_PID)" ]; then echo "smoke not running"; exit 0; fi
	kill $(SMOKE_PID) && echo "smoke stopped (pid $(SMOKE_PID))"

smoke-logs:
	@tail -f /tmp/mobux-smoke/mobux.log

smoke-status:
	@if [ -n "$(SMOKE_PID)" ]; then echo "smoke running (pid $(SMOKE_PID)) on port $(MOBUX_SMOKE_PORT)"; else echo "smoke not running"; fi

test:
	MOBUX_USER=$(MOBUX_USER) MOBUX_PASS=$(MOBUX_PIN) npx playwright test

# Run the playwright suite against an isolated smoke instance instead of
# the long-running `make start` server. Always tears down on exit so a
# failed test doesn't leak a smoke process. Tmux is still shared with
# the host (smoke creates real `mobux-smoke` sessions); for full
# isolation see the podman follow-up.
.PHONY: test-smoke
test-smoke:
	@$(MAKE) smoke-start
	@trap '$(MAKE) smoke-stop' EXIT; \
		MOBUX_URL=http://localhost:$(MOBUX_SMOKE_PORT) \
		MOBUX_USER=smoke MOBUX_PASS=00000 \
		npx playwright test

# ---------------------------------------------------------------------------
# podman-*: containerised mobux instance for full test isolation. Each run
# gets its own tmux server inside the container, so playwright tests
# can create/kill sessions without colliding with the host's tmux.
# `podman-test` mirrors `test-smoke` but inside the container.
# ---------------------------------------------------------------------------
podman-build:
	podman build -t $(PODMAN_IMAGE) -f Containerfile .

podman-run: podman-build
	-@podman rm -f $(PODMAN_NAME) >/dev/null 2>&1
	@podman run -d --name $(PODMAN_NAME) -p $(PODMAN_PORT):8080 \
		-e MOBUX_AUTH_USER=test -e MOBUX_PIN=00000 \
		$(PODMAN_IMAGE) >/dev/null
	@echo "mobux running in container on http://localhost:$(PODMAN_PORT) (test/00000)"

podman-stop:
	-@podman rm -f $(PODMAN_NAME) >/dev/null 2>&1 && echo "stopped $(PODMAN_NAME)" || echo "not running"

podman-test: podman-build
	-@podman rm -f $(PODMAN_NAME) >/dev/null 2>&1
	@podman run -d --name $(PODMAN_NAME) -p $(PODMAN_PORT):8080 \
		-e MOBUX_AUTH_USER=test -e MOBUX_PIN=00000 \
		$(PODMAN_IMAGE) >/dev/null
	@trap 'podman rm -f $(PODMAN_NAME) >/dev/null 2>&1' EXIT; \
		for i in $$(seq 1 30); do \
			if curl -fsS -u test:00000 -o /dev/null http://localhost:$(PODMAN_PORT)/ 2>/dev/null; then break; fi; \
			sleep 0.5; \
		done; \
		MOBUX_URL=http://localhost:$(PODMAN_PORT) \
		MOBUX_USER=test MOBUX_PASS=00000 \
		MOBUX_TEST_TMUX="podman exec $(PODMAN_NAME) tmux" \
		npx playwright test

# ---------------------------------------------------------------------------
# twa: build the signed TWA APK + matching assetlinks.json for MOBUX_DOMAIN.
#
# Prereqs: ./bin/setup-twa has been run and bubblewrap, keytool, apksigner are
# on PATH. The signing keystore lives at ~/.config/mobux/twa-signing.keystore
# (override with MOBUX_CONFIG_DIR). Lose the keystore and existing installs
# can no longer upgrade — only fresh-install. BACK IT UP.
# ---------------------------------------------------------------------------
twa:
	@if [ -z "$$MOBUX_DOMAIN" ]; then \
		echo "MOBUX_DOMAIN is required, e.g. make twa MOBUX_DOMAIN=mine.example.com" >&2; \
		exit 1; \
	fi
	@CONFIG_DIR="$${MOBUX_CONFIG_DIR:-$$HOME/.config/mobux}"; \
	KEYSTORE="$$CONFIG_DIR/twa-signing.keystore"; \
	PASSFILE="$$CONFIG_DIR/twa-signing.password"; \
	mkdir -p "$$CONFIG_DIR"; \
	chmod 700 "$$CONFIG_DIR" 2>/dev/null || true; \
	FRESH_KEY=0; \
	if [ ! -f "$$KEYSTORE" ]; then \
		FRESH_KEY=1; \
		if [ -n "$$MOBUX_TWA_KEYSTORE_PASSWORD" ]; then \
			KEYSTORE_PASSWORD="$$MOBUX_TWA_KEYSTORE_PASSWORD"; \
		else \
			KEYSTORE_PASSWORD="$$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"; \
			umask 077; \
			printf '%s' "$$KEYSTORE_PASSWORD" > "$$PASSFILE"; \
			chmod 600 "$$PASSFILE"; \
		fi; \
		echo "Generating signing keystore at $$KEYSTORE"; \
		keytool -genkeypair -v \
			-keystore "$$KEYSTORE" \
			-alias mobux \
			-keyalg RSA -keysize 2048 \
			-validity 10000 \
			-storepass "$$KEYSTORE_PASSWORD" \
			-keypass "$$KEYSTORE_PASSWORD" \
			-dname "CN=Mobux, OU=mobux, O=mobux, L=Unknown, ST=Unknown, C=XX" >/dev/null; \
		echo ""; \
		echo "============================================================"; \
		echo "  BACK THIS UP: $$KEYSTORE"; \
		echo "  Losing this key prevents APK upgrades for existing installs."; \
		if [ -z "$$MOBUX_TWA_KEYSTORE_PASSWORD" ]; then \
			echo "  Password written to: $$PASSFILE (mode 0600)"; \
		fi; \
		echo "============================================================"; \
		echo ""; \
	else \
		if [ -n "$$MOBUX_TWA_KEYSTORE_PASSWORD" ]; then \
			KEYSTORE_PASSWORD="$$MOBUX_TWA_KEYSTORE_PASSWORD"; \
		elif [ -f "$$PASSFILE" ]; then \
			KEYSTORE_PASSWORD="$$(cat "$$PASSFILE")"; \
		else \
			echo "Keystore exists at $$KEYSTORE but neither MOBUX_TWA_KEYSTORE_PASSWORD nor $$PASSFILE is set." >&2; \
			exit 1; \
		fi; \
	fi; \
	CA_CERT="$$CONFIG_DIR/ca.crt"; \
	if [ -f "$$CA_CERT" ] && [ -z "$${NODE_EXTRA_CA_CERTS:-}" ]; then \
		export NODE_EXTRA_CA_CERTS="$$CA_CERT"; \
	fi; \
	mkdir -p "$$HOME/.bubblewrap"; \
	if [ ! -f "$$HOME/.bubblewrap/config.json" ]; then \
		printf '{\n  "jdkPath": "%s",\n  "androidSdkPath": "%s"\n}\n' \
			"$${JAVA_HOME:-$$HOME/.sdkman/candidates/java/current}" \
			"$${ANDROID_HOME:-$$HOME/.android}" \
			> "$$HOME/.bubblewrap/config.json"; \
	fi; \
	echo "Rendering twa/twa-manifest.json (MOBUX_DOMAIN=$$MOBUX_DOMAIN)"; \
	sed -e "s|__MOBUX_DOMAIN__|$$MOBUX_DOMAIN|g" \
		-e "s|__MOBUX_KEYSTORE_PATH__|$$KEYSTORE|g" \
		twa/twa-manifest.json.template > twa/twa-manifest.json; \
	if [ -d twa/app ]; then \
		echo "Regenerating TWA project from manifest (twa/app/)"; \
		rm -rf twa/app; \
	fi; \
	echo "Initializing TWA project (twa/app/)"; \
	node twa/init.js; \
	echo "Building signed APK"; \
	( cd twa/app && BUBBLEWRAP_KEYSTORE_PASSWORD="$$KEYSTORE_PASSWORD" \
		BUBBLEWRAP_KEY_PASSWORD="$$KEYSTORE_PASSWORD" \
		bubblewrap build ); \
	APK_SRC="twa/app/app-release-signed.apk"; \
	if [ ! -f "$$APK_SRC" ]; then \
		echo "Expected signed APK at $$APK_SRC but it is missing." >&2; \
		exit 1; \
	fi; \
	mkdir -p web/static/install; \
	cp "$$APK_SRC" web/static/install/mobux.apk; \
	echo "Wrote web/static/install/mobux.apk"; \
	FINGERPRINT="$$(keytool -list -v \
		-keystore "$$KEYSTORE" \
		-alias mobux \
		-storepass "$$KEYSTORE_PASSWORD" 2>/dev/null \
		| awk '/SHA256:/ {print $$2; exit}')"; \
	if [ -z "$$FINGERPRINT" ]; then \
		echo "Could not extract SHA-256 fingerprint from keystore." >&2; \
		exit 1; \
	fi; \
	mkdir -p web/static/.well-known; \
	printf '[{\n  "relation": ["delegate_permission/common.handle_all_urls"],\n  "target": {\n    "namespace": "android_app",\n    "package_name": "io.github.mvhenten.mobux",\n    "sha256_cert_fingerprints": ["%s"]\n  }\n}]\n' "$$FINGERPRINT" > web/static/.well-known/assetlinks.json; \
	echo "Wrote web/static/.well-known/assetlinks.json (fingerprint $$FINGERPRINT)"; \
	if [ "$$FRESH_KEY" = "1" ]; then \
		echo ""; \
		echo "Reminder: back up $$KEYSTORE and $$PASSFILE before you forget."; \
	fi
