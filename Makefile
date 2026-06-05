PACK_DIR ?= /tmp/gnome-ai-usagebar-pack
PACK_SCHEMA := schemas/org.gnome.shell.extensions.ai-usagebar.gschema.xml
PACK_SOURCES := \
	LICENSE \
	anthropicUsage.js \
	cache.js \
	credentialStore.js \
	fileSecurity.js \
	openAIUsage.js \
	usageState.js \
	vendorCredentials.js \
	vendorErrors.js \
	vendorFormat.js \
	vendorHttp.js \
	vendorUsage.js \
	vendors.js \
	assets/claude-symbolic.svg \
	assets/codex-symbolic.svg

.PHONY: check clean pack schema syntax test

check: syntax schema test pack

syntax:
	node --check extension.js

schema:
	glib-compile-schemas --strict --dry-run schemas

test:
	gjs -m tests/run.js

pack:
	mkdir -p "$(PACK_DIR)"
	gnome-extensions pack \
		--force \
		--out-dir "$(PACK_DIR)" \
		--schema="$(PACK_SCHEMA)" \
		$(foreach source,$(PACK_SOURCES),--extra-source="$(source)") \
		.

clean:
	rm -rf "$(PACK_DIR)"
