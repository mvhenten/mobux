MOBUX_PORT ?= 5151
MOBUX_USER ?= $(USER)
MOBUX_PIN  ?= 30879
CARGO      := $(HOME)/.cargo/bin/cargo
PID        := $(shell lsof -ti :$(MOBUX_PORT) 2>/dev/null)

.PHONY: build run clean start stop restart status logs test web setup setup-twa twa

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

test:
	MOBUX_USER=$(MOBUX_USER) MOBUX_PASS=$(MOBUX_PIN) npx playwright test

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
	echo "Rendering twa/twa-manifest.json (MOBUX_DOMAIN=$$MOBUX_DOMAIN)"; \
	sed -e "s|__MOBUX_DOMAIN__|$$MOBUX_DOMAIN|g" \
		-e "s|__MOBUX_KEYSTORE_PATH__|$$KEYSTORE|g" \
		twa/twa-manifest.json.template > twa/twa-manifest.json; \
	if [ -d twa/app ]; then \
		echo "Updating existing TWA project (twa/app/)"; \
		( cd twa && bubblewrap update --manifest=twa-manifest.json ); \
	else \
		echo "Initializing new TWA project (twa/app/)"; \
		mkdir -p twa/app; \
		( cd twa/app && printf '%s\n%s\n' "$$KEYSTORE_PASSWORD" "$$KEYSTORE_PASSWORD" \
			| bubblewrap init --manifest=../twa-manifest.json ); \
	fi; \
	echo "Building signed APK"; \
	( cd twa/app && printf '%s\n%s\n' "$$KEYSTORE_PASSWORD" "$$KEYSTORE_PASSWORD" \
		| bubblewrap build ); \
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
