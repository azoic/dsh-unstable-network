# @local/dsh-unstable-network

Unstable-network resilience for the DeepSeek Harness Host: tuned HTTP
keep-alive, a provider reachability probe, model-request failure logging, and a
live `unstable-network.status` inspect provider. See `docs/DETAIL.md` for
behavior, config, and limits.

The provider-level retry and stream-idle tuning this plugin recommends lives in
the profile patch layer (`cordis.patch.yml`, `llm-pi-ai` row) because the
user's own patch overrides bundle layers.
