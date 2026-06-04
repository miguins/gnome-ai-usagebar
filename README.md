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
- Dropdown tabs for detected Claude Code and Codex CLIs.
- Manual refresh from the dropdown.
- Scheduled background refresh.
- GSettings preferences for default vendor and refresh interval.
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

Compile the settings schema:

```sh
glib-compile-schemas schemas
```

Enable the extension:

```sh
gnome-extensions enable ai-usagebar@miguins.com
```

If GNOME Shell does not list the extension immediately, log out and back in so
the shell reloads the extension directory.

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

1. Vendor-managed OAuth files created by the local CLI.
2. GNOME Keyring/Secret Service OAuth documents.

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
- `refresh-interval-seconds`: background refresh interval, from 60 to 3600
  seconds.

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

If no vendor tab appears, make sure `claude` or `codex` is installed and visible
from your normal user session.

If the extension reports unsafe credential permissions, fix the credential file
and its directory so group and other permission bits are not set.

If usage stays cached, press **Refresh** in the dropdown. The extension avoids
unnecessary network requests when fresh cached data is available.

## License

MIT is intended for this project. Add the `LICENSE` file before distributing a
release package.
