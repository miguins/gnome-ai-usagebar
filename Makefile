PACK_DIR ?= /tmp/gnome-ai-usagebar-pack
PACK_SCHEMA := schemas/org.gnome.shell.extensions.ai-usagebar.gschema.xml
PACK_SOURCES := \
	LICENSE \
	lib \
	assets

.PHONY: check clean pack schema syntax test

check: syntax schema test pack

syntax:
	node --check extension.js

schema:
	glib-compile-schemas --strict schemas

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
