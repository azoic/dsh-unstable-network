# DSH Unstable Network

Unstable-network resilience for the DeepSeek Harness Host: tuned HTTP
keep-alive, a provider reachability probe, model-request failure logging, and a
live `unstable-network.status` inspect provider. See `docs/DETAIL.md` for
behavior, config, and limits (Persian version: `docs/DETAIL.fa.md`).

## Requirements

- DeepSeek Harness `>= 0.2.2-rc.5 < 0.3.0` (declared as `engines.dsh` in
  `package.json`; DSH refuses installation on other versions).
- The `undici` copy shipped with the dsh installation: the plugin reuses it so
  the dispatcher swap lands on the same global symbol Node's built-in `fetch`
  reads. When that copy cannot be found, the dispatcher step reports
  `skipped` with the reason and every other feature keeps working.

## Install from Git

- **Web UI:** open **Plugins** and add the plugin with the repository URL
  `https://github.com/Azoic/dsh-unstable-network`, or pin an exact version with
  `git+https://github.com/Azoic/dsh-unstable-network.git#<40-character-commit>`.
- **Agent tool:** `plugin_manager` `install_bundle` with the same spec as
  `target`.
- **Local checkout:** point **Plugins › Add plugin** at a cloned directory of
  this repository.

Git installations are pinned to the commit current at install time and are not
auto-updated; watch this repository's `v*` tags for new releases and reinstall
to move to one.

## Provider-level retry tuning (optional)

The provider-level retry and stream-idle tuning this plugin detects in its
`status` output (`providerTuning`) is not something the bundle layer can
authoritatively set: your own profile patch (`cordis.patch.yml`) overrides
bundle layers. Give your `llm-pi-ai` provider rows in the profile patch a
`retryPolicy` and a `streamIdleTimeoutMs` to tune them; `status` then reports
them.

## License

MIT — see [LICENSE](LICENSE).
