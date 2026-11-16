// Search over a Session's visible conversation text.
//
// Pure and dependency-free on purpose: the Host route uses it, and the test
// suite imports it directly with a decompressed Session log.

/** Event types that carry text a person can read in the conversation. */
const SEARCHABLE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/**
 * Join the blocks of one content array whose `type` matches.
 *
 * @param content - message content blocks.
 * @param blockType - `text` or `reasoning`.
 * @returns trimmed newline-joined text, or an empty string.
 */
export function blocksText(content, blockType) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === blockType && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.map((part) => part.trim()).filter(Boolean).join('\n')
}

/** Join the visible answer text of one message content array. */
export function visibleContentText(content) {
  return blocksText(content, 'text')
}

/** Join the reasoning text of one message content array. */
export function reasoningContentText(content) {
  return blocksText(content, 'reasoning')
}

/**
 * Extract every searchable text part of one Session event.
 *
 * The returned kinds are presentation families used by the result list, not
 * Session event types: an assistant message can contribute both its answer
 * and its reasoning, and tool calls/results share one `tool` kind.
 *
 * @param event - one durable Session event.
 * @returns ordered `{ kind, text, messageId? }` parts; empty when the event
 *   carries no visible text.
 */
export function extractEventTexts(event) {
  if (!event || typeof event !== 'object') return []
  const data = event.data && typeof event.data === 'object' ? event.data : {}

  switch (event.type) {
    case 'user/message': {
      const source = data.source
      if (!source || source.kind !== 'user') return []
      const text = visibleContentText(data.content)
      if (text === '') return []
      return [{ kind: 'user', text, messageId: typeof data.id === 'string' ? data.id : undefined }]
    }
    case 'assistant/message': {
      const content = data.message && data.message.content
      const messageId = data.message && typeof data.message.id === 'string' ? data.message.id : undefined
      const parts = []
      // Reasoning precedes the answer in the log, so pushing it first makes the
      // newest-first scan visit the answer before its thinking.
      const reasoning = reasoningContentText(content)
      if (reasoning !== '') parts.push({ kind: 'reasoning', text: reasoning, messageId })
      const answer = visibleContentText(content)
      if (answer !== '') parts.push({ kind: 'assistant', text: answer, messageId })
      return parts
    }
    case 'tool/call': {
      const parts = []
      if (typeof data.name === 'string' && data.name !== '') parts.push(data.name)
      if (typeof data.arguments === 'string' && data.arguments !== '') parts.push(data.arguments)
      else if (data.arguments && typeof data.arguments === 'object') parts.push(JSON.stringify(data.arguments))
      const text = parts.join('\n').trim()
      return text === '' ? [] : [{ kind: 'tool', text }]
    }
    case 'tool/result': {
      const message = data.message && typeof data.message === 'object' ? data.message : undefined
      const content = message ? message.content : data.content
      const text = visibleContentText(content)
      const error = data.error && typeof data.error === 'object' ? data.error : null
      const errorText = error
        ? [error.name, error.code, error.message].filter((part) => typeof part === 'string' && part !== '').join('\n')
        : ''
      const combined = [text, errorText].filter(Boolean).join('\n').trim()
      return combined === '' ? [] : [{ kind: 'tool', text: combined }]
    }
    default:
      return []
  }
}

/**
 * Extract the first searchable part of one event.
 *
 * @param event - one durable Session event.
 * @returns the first part, or null.
 */
export function extractEventText(event) {
  const parts = extractEventTexts(event)
  return parts.length > 0 ? parts[0] : null
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
      const parts = extractEventTexts(event)
      for (const part of parts) {
        documents.push({
          seq: event.seq,
          type: event.type,
          time: event.time,
          turn,
          step,
          messageId: part.messageId,
          kind: part.kind,
          text: part.text,
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
 * @param options - optional `limit` on returned hits (default 500),
 *   `before`/`after` preview sizes, and `kinds` to restrict the author.
 * @returns `{ hits, total, truncated }`; total counts returned hits, and
 *   `truncated` is true when more occurrences exist.
 */
export function findMatches(documents, query, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 500
  const beforeSize = Number.isInteger(options.before) && options.before >= 0 ? options.before : 70
  const afterSize = Number.isInteger(options.after) && options.after >= 0 ? options.after : 150
  const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? new Set(options.kinds) : null
  const hits = []
  let truncated = false
  const matcher = compileQuery(query)
  if (matcher === null) return { hits, total: 0, truncated: false }

  for (let index = documents.length - 1; index >= 0; index -= 1) {
    const document = documents[index]
    if (!document || typeof document.text !== 'string' || document.text === '') continue
    if (kinds !== null && !kinds.has(document.kind)) continue
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
