/**
 * Unstable-network resilience plugin for DeepSeek Harness.
 *
 * Host-side levers that a plain configuration cannot reach:
 *  1. A tuned undici global dispatcher (longer HTTP keep-alive, patient TCP/TLS
 *     connect) so back-to-back agent steps reuse one warm connection instead of
 *     paying a fresh handshake after every >4s idle gap. Skipped automatically
 *     when proxy environment variables are present, so proxy routing stays ours.
 *  2. A lightweight reachability probe per configured provider baseURL, paced
 *     below the keep-alive window so the probe itself demonstrates warm reuse.
 *  3. An observer on `agent/request-error` that logs every model-request
 *     failure with its provider and failure code.
 *  4. HTTP measurement through undici's diagnostics channels: per host, how
 *     many requests reused a warm connection versus paid a fresh TCP+TLS
 *     handshake, with time-to-first-byte (TTFB) for both groups, plus
 *     connection-error counts.
 *  5. A read-only Inspect Provider (`unstable-network.status`) exposing all of
 *     the above plus whether the pi-ai providers carry retry / stream-idle
 *     tuning in the profile patch layer.
 *
 * Profile facts come from the `profileContext` service (launcher-owned), with
 * DSH_* environment variables as fallback for non-profile launches. The patch
 * scan re-runs on every status query, and the probe starts lazily once baseURLs
 * become known, so later tuning edits are reflected without a restart.
 *
 * The provider-level retry policy and stream idle timeout themselves live in
 * the profile's `cordis.patch.yml` (the `llm-pi-ai` row config); this plugin
 * only detects and reports that tuning.
 */

import { createRequire } from 'node:module'
import { readFileSync, accessSync, constants as fsConstants } from 'node:fs'
import diagnosticsChannel from 'node:diagnostics_channel'
import path from 'node:path'

export const name = 'unstable-network'
export const inject = ['cordisInspect']

const DEFAULTS = Object.freeze({
  /** Install a tuned undici global dispatcher (longer keep-alive, patient connect). */
  tuneDispatcher: true,
  /** Idle time a pooled connection may sit before undici closes it (default 4000 in undici). */
  keepAliveTimeoutMs: 55_000,
  /** Upper bound undici accepts from the server's Keep-Alive header. */
  keepAliveMaxTimeoutMs: 600_000,
  /** TCP + TLS connect timeout for outbound requests (default 10000 in undici). */
  connectTimeoutMs: 15_000,
  /** Probe each configured provider baseURL on an interval. */
  probeEnabled: true,
  /** Default sits below keepAliveTimeoutMs so every probe after the first reuses the warm socket. */
  probeIntervalMs: 45_000,
  /** Per-probe deadline; any HTTP status counts as reachable, only a network error does not. */
  probeTimeoutMs: 8_000,
  /** Log every agent model-request failure with provider and failure code. */
  logRetries: true,
  /** Track per-host request counts, warm/cold reuse, and TTFB via undici diagnostics. */
  observeHttp: true,
})

const NUMERIC_KEYS = ['keepAliveTimeoutMs', 'keepAliveMaxTimeoutMs', 'connectTimeoutMs', 'probeIntervalMs', 'probeTimeoutMs']
const BOOLEAN_KEYS = ['tuneDispatcher', 'probeEnabled', 'logRetries', 'observeHttp']

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Drop undefined-valued keys recursively. The Inspect registry's snapshot
 * rejects a whole payload when any value is undefined, unlike JSON.stringify.
 */
function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = pruneUndefined(item)
    }
    return out
  }
  return value
}

/** Minimal synchronous Standard-Schema validator so the loader accepts `Config` without a schemastery dependency. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-unstable-network',
    validate(value) {
      if (value === undefined || value === null) value = {}
      if (!isPlainObject(value)) {
        return { issues: [{ message: 'config must be an object' }] }
      }
      const out = { ...DEFAULTS, ...value }
      const issues = []
      for (const key of Object.keys(value)) {
        if (!(key in DEFAULTS)) issues.push({ message: `unknown key "${key}"`, path: [key] })
      }
      for (const key of NUMERIC_KEYS) {
        const v = out[key]
        if (!Number.isFinite(v) || v <= 0) {
          issues.push({ message: `${key} must be a positive finite number`, path: [key] })
        }
      }
      for (const key of BOOLEAN_KEYS) {
        if (typeof out[key] !== 'boolean') {
          issues.push({ message: `${key} must be a boolean`, path: [key] })
        }
      }
      if (issues.length === 0 && out.keepAliveTimeoutMs >= out.keepAliveMaxTimeoutMs) {
        issues.push({ message: 'keepAliveTimeoutMs must be less than keepAliveMaxTimeoutMs', path: ['keepAliveTimeoutMs'] })
      }
      if (issues.length > 0) return { issues }
      return { value: out }
    },
  },
}

const PROXY_ENV_NAMES = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
]

function proxyEnvPresent(env) {
  return PROXY_ENV_NAMES.some((name) => env[name] !== undefined && env[name] !== '')
}

function readable(file) {
  try {
    accessSync(file, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the user patch layer and the undici install anchor from the
 * launcher-owned profileContext, falling back to DSH_* environment variables
 * (injected into shells, often absent from the Host process itself) and the
 * running entry script.
 */
function resolveAnchors(profile) {
  const candidates = []
  if (profile?.patchPath) candidates.push({ patchPath: profile.patchPath, source: 'profileContext.patchPath' })
  if (profile?.dir) candidates.push({ patchPath: path.join(profile.dir, 'cordis.patch.yml'), source: 'profileContext.dir' })
  if (process.env.DSH_PROFILE_DIR) candidates.push({ patchPath: path.join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml'), source: 'env.DSH_PROFILE_DIR' })
  const patch = candidates.find((candidate) => readable(candidate.patchPath)) ?? null

  const undiciAnchors = []
  if (profile?.installAnchor) undiciAnchors.push({ anchor: profile.installAnchor, source: 'profileContext.installAnchor' })
  if (process.env.DSH_INSTALL_DIR) undiciAnchors.push({ anchor: process.env.DSH_INSTALL_DIR, source: 'env.DSH_INSTALL_DIR' })
  if (process.argv[1]) undiciAnchors.push({ anchor: path.dirname(process.argv[1]), source: 'process.argv[1]' })

  return {
    patch,
    patchSource: patch?.source ?? 'unavailable',
    undiciAnchors,
    profileFound: profile !== undefined && profile !== null,
  }
}

/**
 * Load the same undici copy the Harness ships so the dispatcher swap lands on
 * the well-known global symbol Node's built-in fetch reads.
 */
function loadUndici(undiciAnchors, logger) {
  const attempts = [...undiciAnchors]
  try {
    attempts.push({ anchor: process.cwd(), source: 'process.cwd()' })
  } catch { /* cwd unavailable in exotic embeddings */ }
  for (const { anchor, source } of attempts) {
    if (!anchor) continue
    try {
      const require = createRequire(path.join(anchor, 'package.json'))
      const undici = require('undici')
      return { undici, source }
    } catch (error) {
      logger?.info?.(`unstable-network: undici lookup via ${source} failed: ${error?.message ?? error}`)
    }
  }
  return undefined
}

/** Exported for tests: per-host HTTP observation over undici's diagnostics channels. */
export function createHttpObserver() {
  const started = new WeakMap()
  const hosts = new Map()
  const recent = []

  const statsOf = (host) => {
    let stats = hosts.get(host)
    if (stats === undefined) {
      stats = {
        requests: 0, responses: 0, cold: 0, warm: 0,
        newConnections: 0, connectErrors: 0,
        ttfbSum: 0, ttfbColdSum: 0, ttfbWarmSum: 0,
        lastConnectAt: undefined, last: undefined,
      }
      hosts.set(host, stats)
    }
    return stats
  }

  const subscriptions = [
    ['undici:client:connected', (message) => {
      const host = message?.connectParams?.host
      if (typeof host !== 'string' || host === '') return
      const stats = statsOf(host)
      stats.newConnections += 1
      stats.lastConnectAt = Date.now()
    }],
    ['undici:client:connectError', (message) => {
      const host = message?.connectParams?.host
      if (typeof host !== 'string' || host === '') return
      statsOf(host).connectErrors += 1
    }],
    ['undici:request:create', (message) => {
      const request = message?.request
      if (request === undefined || typeof request !== 'object') return
      const host = typeof request.host === 'string' && request.host !== '' ? request.host
        : typeof request.origin === 'string' ? request.origin.replace(/^https?:\/\//, '') : ''
      if (host === '') return
      statsOf(host).requests += 1
      started.set(request, { at: Date.now(), host })
    }],
    ['undici:request:headers', (message) => {
      const request = message?.request
      const start = request === undefined ? undefined : started.get(request)
      if (start === undefined) return
      started.delete(request)
      const stats = statsOf(start.host)
      const ms = Date.now() - start.at
      // A connection that reached `connected` at/after this request started paid a fresh handshake.
      const cold = stats.lastConnectAt !== undefined && stats.lastConnectAt >= start.at
      stats.responses += 1
      stats.ttfbSum += ms
      if (cold) {
        stats.cold += 1
        stats.ttfbColdSum += ms
      } else {
        stats.warm += 1
        stats.ttfbWarmSum += ms
      }
      const sample = {
        at: new Date().toISOString(),
        host: start.host,
        method: request.method,
        path: String(request.path ?? '').split('?')[0].slice(0, 60),
        status: message?.response?.statusCode,
        ms,
        cold,
      }
      stats.last = sample
      recent.push(sample)
      if (recent.length > 25) recent.shift()
    }],
  ]

  return {
    subscribe() {
      for (const [name, listener] of subscriptions) diagnosticsChannel.subscribe(name, listener)
    },
    unsubscribe() {
      for (const [name, listener] of subscriptions) {
        try { diagnosticsChannel.unsubscribe(name, listener) } catch { /* already gone */ }
      }
    },
    snapshot() {
      const byHost = {}
      for (const [host, stats] of hosts) {
        byHost[host] = {
          requests: stats.requests,
          responses: stats.responses,
          warm: stats.warm,
          cold: stats.cold,
          newConnections: stats.newConnections,
          connectErrors: stats.connectErrors,
          ttfbAvgMs: stats.responses > 0 ? Math.round(stats.ttfbSum / stats.responses) : undefined,
          ttfbWarmAvgMs: stats.warm > 0 ? Math.round(stats.ttfbWarmSum / stats.warm) : undefined,
          ttfbColdAvgMs: stats.cold > 0 ? Math.round(stats.ttfbColdSum / stats.cold) : undefined,
          last: stats.last,
        }
      }
      return { byHost, recent: recent.slice(-10) }
    },
  }
}

/**
 * Read the user patch layer and report provider tuning plus probe targets.
 * A pragmatic scan, not a YAML parser: the file is user-maintained and small.
 */
function scanProfilePatch(patchPath, profileFound) {
  const result = {
    profileFound,
    patchSource: 'unavailable',
    patchPath: undefined,
    patchFileFound: false,
    piAiEntryFound: false,
    streamIdleTimeoutMsSet: false,
    retryPolicyModes: [],
    maxRetriesValues: [],
    baseUrls: [],
  }
  if (patchPath === null) return result
  result.patchSource = patchPath.source
  result.patchPath = patchPath.patchPath
  let text
  try {
    text = readFileSync(patchPath.patchPath, 'utf8')
  } catch {
    return result
  }
  result.patchFileFound = true
  const lines = text.split('\n')
  let blockStart = -1
  let blockEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    const match = /^- id: (\S+)\s*$/.exec(lines[i])
    if (match === null) continue
    if (match[1] === 'llm-pi-ai') {
      blockStart = i
      continue
    }
    if (blockStart >= 0 && blockEnd === lines.length) {
      blockEnd = i
      break
    }
  }
  if (blockStart < 0) return result
  result.piAiEntryFound = true
  const block = lines.slice(blockStart, blockEnd).join('\n')
  result.streamIdleTimeoutMsSet = /(^|\s)streamIdleTimeoutMs:/.test(block)
  for (const match of block.matchAll(/retryPolicy:\s*$\n?[\s\S]*?mode:\s*(always|normal)/gm)) {
    result.retryPolicyModes.push(match[1])
  }
  for (const match of block.matchAll(/maxRetries:\s*(\d+)/g)) {
    result.maxRetriesValues.push(Number(match[1]))
  }
  for (const match of block.matchAll(/baseURL:\s*['"]?([^'"\s]+)['"]?/g)) {
    result.baseUrls.push(match[1])
  }
  result.baseUrls = [...new Set(result.baseUrls)]
  return result
}

export async function apply(ctx, config = {}) {
  const logger = ctx.logger
  const profile = ctx.get('profileContext')
  const anchors = resolveAnchors(profile)

  const state = {
    startedAt: new Date().toISOString(),
    anchors,
    dispatcher: { mode: 'disabled', reason: 'tuneDispatcher is false' },
    undiciSource: undefined,
    probe: {
      enabled: config.probeEnabled,
      targets: [],
      last: {},
      recent: [],
      probing: false,
      timerStarted: false,
    },
    providerTuning: scanProfilePatch(anchors.patch, anchors.profileFound),
    requestErrorsObserved: 0,
    http: config.observeHttp ? createHttpObserver() : undefined,
  }

  // ---- 1. Tuned global dispatcher ----------------------------------------
  if (config.tuneDispatcher) {
    if (proxyEnvPresent(process.env)) {
      state.dispatcher = { mode: 'skipped', reason: 'proxy environment variables detected; leaving routing untouched' }
      logger.warn('unstable-network: dispatcher tuning skipped — proxy environment variables are set')
    } else {
      const loaded = loadUndici(anchors.undiciAnchors, logger)
      if (loaded === undefined) {
        state.dispatcher = { mode: 'skipped', reason: 'undici could not be resolved (tried profileContext.installAnchor, env.DSH_INSTALL_DIR, process.argv[1], cwd)' }
        logger.warn('unstable-network: dispatcher tuning skipped — undici unavailable')
      } else {
        const { undici, source } = loaded
        state.undiciSource = source
        try {
          const previous = undici.getGlobalDispatcher()
          const agent = new undici.Agent({
            keepAliveTimeout: config.keepAliveTimeoutMs,
            keepAliveMaxTimeout: config.keepAliveMaxTimeoutMs,
            connect: { timeout: config.connectTimeoutMs },
          })
          undici.setGlobalDispatcher(agent)
          state.dispatcher = {
            mode: 'tuned',
            keepAliveTimeoutMs: config.keepAliveTimeoutMs,
            keepAliveMaxTimeoutMs: config.keepAliveMaxTimeoutMs,
            connectTimeoutMs: config.connectTimeoutMs,
          }
          logger.info(
            `unstable-network: tuned global HTTP dispatcher via ${source} (keepAliveTimeoutMs=${config.keepAliveTimeoutMs}, connectTimeoutMs=${config.connectTimeoutMs})`,
          )
          ctx.effect(() => async () => {
            try {
              undici.setGlobalDispatcher(previous)
              await agent.close()
              logger.info('unstable-network: restored previous HTTP dispatcher')
            } catch (error) {
              logger.warn(`unstable-network: dispatcher restore failed: ${error?.message ?? error}`)
            }
          }, 'unstable-network: restore previous HTTP dispatcher')
        } catch (error) {
          state.dispatcher = { mode: 'skipped', reason: `dispatcher install failed: ${error?.message ?? error}` }
          logger.warn(`unstable-network: dispatcher tuning failed: ${error?.message ?? error}`)
        }
      }
    }
  }

  // ---- 2. Reachability probe (lazy: starts once targets are known) --------
  const ensureProbe = () => {
    if (!config.probeEnabled || state.probe.timerStarted) return
    const targets = state.providerTuning.baseUrls
    state.probe.targets = targets
    if (targets.length === 0) return
    state.probe.timerStarted = true
    const probeOnce = async () => {
      if (state.probe.probing) return
      state.probe.probing = true
      try {
        for (const base of state.probe.targets) {
          const url = base.replace(/\/+$/, '') + '/models'
          const started = Date.now()
          const entry = { at: new Date().toISOString(), url, reachable: false }
          try {
            const response = await fetch(url, {
              method: 'GET',
              signal: AbortSignal.timeout(config.probeTimeoutMs),
              headers: { accept: 'application/json' },
            })
            entry.reachable = true
            entry.status = response.status
          } catch (error) {
            entry.error = error?.name === 'TimeoutError'
              ? `no response within ${config.probeTimeoutMs}ms`
              : String(error?.message ?? error)
          }
          entry.ms = Date.now() - started
          state.probe.last[url] = entry
          state.probe.recent.push(entry)
          if (state.probe.recent.length > 30) state.probe.recent.shift()
          if (!entry.reachable) {
            logger.warn(`unstable-network: probe failed for ${url}: ${entry.error}`)
          }
        }
      } finally {
        state.probe.probing = false
      }
    }
    const timer = setInterval(() => { void probeOnce() }, config.probeIntervalMs)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'unstable-network: probe interval')
    void probeOnce()
  }

  // Re-scan the patch layer; status queries refresh tuning detection too.
  const refreshTuning = () => {
    state.providerTuning = scanProfilePatch(anchors.patch, anchors.profileFound)
    ensureProbe()
  }
  refreshTuning()
  if (config.probeEnabled && state.providerTuning.baseUrls.length === 0) {
    logger.warn('unstable-network: probe waiting — no provider baseURL discovered yet; will retry on status queries')
  }

  // ---- 3. Model-request failure observer ---------------------------------
  if (config.logRetries) {
    const dispose = ctx.on('agent/request-error', (payload, next) => {
      state.requestErrorsObserved += 1
      const code = payload?.failure?.code ?? 'UNKNOWN'
      const detail = payload?.failure?.message ?? ''
      logger.warn(
        `unstable-network: model request failed (provider=${payload?.provider ?? '?'} code=${code} turn=${payload?.turn ?? '?'} step=${payload?.step ?? '?'})${detail ? `: ${detail}` : ''}`,
      )
      return next()
    })
    ctx.effect(() => dispose, 'unstable-network: request-error observer')
  }

  // ---- 4. HTTP measurement via undici diagnostics -------------------------
  if (state.http !== undefined) {
    state.http.subscribe()
    ctx.effect(() => () => state.http.unsubscribe(), 'unstable-network: http diagnostics observer')
  }

  // ---- 5. Inspect provider ------------------------------------------------
  ctx.effect(() => ctx.cordisInspect.register({
    manifest: {
      id: 'unstable-network',
      description: 'Live status of the unstable-network resilience plugin: HTTP dispatcher tuning, provider reachability probes, warm/cold connection reuse with TTFB, and pi-ai retry tuning detection. Call with no input.',
      methods: [{
        name: 'status',
        description: 'Return the dispatcher mode, probe history, per-host warm/cold request counts with TTFB averages, observed request failures, and whether the profile patch layer carries pi-ai retry/stream tuning. Also refreshes the patch scan.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object' },
      }],
    },
    async query(methodName, input) {
      if (methodName !== 'status') {
        throw new Error(`unstable-network has no inspect method "${methodName}"`)
      }
      refreshTuning()
      const tuning = state.providerTuning
      const providerHosts = new Set()
      for (const base of tuning.baseUrls) {
        try { providerHosts.add(new URL(base).host) } catch { /* skip malformed */ }
      }
      const snapshot = state.http?.snapshot()
      const byHost = {}
      if (snapshot !== undefined) {
        for (const [host, stats] of Object.entries(snapshot.byHost)) {
          byHost[host] = { ...stats, provider: providerHosts.has(host) }
        }
      }
      return pruneUndefined({
        startedAt: state.startedAt,
        now: new Date().toISOString(),
        profileContext: {
          found: anchors.profileFound,
          name: profile?.name,
          dir: profile?.dir,
          patchPath: profile?.patchPath,
          installAnchor: profile?.installAnchor,
        },
        patch: {
          source: tuning.patchSource,
          path: tuning.patchPath,
          fileFound: tuning.patchFileFound,
        },
        dispatcher: { ...state.dispatcher },
        undiciResolvedVia: state.undiciSource,
        probe: {
          enabled: state.probe.enabled,
          running: state.probe.timerStarted,
          intervalMs: config.probeIntervalMs,
          targets: [...state.probe.targets],
          last: JSON.parse(JSON.stringify(state.probe.last)),
          recent: state.probe.recent.slice(-10),
        },
        http: {
          observed: state.http !== undefined,
          byHost,
          recent: snapshot?.recent ?? [],
        },
        providerTuning: {
          piAiEntryFound: tuning.piAiEntryFound,
          streamIdleTimeoutMsSet: tuning.streamIdleTimeoutMsSet,
          retryPolicyModes: [...tuning.retryPolicyModes],
          maxRetriesValues: [...tuning.maxRetriesValues],
          baseUrls: [...tuning.baseUrls],
        },
        requestErrorsObserved: state.requestErrorsObserved,
      })
    },
  }), 'unstable-network: inspect provider')

  logger.info('unstable-network: active — dispatcher tuning, probe, HTTP measurement, and retry observability are managed by config')
}
