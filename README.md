# GNOME AI UsageBar

GNOME AI UsageBar is a GNOME Shell extension for monitoring AI plan usage from
the top bar.

The project is inspired by
[akitaonrails/ai-usagebar](https://github.com/akitaonrails/ai-usagebar), but it
is not a Waybar module and it is not a wrapper around the Rust CLI.

## Screenshots

![AI UsageBar dropdown showing organized usage metrics](docs/usage_bar.png)

![AI UsageBar in the GNOME top bar](docs/usage_bar_desktop.png)

## Status

Early GNOME 45+ implementation.

Implemented:

- GNOME Shell 45+ ES module extension entry point.
- Compact top-bar indicator.
- Detection for locally installed Claude Code and Codex CLIs.
- Dropdown with detected Claude and Codex tabs.
- GNOME-native preferences for default vendor and refresh interval.
- Manual and scheduled refresh.
- Shared usage state model for success and error states.
- Permissions-aware local cache for normalized usage state.
- Initial live usage fetching from Claude and Codex CLI-managed OAuth credentials.
- Owner-only permission checks for local credential files before reading or
  refreshing tokens.
- GNOME Keyring/Secret Service lookup for vendor OAuth documents when
  CLI-managed credential files are absent.
- GNOME Keyring/Secret Service write-back when keyring-loaded OAuth tokens are
  refreshed.
- Cache population from normalized live usage results.
- GJS tests for usage state, cache, and credential behavior.

Planned:

- GNOME 40-44 legacy extension entry point.

## Credential Security

The extension does not store API keys or OAuth tokens in GSettings, project
files, logs, or shell environment variables.

For the current live usage implementation, credentials are read from Claude and
Codex CLI-managed OAuth files only after verifying that the credential path is a
regular file and that group/other permission bits are not set. Refreshed tokens
are written back through a temporary file and forced to owner-only permissions.

If the vendor-managed credential file is absent, the extension looks for an
OAuth document in GNOME Keyring/Secret Service. Keyring-loaded OAuth documents
are written back to Keyring after token refresh, not copied into project config
or GSettings.

The extension's Secret Service schema name is:

```text
schema: com.miguins.ai_usagebar.Credentials
```

Lookup matches keyring items by this attribute set, so user-managed entries
should use the same attributes:

```text
application: ai-usagebar@miguins.com
vendor: anthropic | openai
kind: oauth-document
```

The item secret is the vendor OAuth document JSON. Treat it as sensitive: do not
paste it into issue reports, logs, shell history, or project files. If neither a
safe vendor-managed credential source nor a Secret Service credential is
available, the extension fails closed with an unauthenticated state.

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
  --extra-source=credentialStore.js \
  --extra-source=usageState.js \
  --extra-source=vendorUsage.js \
  --extra-source=vendors.js \
  --extra-source=assets/claude-symbolic.svg \
  --extra-source=assets/codex-symbolic.svg \
  .
```

## License

MIT. See `LICENSE` once added.
