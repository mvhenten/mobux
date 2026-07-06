# All start/stop targets find the running PID by port, never by binary
# path. NEVER use `pkill -f mobux` or `pkill -f target/debug/mobux` — a
# smoke instance and the long-running instance share the same binary
# path, and a broad pkill kills both. Use `make stop` / `make smoke-stop`
# (port-keyed) or kill the PID you captured from `$!` directly.

MOBUX_PORT       ?= 5151
MOBUX_DEV_PORT   ?= 5152
MOBUX_SMOKE_PORT ?= 8281
MOBUX_USER       ?= $(USER)
MOBUX_PIN        ?= 30879
CARGO            := $(HOME)/.cargo/bin/cargo

# TWA build identity (overridable so `twa-dev` can produce a coexisting app).
# Prod defaults must keep current behavior exactly.
MOBUX_PACKAGE_ID  ?= io.github.mvhenten.mobux
MOBUX_APP_NAME    ?= Mobux
TWA_INSTALL_DIR   ?= web/static/install
TWA_WELLKNOWN_DIR ?= web/static/.well-known
MOBUX_DEV_DOMAIN  ?= sandbox:5152
PID              := $(shell lsof -ti :$(MOBUX_PORT) 2>/dev/null)
SMOKE_PID        := $(shell lsof -ti :$(MOBUX_SMOKE_PORT) 2>/dev/null)

.PHONY: build run dev dev-watch _dev-bounce clean start stop restart status logs test web setup setup-twa twa twa-dev \
        transcribe setup-transcribe \
        smoke-start smoke-stop smoke-logs smoke-status \
        test-smoke test-critical-path test-update-runner test-spa test-stt-ux test-stt-per-kind test-e2e \
        podman-build podman-run podman-stop podman-test stt-install

PODMAN_IMAGE     ?= localhost/mobux:dev
PODMAN_PORT      ?= 8381
PODMAN_NAME      ?= mobux-podman

# Local speech-to-text (whisper.cpp) for transcribing uploaded recordings.
# Host-side tooling — NOT bundled into the mobux binary. Lives under
# $(WHISPER_DIR); `transcribe` is capability-gated and no-ops gracefully if
# whisper isn't installed (run `make setup-transcribe`).
WHISPER_DIR        ?= $(HOME)/.local/whisper.cpp
WHISPER_MODEL_NAME ?= base.en

setup:
	./bin/setup

setup-twa:
	./bin/setup-twa

# Transcribe an uploaded audio/video file with local whisper.cpp.
#   make transcribe FILE=/tmp/mobux-uploads/<file>
transcribe:
	@if [ -z "$(FILE)" ]; then echo "usage: make transcribe FILE=<audio-or-video-file>" >&2; exit 2; fi
	@WHISPER_DIR="$(WHISPER_DIR)" ./bin/transcribe "$(FILE)"

# Build whisper.cpp + download the model into $(WHISPER_DIR). Idempotent.
setup-transcribe:
	@command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is required (apt install ffmpeg)"; exit 1; }
	@if [ ! -d "$(WHISPER_DIR)" ]; then \
		git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$(WHISPER_DIR)"; \
	fi
	cmake -B "$(WHISPER_DIR)/build" -S "$(WHISPER_DIR)" -DCMAKE_BUILD_TYPE=Release
	cmake --build "$(WHISPER_DIR)/build" -j --config Release
	bash "$(WHISPER_DIR)/models/download-ggml-model.sh" "$(WHISPER_MODEL_NAME)" "$(WHISPER_DIR)/models"
	@echo "whisper.cpp ready at $(WHISPER_DIR) (model: $(WHISPER_MODEL_NAME))"

web:
	node web/build.js

# Speech-to-text provider setup. Installs a local OpenAI-compatible server.
stt-install:
	@bin/stt-install

clean:
	$(CARGO) clean -p mobux

build: web
	$(CARGO) build

run: build
	env MOBUX_AUTH_USER=$(MOBUX_USER) MOBUX_PIN=$(MOBUX_PIN) PORT=$(MOBUX_PORT) \
		$(CARGO) run

# Foreground dev instance with the client telemetry channel live (MOBUX_DEV=1).
# Runs on MOBUX_DEV_PORT (5152) so it never touches the long-running :5151
# lifeline. Hit it at http(s)://<host>:5152/?telemetry=1 for the on-screen log
# overlay; telemetry lines also print to this terminal (stderr). Ctrl-C to stop.
dev: build
	env MOBUX_AUTH_USER=$(MOBUX_USER) MOBUX_PIN=$(MOBUX_PIN) MOBUX_DEV=1 PORT=$(MOBUX_DEV_PORT) \
		$(CARGO) run

# Auto-rebuild loop for the dev box. Watches src/ (Rust) and on every change
# rebuilds the binary and bounces the :5152 dev server in the background — so
# you edit, save, and just reload the phone. Never touches the :5151 lifeline.
# JS/CSS under web/static/ is served straight from disk (no-store), so those
# edits need no rebuild at all — just reload. Requires cargo-watch.
dev-watch: build
	cargo watch -w src -w Cargo.toml -x build -s '$(MAKE) _dev-bounce'

_dev-bounce:
	-@kill $$(lsof -ti :$(MOBUX_DEV_PORT)) 2>/dev/null || true
	@sleep 1
	@nohup env MOBUX_AUTH_USER=$(MOBUX_USER) MOBUX_PIN=$(MOBUX_PIN) MOBUX_DEV=1 PORT=$(MOBUX_DEV_PORT) \
		./target/debug/mobux > /tmp/mobux-dev.log 2>&1 &
	@sleep 2 && lsof -i :$(MOBUX_DEV_PORT) >/dev/null 2>&1 \
		&& echo "dev :$(MOBUX_DEV_PORT) rebuilt + restarted" || echo "FAILED to restart :$(MOBUX_DEV_PORT)"

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
	@mkdir -p /tmp/mobux-smoke/home
	@nohup env MOBUX_DATA_DIR=/tmp/mobux-smoke MOBUX_TLS=0 \
		HOME=/tmp/mobux-smoke/home HISTFILE=/dev/null \
		MOBUX_TMUX_SOCKET=mobux-test \
		MOBUX_UPDATE_TEST_INDEX='{"name":"mobux","vers":"999.0.0","yanked":false}' \
		MOBUX_UPDATE_CHECK_URL=http://127.0.0.1:$(MOBUX_SMOKE_PORT)/api/update/test-index \
		MOBUX_UPDATE_DISABLE_RUN=1 \
		PORT=$(MOBUX_SMOKE_PORT) MOBUX_AUTH_USER=smoke MOBUX_PIN=00000 \
		./target/debug/mobux > /tmp/mobux-smoke/mobux.log 2>&1 < /dev/null &
	@sleep 2 && lsof -i :$(MOBUX_SMOKE_PORT) >/dev/null 2>&1 \
		&& echo "smoke mobux running on port $(MOBUX_SMOKE_PORT) (data /tmp/mobux-smoke)" \
		|| { echo "smoke FAILED to start"; tail /tmp/mobux-smoke/mobux.log; exit 1; }

smoke-stop:
	@if [ -n "$(SMOKE_PID)" ]; then kill $(SMOKE_PID) && echo "smoke stopped (pid $(SMOKE_PID))"; else echo "smoke not running"; fi
	@tmux -L mobux-test kill-server 2>/dev/null || true

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
		MOBUX_URL=http://127.0.0.1:$(MOBUX_SMOKE_PORT) \
		MOBUX_USER=smoke MOBUX_PASS=00000 \
		npx playwright test test/smoke.spec.cjs

.PHONY: test-critical-path
test-critical-path:
	@$(MAKE) smoke-start
	@trap '$(MAKE) smoke-stop' EXIT; \
		MOBUX_URL=http://127.0.0.1:$(MOBUX_SMOKE_PORT) \
		MOBUX_USER=smoke MOBUX_PASS=00000 \
		npx playwright test test/critical-path.spec.cjs

# Self-updater script logic: snapshot / rollback / cargo-fail / abort paths
# against a dummy binary and stub cargo, in --no-systemd mode (no systemctl,
# no network, no prod anything). See test/update-runner.test.sh.
.PHONY: test-update-runner
test-update-runner:
	@command -v shellcheck >/dev/null 2>&1 && shellcheck src/update_runner.sh test/update-runner.test.sh || echo "shellcheck not installed; skipping lint"
	@bash test/update-runner.test.sh

# STT settings UX: run stt-ux.spec.cjs against the smoke instance.
# Uses MOBUX_STT_URL so the spec's openSettings() hits the smoke server.
.PHONY: test-stt-ux
test-stt-ux:
	@$(MAKE) smoke-start
	@trap '$(MAKE) smoke-stop' EXIT; \
		MOBUX_STT_URL=http://127.0.0.1:$(MOBUX_SMOKE_PORT) \
		MOBUX_STT_USER=smoke MOBUX_STT_PASS=00000 \
		npx playwright test test/stt-ux.spec.cjs

# STT per-kind persistence: run stt-per-kind.spec.cjs against the smoke instance.
.PHONY: test-stt-per-kind
test-stt-per-kind:
	@$(MAKE) smoke-start
	@trap '$(MAKE) smoke-stop' EXIT; \
		MOBUX_STT_URL=http://127.0.0.1:$(MOBUX_SMOKE_PORT) \
		MOBUX_STT_USER=smoke MOBUX_STT_PASS=00000 \
		npx playwright test test/stt-per-kind.spec.cjs

# SPA coverage: the Preact/Wouter UI served at /app on the smoke instance
# (built into web/static/spa by `make build`, which smoke-start depends on).
# Same isolated smoke instance + isolated MOBUX_DATA_DIR as the rest of the
# suite, so it never touches the live :5151 server or the live DB.
.PHONY: test-spa
test-spa:
	@$(MAKE) smoke-start
	@trap '$(MAKE) smoke-stop' EXIT; \
		MOBUX_URL=http://127.0.0.1:$(MOBUX_SMOKE_PORT) \
		MOBUX_USER=smoke MOBUX_PASS=00000 \
		npx playwright test test/spa.spec.cjs

# Fleet e2e (issue #176 phase 4): emulated fleet of throwaway sshd+tmux
# "nodes", each its own podman container (test/fleet/node.cjs,
# Containerfile.fleet-node — see issue #183 for why a container and not
# a host-native sshd), plus an isolated hub mobux on a random scratch
# port. sanity.spec.cjs proves the node harness alone; hub-proxy.spec.cjs
# drives the real browser → hub → ssh → tmux pipe with I/O round-trip
# and resize assertions. Boots its own instances, so no smoke-start —
# but the hub needs the built binary and embedded SPA, hence `build`.
.PHONY: test-fleet
test-fleet: build
	npx playwright test test/fleet

.PHONY: test-e2e
test-e2e:
	@$(MAKE) smoke-start
	@trap '$(MAKE) smoke-stop' EXIT; \
		MOBUX_URL=http://127.0.0.1:$(MOBUX_SMOKE_PORT) \
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
	echo "Rendering twa/twa-manifest.json (MOBUX_DOMAIN=$$MOBUX_DOMAIN, packageId=$(MOBUX_PACKAGE_ID), name=$(MOBUX_APP_NAME))"; \
	sed -e "s|__MOBUX_DOMAIN__|$$MOBUX_DOMAIN|g" \
		-e "s|__MOBUX_KEYSTORE_PATH__|$$KEYSTORE|g" \
		-e "s|__MOBUX_PACKAGE_ID__|$(MOBUX_PACKAGE_ID)|g" \
		-e "s|__MOBUX_APP_NAME__|$(MOBUX_APP_NAME)|g" \
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
	mkdir -p $(TWA_INSTALL_DIR); \
	cp "$$APK_SRC" $(TWA_INSTALL_DIR)/mobux.apk; \
	echo "Wrote $(TWA_INSTALL_DIR)/mobux.apk"; \
	FINGERPRINT="$$(keytool -list -v \
		-keystore "$$KEYSTORE" \
		-alias mobux \
		-storepass "$$KEYSTORE_PASSWORD" 2>/dev/null \
		| awk '/SHA256:/ {print $$2; exit}')"; \
	if [ -z "$$FINGERPRINT" ]; then \
		echo "Could not extract SHA-256 fingerprint from keystore." >&2; \
		exit 1; \
	fi; \
	mkdir -p $(TWA_WELLKNOWN_DIR); \
	printf '[{\n  "relation": ["delegate_permission/common.handle_all_urls"],\n  "target": {\n    "namespace": "android_app",\n    "package_name": "$(MOBUX_PACKAGE_ID)",\n    "sha256_cert_fingerprints": ["%s"]\n  }\n}]\n' "$$FINGERPRINT" > $(TWA_WELLKNOWN_DIR)/assetlinks.json; \
	echo "Wrote $(TWA_WELLKNOWN_DIR)/assetlinks.json (fingerprint $$FINGERPRINT)"; \
	if [ "$$FRESH_KEY" = "1" ]; then \
		echo ""; \
		echo "Reminder: back up $$KEYSTORE and $$PASSFILE before you forget."; \
	fi

# twa-dev: build the coexisting "Mobux Dev" app (package id ...mobux.dev, host
# sandbox:5152) into the repo-local staging dir twa/dist-dev/ so it never
# clobbers the prod web/static/install/mobux.apk. Reuses the same signing key.
twa-dev:
	@$(MAKE) twa \
		MOBUX_DOMAIN=$(MOBUX_DEV_DOMAIN) \
		MOBUX_PACKAGE_ID=io.github.mvhenten.mobux.dev \
		MOBUX_APP_NAME="Mobux Dev" \
		TWA_INSTALL_DIR=twa/dist-dev/install \
		TWA_WELLKNOWN_DIR=twa/dist-dev/.well-known
