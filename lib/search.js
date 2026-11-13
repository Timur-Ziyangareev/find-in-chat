// Search over a Session's visible conversation text.
//
// Pure and dependency-free on purpose: the Host route uses it, and the test
// suite imports it directly with a decompressed Session log.

/** Messages whose text the user can see as a normal Chat row. */
const SEARCHABLE_EVENT_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Join the visible text blocks of one message content array.
 *
 * Reasoning and tool-call blocks are skipped: tool calls are searched through
 * their own `tool/call`/`tool/result` events, and reasoning is not shown as the
 * answer. Image and file blocks carry no text of their own.
 *
 * @param content - message content blocks.
 * @returns trimmed newline-joined text, or an empty string.
 */
export function visibleContentText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.map((part) => part.trim()).filter(Boolean).join('\n')
}

/**
 * Extract the searchable text of one Session event.
 *
 * The returned kind is the presentation family used by the result list, not a
 * Session event type: several event types can map to the same kind.
 *
 * @param event - one durable Session event.
 * @returns `{ kind, text, messageId? }`, or null when the event is not visible
 *   conversation text.
 */
export function extractEventText(event) {
  if (!event || typeof event !== 'object') return null
  const data = event.data && typeof event.data === 'object' ? event.data : {}

  switch (event.type) {
    case 'user/message': {
      const source = data.source
      if (!source || source.kind !== 'user') return null
      const text = visibleContentText(data.content)
      if (text === '') return null
      return { kind: 'user', text, messageId: typeof data.id === 'string' ? data.id : undefined }
    }
    case 'assistant/message': {
      const text = visibleContentText(data.message && data.message.content)
      if (text === '') return null
      const id = data.message && data.message.id
      return { kind: 'assistant', text, messageId: typeof id === 'string' ? id : undefined }
    }
    default:
      return null
  }
}

/**
 * Project a Session event log into ordered searchable documents.
 *
 * Turn and step numbers come from an optional coordinate map (the Host builds
 * one from `listEvents`, which sees turn and step boundaries that the current
 * message surface omits); message payloads remain the fallback.
 *
 * @param events - visible Session events in ascending seq order.
 * @param coordinates - optional map of seq to `{ turn, step }`.
 * @returns searchable documents in the same order.
 */
export function buildSessionDocuments(events, coordinates = null) {
  const documents = []
  let turn = 0
  let step = 0

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const mapped = coordinates === null ? undefined : coordinates.get(event.seq)
    if (mapped !== undefined) {
      turn = mapped.turn
      step = mapped.step
    }
    if (SEARCHABLE_EVENT_TYPES.has(event.type)) {
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      if (mapped === undefined && typeof data.turn === 'number') turn = data.turn
      if (mapped === undefined && typeof data.step === 'number') step = data.step
      const extracted = extractEventText(event)
      if (extracted !== null) {
        documents.push({
          seq: event.seq,
          type: event.type,
          time: event.time,
          turn,
          step,
          messageId: extracted.messageId,
          kind: extracted.kind,
          text: extracted.text,
        })
      }
      continue
    }

    if (mapped !== undefined) continue
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'turn/start') {
      if (typeof data.turn === 'number') turn = data.turn
      step = 0
    } else if (event.type === 'step/start') {
      if (typeof data.turn === 'number') turn = data.turn
      if (typeof data.step === 'number') step = data.step
    }
  }

  return documents
}

/** Escape one literal fragment for a JavaScript regular expression. */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Compile the literal query used by both the session search and this plugin.
 *
 * Matching is case-insensitive and treats any whitespace run in the query as
 * one or more whitespace characters in the text, so "lu box" finds "lu\nbox".
 *
 * @param query - user input.
 * @returns a global, case-insensitive matcher, or null for a blank query.
 */
export function compileQuery(query) {
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (trimmed === '') return null
  const source = trimmed.split(/\s+/u).map(escapeRegExp).join('\\s+')
  try {
    return new RegExp(source, 'giu')
  } catch (error) {
    return null
  }
}

/** Collapse whitespace runs for a one-line preview. */
function previewText(text) {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Find every occurrence of a query, newest first.
 *
 * Each hit is one occurrence, so a message containing the query three times
 * contributes three rows. Within one event the latest occurrence comes first;
 * events themselves are ordered from the newest seq to the oldest.
 *
 * @param documents - ordered documents from {@link buildSessionDocuments}.
 * @param query - literal query text.
 * @param options - optional `limit` on returned hits (default 500) and
 *   `before`/`after` preview sizes.
 * @returns `{ hits, total, truncated }`; total counts returned hits, and
 *   `truncated` is true when more occurrences exist.
 */
export function findMatches(documents, query, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 500
  const beforeSize = Number.isInteger(options.before) && options.before >= 0 ? options.before : 70
  const afterSize = Number.isInteger(options.after) && options.after >= 0 ? options.after : 150
  const hits = []
  let truncated = false
  const matcher = compileQuery(query)
  if (matcher === null) return { hits, total: 0, truncated: false }

  for (let index = documents.length - 1; index >= 0; index -= 1) {
    const document = documents[index]
    if (!document || typeof document.text !== 'string' || document.text === '') continue
    matcher.lastIndex = 0

    const occurrences = []
    let match
    while ((match = matcher.exec(document.text)) !== null) {
      occurrences.push(match)
      if (match[0].length === 0) matcher.lastIndex += 1
      if (occurrences.length > limit) break
    }
    if (occurrences.length === 0) continue

    for (let position = occurrences.length - 1; position >= 0; position -= 1) {
      if (hits.length >= limit) {
        truncated = true
        break
      }
      const occurrence = occurrences[position]
      const start = Math.max(0, occurrence.index - beforeSize)
      const end = Math.min(document.text.length, occurrence.index + occurrence[0].length + afterSize)
      hits.push({
        seq: document.seq,
        type: document.type,
        kind: document.kind,
        time: document.time,
        turn: document.turn,
        step: document.step,
        messageId: document.messageId,
        occurrence: position,
        matchIndex: occurrence.index,
        matchLength: occurrence[0].length,
        before: (start > 0 ? '…' : '') + previewText(document.text.slice(start, occurrence.index)),
        match: previewText(occurrence[0]),
        after: previewText(document.text.slice(occurrence.index + occurrence[0].length, end)) + (end < document.text.length ? '…' : ''),
      })
    }
    if (truncated) break
  }

  return { hits, total: hits.length, truncated }
}
