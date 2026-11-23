# Unstable network resilience

Keeps the DeepSeek Harness **Host → AI-server** leg resilient when the internet
link is unstable (mobile data, wireless backhaul, high packet loss).

## What it does

1. **Tuned HTTP dispatcher** — replaces undici's global dispatcher with one whose
   idle keep-alive window is 55 s (undici default: **4 s**) and whose TCP/TLS
   connect timeout is 15 s (default: 10 s). Agent loops issue model requests
   back-to-back; tool steps and long reads usually exceed 4 s of idle time, so
   with defaults every step pays a fresh TCP + TLS handshake. The tuned window
   lets consecutive steps reuse one warm connection.
2. **Reachability probe** — every 60 s the plugin issues a small unauthenticated
   `GET /models` to each provider `baseURL` it finds in the profile patch layer.
   Any HTTP status counts as reachable; only a network failure does not. Results
   feed the status method and the Host log.
3. **Failure observability** — observes `agent/request-error` and logs provider,
   failure code, turn and step for every failed model request.
4. **HTTP measurement** — subscribes to undici's diagnostics channels and, per
   host, counts requests that **reused a warm connection** versus requests that
   paid a fresh TCP+TLS handshake, with time-to-first-byte (TTFB) averages for
   both groups, new-connection and connection-error counts, and the last 10
   samples.
5. **Live status** — a read-only Inspect Provider, `unstable-network` with the
   `status` method, reports:
   - `dispatcher`: `tuned`, `skipped` (with reason), or `disabled`;
   - `probe`: targets, per-target last result, last 10 events;
   - `http`: per-host warm/cold counts, TTFB averages, connect errors, samples;
   - `providerTuning`: whether the profile's `cordis.patch.yml` gives the
     `llm-pi-ai` providers a `retryPolicy` and `streamIdleTimeoutMs`;
   - `requestErrorsObserved` since activation.

Call it with the Inspect tools as `platform: host, provider: unstable-network,
method: status` with **no input**.

## How to measure the impact

1. Work normally in a session for a few minutes (several tool steps), then read
   `status`. For each provider host (`provider: true`), the `warm` vs `cold`
   counts show how many requests reused a warm connection, and
   `ttfbWarmAvgMs` against `ttfbColdAvgMs` quantifies the per-request saving.
2. The probe shows the same effect by itself: the default 45 s interval sits
   below the 55 s keep-alive window, so the first probe pays the handshake and
   the following ones do not.
3. Measured on a real link: warm ≈ 17 ms, cold ≈ 208 ms.
4. During a real outage the Host log shows each failure with its code
   (`TRANSPORT`/`TIMEOUT`/…), `requestErrorsObserved` climbs, and
   `http.byHost[*].connectErrors` counts failed handshakes.

## Deliberate limits

- **Proxy guard:** if any `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` /
  `NO_PROXY` variable (either casing) is set in the Host environment, dispatcher
  tuning is skipped and logged, because installing a direct dispatcher would
  displace the Harness proxy policy. The probe, logging, and status keep working.
- **No retry logic of its own.** Retries already exist (`llm-retry`); the
  recommended *tuning* of that policy (more retries, longer backoff, shorter
  stream idle timeout) belongs in the profile's `cordis.patch.yml` on the
  `llm-pi-ai` row, because the user's own patch layer overrides bundle layers.
  The status method reports whether that tuning is present.
- **Config:** `tuneDispatcher` (default true), `keepAliveTimeoutMs` (55000),
  `keepAliveMaxTimeoutMs` (600000), `connectTimeoutMs` (15000),
  `probeEnabled` (true), `probeIntervalMs` (60000), `probeTimeoutMs` (8000),
  `logRetries` (true).

## Verification

After installation, call `unstable-network.status` through
`cordis_inspect_query`; expect `dispatcher.mode` to be `tuned` (direct) or
`skipped` with a reason (proxied environment), and `probe.last` entries for
each provider baseURL.
