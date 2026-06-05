# GNOME AI UsageBar

GNOME AI UsageBar is a GNOME Shell extension that shows AI plan usage in the top
bar.

It is inspired by
[akitaonrails/ai-usagebar](https://github.com/akitaonrails/ai-usagebar), but it
is a GNOME-native GJS extension. It does not require the upstream Rust binary at
runtime.

## Screenshots

![AI UsageBar dropdown showing organized usage metrics](docs/usage_bar.png)

![AI UsageBar in the GNOME top bar](docs/usage_bar_desktop.png)

## Current Status

The current implementation targets GNOME Shell 45 and newer. The extension
metadata declares support through GNOME Shell 50, the latest stable GNOME line as
of June 2026.

Implemented:

- Compact top-bar indicator.
- GNOME Shell 45-50 ES module extension entry point.
- Dropdown tabs for enabled Claude and Codex providers.
- Manual refresh from the dropdown.
- Scheduled background refresh.
- GSettings preferences for default vendor, enabled providers, credential paths,
  and refresh interval.
- Live usage loading for Claude and Codex/ChatGPT through vendor-managed OAuth
  credentials.
- GNOME Keyring/Secret Service fallback for OAuth documents.
- Owner-only permission checks for credential and cache files.
- Local normalized cache for usage responses.
- Clear states for unauthenticated, rate-limited, offline, malformed response,
  cache error, and unsupported account cases.
- GJS tests for state, cache, credentials, parsing, and mocked refresh flows.

Planned:

- GNOME Shell 40-44 legacy extension entry point.

## Install For Local Development

Link this checkout into your per-user GNOME Shell extension directory:

```sh
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/ai-usagebar@miguins.com
```

The repository includes `schemas/gschemas.compiled`, so a fresh checkout does
not need a schema compilation step before enabling the extension. If you edit
the schema XML during development, regenerate it manually:

```sh
glib-compile-schemas schemas
```

Enable the extension:

```sh
gnome-extensions enable ai-usagebar@miguins.com
```

If GNOME Shell does not list the extension immediately, log out and back in so
the shell reloads the extension directory.

## Manual Install

A bundler is not required for a personal install. GNOME Shell can load an
unpacked extension directory directly from:

```text
~/.local/share/gnome-shell/extensions/ai-usagebar@miguins.com
```

The directory name must match the `uuid` in `metadata.json`.

From a cloned checkout or an extracted source archive, copy the project into the
GNOME Shell extensions directory:

```sh
mkdir -p ~/.local/share/gnome-shell/extensions
cp -a "$PWD" ~/.local/share/gnome-shell/extensions/ai-usagebar@miguins.com
```

The copied directory already includes the compiled settings schema. If you copy
from a source that does not include `schemas/gschemas.compiled`, compile the
schema manually:

```sh
glib-compile-schemas \
  ~/.local/share/gnome-shell/extensions/ai-usagebar@miguins.com/schemas
```

Enable the extension:

```sh
gnome-extensions enable ai-usagebar@miguins.com
```

If you are replacing an existing copy, disable the extension first, replace the
`ai-usagebar@miguins.com` directory with the new source, and then enable the
extension. Log out and back in if GNOME Shell does not pick up the new files
immediately.

## Run Checks

Use the Make targets for the normal local workflow:

```sh
make test
make schema
make pack
make check
```

What they do:

- `make test` runs the GJS test suite.
- `make schema` validates the GSettings schema in strict dry-run mode.
- `make pack` creates a local extension zip in `/tmp/gnome-ai-usagebar-pack`.
- `make check` runs schema validation, tests, and packaging.

You can still run the commands directly:

```sh
gjs -m tests/run.js
glib-compile-schemas --strict --dry-run schemas
```

## Build A Bundle

This step is optional for local installs. Use it when you want a distributable
GNOME Shell extension zip.

```sh
make pack
```

The bundle is written to:

```text
/tmp/gnome-ai-usagebar-pack/ai-usagebar@miguins.com.shell-extension.zip
```

To use another output directory:

```sh
make pack PACK_DIR=/tmp/my-extension-pack
```

## Credentials And Privacy

The extension does not store API keys or OAuth tokens in GSettings, project
files, logs, or shell environment variables.

Credential lookup order:

1. A configured credential file path, when set.
2. The default vendor-managed OAuth file, when no custom path is set.
3. GNOME Keyring/Secret Service OAuth documents.

A custom credential path overrides the default vendor-managed path.

The extension reads CLI-managed credential files only when the credential file
is owner-only and its directory is not writable by group or other users.
Refreshed credential files are written through private temporary files and
atomically moved into place.

Secret Service entries should use this schema name:

```text
com.miguins.ai_usagebar.Credentials
```

Lookup attributes:

```text
application: ai-usagebar@miguins.com
vendor: anthropic | openai
kind: oauth-document
```

The item secret is the vendor OAuth document JSON. Treat it as sensitive.

Usage cache files are stored under the user cache directory and are also
owner-only. Unsafe cache permissions are treated as a cache error rather than
being read.

## Settings

The extension stores only non-sensitive preferences in GSettings:

- `selected-vendor`: the vendor shown by default.
- `anthropic-enabled`: whether Claude appears in the dropdown.
- `anthropic-credentials-path`: optional Claude credentials file path. Leave
  empty to use `~/.claude/.credentials.json`.
- `openai-enabled`: whether Codex appears in the dropdown.
- `openai-codex-auth-path`: optional Codex auth file path. Leave empty to use
  `~/.codex/auth.json`.
- `refresh-interval-seconds`: background refresh interval, from 60 to 3600
  seconds.
- `dropdown-opacity-percent`: extension dropdown opacity, from 35 to 100
  percent.
- `follow-system-theme`: whether badges, progress bars, and controls should use
  GNOME Shell theme colors instead of the built-in usage colors. Defaults to
  `false`.

The default refresh interval is 300 seconds.

## Project Layout

- `extension.js`: GNOME Shell 45+ panel indicator and dropdown UI.
- `prefs.js`: preferences window.
- `vendorUsage.js`: public vendor refresh dispatcher.
- `anthropicUsage.js` and `openAIUsage.js`: vendor-specific parsing and refresh
  flows.
- `vendorHttp.js`: Soup request handling and HTTP status mapping.
- `vendorCredentials.js`: credential source lookup and safe credential writes.
- `vendorFormat.js`: shared usage metric formatting.
- `fileSecurity.js`: permission checks and private file writes.
- `cache.js`: normalized local usage cache.
- `usageState.js`: shared usage state model.
- `vendors.js`: vendor identifiers and CLI detection.
- `tests/run.js`: GJS test runner.

## Troubleshooting

If no vendor tab appears, enable at least one provider in the extension
preferences.

If the extension reports unsafe credential permissions, fix the credential file
and its directory so group and other permission bits are not set.

If usage stays cached, press **Refresh** in the dropdown. The extension avoids
unnecessary network requests when fresh cached data is available.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
