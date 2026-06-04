# GNOME AI UsageBar

GNOME AI UsageBar is a GNOME Shell extension for monitoring AI plan usage from
the top bar.

The project is inspired by
[akitaonrails/ai-usagebar](https://github.com/akitaonrails/ai-usagebar), but it
is not a Waybar module and it is not a wrapper around the Rust CLI.

## Status

Early GNOME 45+ implementation.

Implemented:

- GNOME Shell 45+ ES module extension entry point.
- Compact top-bar indicator.
- Detection for locally installed Claude Code and Codex CLIs.
- Dropdown with detected Claude and Codex tabs.
- GNOME-native preferences for default vendor and refresh interval.
- Manual and scheduled refresh placeholders.
- Shared usage state model for success and error states.
- Permissions-aware local cache for normalized usage state.
- GJS tests for usage state and cache behavior.

Planned:

- GNOME Keyring credential lookup.
- Vendor usage fetching for Anthropic Claude and OpenAI Codex/ChatGPT.
- Cache population from live vendor responses.
- GNOME 40-44 legacy extension entry point.

## GNOME Shell Compatibility

This project targets GNOME Shell 40 and newer.

- GNOME Shell 40-44 require the legacy extension module style.
- GNOME Shell 45+ require the newer ESM extension style.

Initial development is focused on GNOME Shell 45+ because the first target setup
is GNOME Shell 49. GNOME 40-44 support will be added after the GNOME 45+
implementation is working end to end.

## Local Development

Install the extension into your per-user extension directory:

```sh
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/ai-usagebar@miguins.com
```

Compile the GSettings schema for the symlinked development install:

```sh
glib-compile-schemas schemas
```

Run the local GJS tests:

```sh
gjs -m tests/run.js
```

Then enable it:

```sh
gnome-extensions enable ai-usagebar@miguins.com
```

If GNOME Shell does not list the extension immediately, log out and back in so
the shell reloads the extension directory.

Build a local extension bundle:

```sh
mkdir -p /tmp/gnome-ai-usagebar-pack
gnome-extensions pack \
  --force \
  --out-dir /tmp/gnome-ai-usagebar-pack \
  --schema=schemas/org.gnome.shell.extensions.ai-usagebar.gschema.xml \
  --extra-source=cache.js \
  --extra-source=usageState.js \
  --extra-source=vendors.js \
  --extra-source=assets/claude-symbolic.svg \
  --extra-source=assets/codex-symbolic.svg \
  .
```

## License

MIT. See `LICENSE` once added.
