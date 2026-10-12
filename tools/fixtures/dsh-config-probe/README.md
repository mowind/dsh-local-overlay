# Probe bundle (`@dsh-local-overlay/e2e-config-probe`)

A third-party plugin the end-to-end suite introduces into an isolated profile exactly
the way a real one arrives: `npm pack` over this directory, then
`dsh plugin add <tarball> --profile <profile>`. It exists to answer one question for
issue #5 — can the **original** Plugins page read and save a plugin's configuration
that neither the replacement nor its settings package knows anything about?

## Why it looks like this

* `lib/index.js` (Host half) declares only `name`, `Config`, `inject`, and an empty
  `apply`. The row id it is inserted under (`e2e-config-probe`) is the settings
  namespace, and the two `.volatile()` fields are the form's fields. No client
  package lists this plugin anywhere.
* `lib/client.js` (browser half) is a hand-written `window.__ModuleLoader__.load`
  bundle. It registers one page into the Plugins page's standard
  `plugins.bundle.config` slot, keyed by this package's name, and builds the form out
  of the shared primitives (`SettingsForm`, `SettingsValueField`,
  `SettingsFormModel`) exactly as the shipped `ui-settings-web-search` page does.
  It requires nothing but the platform baseline, so it loads under both the original
  and the replacement composition.
* `attempts` is constrained to 1–9 while the client control only checks that a draft
  is a finite number, which lets the suite send the Host a value it must refuse.

## What it is not

It is not part of the overlay's provenance (`tools/lib/preflight.mjs` records only
`packages/dsh-client-ui-settings` and `packages/dsh-web-composition`), and it is never
installed into the profile this session runs in.
