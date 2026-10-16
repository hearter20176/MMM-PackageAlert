# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Home Assistant package: automation `package_alert_remote_clear` clears the front-door alert when button 4 of the Shelly BLU RC remote (ZHA) is pressed. README step 6 explains how to match your own remote.
- After a remote clear, `package_alert_email_parse` no longer re-raises the alert for a "delivered" email arriving within 45 minutes (it is still listed in `sensor.package_deliveries`).
- `package.json`: repository, homepage, bugs, license and keywords fields.
- README: Update section and trailing commas in the config examples.
- Node built-ins are imported with the `node:` scheme (for example `node:https`).
- ESLint (flat config) with an `npm run lint` script.
- Added CHANGELOG, CODE_OF_CONDUCT and a Dependabot configuration.

### Changed

- ESLint 10, with `defineConfig` in `eslint.config.mjs`; `npm run lint` runs `eslint` without the trailing `.`.
- Removed a dead assignment flagged by ESLint 10.
- `package.json`: lowercase package name, `"type": "commonjs"` and an author.
- ESLint reports unused catch bindings and arguments, and lints `package.json`, as modules.magicmirror.builders does.
- Fixed an intermittent test failure: the single-connection test now waits for the state snapshot, not just authentication.

## [1.0.0]

Released before this changelog was started. Commit history, newest first:

### 2026-10-03

- README: current screenshot and documentation review
- Parse real carrier mail formats; skip door alert for mailbox deliveries

### 2026-10-02

- Add MMM-PackageAlert: front-door package banner driven by Home Assistant
