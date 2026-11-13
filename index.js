/*
 * Host half of `find-in-chat`.
 *
 * The browser searches the open conversation, but only the Host can read the
 * complete Session log: the page holds just the history window Chat has
 * loaded. This route answers `GET /find-in-chat/search` from the same Session
 * query service the sidebar's session search uses, and keeps one parsed
 * document list per Session until the log grows.
 */

import { buildSessionDocuments, findMatches } from './lib/search.js'

export const name = 'find-in-chat'
export const inject = ['webServer', 'sessionQuery', 'sessions']

const SESSION_ID_MAX = 200
const QUERY_MAX = 200
const DOCUMENT_CACHE_LIMIT = 4
const DOCUMENT_CACHE_TTL_MS = 5000

/** @type {Map<string, { seq: number, documents: unknown[], at: number }>} */
const cache = new Map()

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Keep the cache small; the open conversation is normally the only entry. */
function cacheDocumentList(sessionId, seq, documents) {
  cache.delete(sessionId)
  cache.set(sessionId, { seq, documents, at: Date.now() })
  while (cache.size > DOCUMENT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * Read and project one Session's documents, preferring a cached list while the
 * live log has not grown.
 *
 * @param ctx - owning plugin context.
 * @param sessionId - Session to read.
 * @returns searchable documents.
 */
async function documentsFor(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId)
  const seq = live !== undefined && typeof live.seq === 'number' ? live.seq : null
  const cached = cache.get(sessionId)
  if (cached !== undefined) {
    if (seq !== null && cached.seq === seq) return cached.documents
    // A cold Session has no live seq to compare; a short TTL keeps repeated
    // keystrokes from replaying the same log.
    if (seq === null && Date.now() - cached.at < DOCUMENT_CACHE_TTL_MS) return cached.documents
  }

  const [loaded, records] = await Promise.all([
    ctx.sessionQuery.readSession(sessionId),
    ctx.sessionQuery.listEvents(sessionId),
  ])
  const current = new Set()
  for (const record of records) {
    if (record.surface === 'current') current.add(record.seq)
  }
  // Structural boundaries carry the authoritative Turn and Step numbers and
  // are not surface nodes themselves, so they stay while replaced messages go.
  const events = loaded.events.filter((event) => current.has(event.seq) || event.type === 'turn/start' || event.type === 'step/start')
  const documents = buildSessionDocuments(events)
  const lastSeq = loaded.events.length > 0 ? loaded.events[loaded.events.length - 1].seq : 0
  cacheDocumentList(sessionId, seq === null ? lastSeq : seq, documents)
  return documents
}

/** @param req - incoming request. */
function queryOf(req) {
  try {
    return new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams
  } catch (error) {
    return null
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/find-in-chat/search',
    handler: async (req, res) => {
      const params = queryOf(req)
      if (params === null) {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: 'Malformed query string.' } })
        return
      }

      const sessionId = (params.get('sessionId') || '').trim()
      const query = (params.get('q') || '').trim()
      if (sessionId === '' || sessionId.length > SESSION_ID_MAX) {
        send(res, 400, { ok: false, error: { code: 'bad-session', message: 'A Session id is required.' } })
        return
      }
      if (query === '' || query.length > QUERY_MAX) {
        send(res, 400, { ok: false, error: { code: 'bad-query', message: `The query must be 1-${QUERY_MAX} characters.` } })
        return
      }

      const requestedKinds = (params.get('kinds') || 'user,assistant')
        .split(',')
        .map((kind) => kind.trim())
        .filter((kind) => kind === 'user' || kind === 'assistant')
      if (requestedKinds.length === 0) {
        send(res, 400, { ok: false, error: { code: 'bad-kinds', message: 'Choose at least one author.' } })
        return
      }
      const kinds = [...new Set(requestedKinds)]

      const started = Date.now()
      try {
        const documents = await documentsFor(ctx, sessionId)
        const result = findMatches(documents, query, { kinds })
        send(res, 200, {
          ok: true,
          sessionId,
          query,
          kinds,
          hits: result.hits,
          total: result.total,
          truncated: result.truncated,
          tookMs: Date.now() - started,
        })
      } catch (error) {
        const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
        if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
          send(res, 404, { ok: false, error: { code: 'session-not-found', message: 'That Session no longer exists.' } })
          return
        }
        send(res, 500, {
          ok: false,
          error: {
            code: 'search-failed',
            message: error instanceof Error ? error.message : 'Could not read the Session.',
          },
        })
      }
    },
  }), 'find-in-chat: search route')

  // Lets the client and a quick `curl` tell whether the Host half is live.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/find-in-chat/status',
    handler: async (req, res) => {
      send(res, 200, { ok: true, version: '1.0.0', cachedSessions: cache.size })
    },
  }), 'find-in-chat: status route')
}
