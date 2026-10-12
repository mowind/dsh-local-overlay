## Agent skills

### Issue tracker

Issues and specs live as GitHub issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to identically-named labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Verification

### E2E runs

Run `tools/e2e-remote-settings.mjs` on a profile of its own: `DSH_PROFILE=e2e node tools/e2e-remote-settings.mjs` (the script names its profile from that variable, default `e2e`), or a copy of a profile in a temporary directory. The profile this session was booted in (`$DSH_HOME/profiles/$DSH_PROFILE`) stays byte-identical.
