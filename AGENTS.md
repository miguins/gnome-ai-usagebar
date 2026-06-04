# Repository Instructions

## Project

This repository contains `ai-usagebar@miguins.com`, a GNOME Shell extension that
monitors AI plan usage from the GNOME top bar.

The project is inspired by `akitaonrails/ai-usagebar`, but the implementation
goal is a GNOME-native GJS extension, not a wrapper around the Rust CLI.

Current implementation status: GNOME Shell 45+ is implemented, with metadata
declaring support through the latest stable GNOME Shell line tracked by the
project. GNOME Shell 40-44 legacy glue is planned and should stay separate when
it is introduced.

## Goals

- Provide a compact GNOME top-bar indicator for AI usage.
- Support GNOME Shell 40 and newer.
- Keep `metadata.json` updated for the latest stable GNOME Shell line after
  checking GNOME's release information and local compatibility assumptions.
- Use GJS and GNOME platform APIs.
- Support Anthropic Claude and OpenAI Codex/ChatGPT for the MVP.
- Use one compact indicator with vendor tabs in the panel dropdown.
- Use GNOME-native settings for non-sensitive configuration.
- Keep secrets out of project files, logs, GSettings, and shell environment by
  default.
- Cache usage responses and refresh conservatively to avoid unnecessary network
  requests and rate limits.

## Non-Goals

- Reimplement Waybar integration.
- Ship a terminal UI.
- Require the original Rust `ai-usagebar` binary at runtime.
- Store API keys or OAuth tokens in plain text config files.
- Support Z.AI, OpenRouter, or other vendors in the MVP.

## MVP Scope

- A panel indicator showing the selected vendor and current usage summary.
- A dropdown with tabs for Anthropic Claude and OpenAI Codex/ChatGPT.
- Manual refresh from the dropdown.
- Background refresh with a default interval of 300 seconds.
- Local response cache to reduce repeated API calls.
- Secure credential access through GNOME Keyring or existing vendor-managed
  credentials without copying secrets into project config.
- Clear error states for unauthenticated, rate-limited, offline, and unsupported
  account scenarios.

## Language

- Write code, documentation, comments, commit messages, and user-facing strings
  in English.
- Avoid local personal information in examples, fixtures, docs, and commit
  metadata.

## Architecture

- Use GJS and GNOME platform APIs.
- Support GNOME Shell 40 and newer.
- Keep GNOME 40-44 legacy extension glue separate from GNOME 45+ ESM glue.
- Put shared vendor, cache, formatting, and security-sensitive logic in modules
  that can be reused across shell-version entry points.
- Keep the GNOME Shell entry point focused on UI and lifecycle behavior.
- Keep vendor logic split by responsibility:
  - `vendorUsage.js` dispatches refreshes and preserves public exports.
  - `anthropicUsage.js` and `openAIUsage.js` hold vendor-specific parsing and
    refresh flows.
  - `vendorHttp.js` owns Soup request handling and HTTP status mapping.
  - `vendorCredentials.js` owns credential lookup, validation, and write-back.
  - `vendorFormat.js` owns shared usage metric formatting.
  - `fileSecurity.js` owns owner-only permission checks and private file writes.
- Do not require the upstream Rust `ai-usagebar` binary at runtime.
- MVP vendors are Anthropic Claude and OpenAI Codex/ChatGPT only.
- Use one compact panel indicator with vendor tabs in the dropdown.
- Use GNOME-native settings for non-sensitive preferences.

## Security And Privacy

- Treat credentials, tokens, account identifiers, raw API responses, and usage
  details as sensitive.
- Store secrets only through the desktop Secret Service, such as GNOME Keyring.
- Do not store secrets in GSettings, plain text config files, fixtures, logs, or
  environment-variable examples.
- Do not commit generated local state, credentials, real vendor responses, or
  machine-specific paths.
- Do not print secrets or raw vendor responses in normal logs.
- Redact sensitive values in tests, logs, screenshots, and issue examples.
- Prefer least-privilege request scopes and short-lived in-memory handling.
- Validate cache file permissions before reading sensitive cache data.
- Keep network requests explicit, minimal, and vendor-scoped.
- Fail closed when credential state, cache permissions, or response integrity is
  unclear.

## Git

- Use conventional commits.
- Keep commits atomic: one logical change per commit.
- Do not mix formatting-only changes with behavioral changes.
- Do not amend or rewrite history unless explicitly requested.
- Before committing, inspect the diff for secrets, local paths, and unrelated
  changes.

## Code Quality

- Prefer simple, testable modules over large shell-specific files.
- Keep compatibility shims small and documented.
- Add tests for parsing, formatting, caching, credential handling, and error
  mapping when those modules are introduced.
- Add mocked refresh-flow tests for vendor HTTP and token refresh behavior.
- Avoid adding dependencies unless they materially improve security,
  compatibility, or maintainability.
- Use clear error states for unauthenticated, rate-limited, offline, malformed
  response, and unsupported account scenarios.
- Run `make check` before considering broad changes complete. It validates the
  schema, runs the GJS tests, and packages the extension.

## Documentation

- Keep README instructions accurate for the current implementation status.
- Mark planned features as planned until they are implemented.
- Document security-relevant design choices when they are made.
- Do not document local-only tooling, aliases, paths, or machine-specific setup.
- Keep user-facing documentation approachable: start with what works, how to run
  it, how credentials are handled, and how to verify changes.
