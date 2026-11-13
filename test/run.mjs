// Offline checks for the search core. Run with: node test/run.mjs
//
// No DSH runtime is needed; the cases build small Session event logs.

import assert from 'node:assert/strict'
import { buildSessionDocuments, compileQuery, extractEventText, findMatches, visibleContentText } from '../lib/search.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

function user(seq, text, extra = {}) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: {
      id: `u-${seq}`,
      source: { kind: 'user' },
      role: 'user',
      content: [{ type: 'text', text }],
      ...extra,
    },
  }
}

function assistant(seq, turn, step, content) {
  return {
    type: 'assistant/message',
    seq,
    time: 1000 + seq,
    data: { turn, step, message: { id: `a-${seq}`, role: 'assistant', content } },
  }
}

function toolResult(seq, turn, step, text) {
  return {
    type: 'tool/result',
    seq,
    time: 1000 + seq,
    data: { turn, step, message: { role: 'tool', content: [{ type: 'text', text }] } },
  }
}

function turnStart(seq, turn) {
  return { type: 'turn/start', seq, time: 1000 + seq, data: { turn } }
}

check('visible text ignores reasoning and tool calls', () => {
  assert.equal(visibleContentText([
    { type: 'reasoning', text: 'hidden' },
    { type: 'text', text: ' answer ' },
    { type: 'tool-call', name: 'pwsh', arguments: '{}' },
  ]), 'answer')
})

check('only human user messages are searchable', () => {
  assert.equal(extractEventText(user(3, 'hello')).kind, 'user')
  const injected = user(4, 'system note')
  injected.data.source = { kind: 'system' }
  assert.equal(extractEventText(injected), null)
})

check('turns come from log boundaries and message data', () => {
  const documents = buildSessionDocuments([
    turnStart(1, 1),
    user(2, 'first'),
    assistant(3, 1, 1, [{ type: 'text', text: 'reply one' }]),
    turnStart(4, 2),
    user(5, 'second'),
    assistant(6, 2, 1, [{ type: 'text', text: 'reply two' }]),
  ])
  assert.deepEqual(documents.map((document) => [document.seq, document.turn, document.step]), [
    [2, 1, 0],
    [3, 1, 1],
    [5, 2, 0],
    [6, 2, 1],
  ])
})

check('query matching is literal, case-insensitive and whitespace-flexible', () => {
  const matcher = compileQuery('LU box')
  assert.ok(matcher.test('see https://lu\nbox now'))
  assert.equal(compileQuery('a.b').test('axb'), false)
  assert.equal(compileQuery('   '), null)
})

check('hits are newest first and split per occurrence', () => {
  const documents = buildSessionDocuments([
    turnStart(1, 1),
    user(2, 'lu appears twice: lu and LU'),
    assistant(3, 1, 1, [{ type: 'text', text: 'a newer lu line' }]),
  ])
  const result = findMatches(documents, 'lu')
  assert.equal(result.total, 4)
  assert.deepEqual(result.hits.map((hit) => hit.seq), [3, 2, 2, 2])
  assert.deepEqual(result.hits.map((hit) => hit.occurrence), [0, 2, 1, 0])
  assert.equal(result.hits[0].before.includes('lu'), false)
  assert.equal(result.hits[0].match.toLowerCase(), 'lu')
})

check('limit reports truncation', () => {
  const documents = buildSessionDocuments([user(2, 'a a a a a')])
  const result = findMatches(documents, 'a', { limit: 2 })
  assert.equal(result.total, 2)
  assert.equal(result.truncated, true)
})

check('tool results and tool-call arguments stay out of message results', () => {
  const documents = buildSessionDocuments([
    turnStart(1, 1),
    { type: 'tool/call', seq: 2, time: 1002, data: { turn: 1, step: 1, name: 'pwsh', arguments: '{"url":"https://lu-box"}' } },
    toolResult(3, 1, 1, 'opened https://lu-box'),
  ])
  assert.equal(documents.length, 0)
  assert.equal(findMatches(documents, 'lu').total, 0)
})

check('a message with only reasoning contributes nothing', () => {
  const documents = buildSessionDocuments([
    turnStart(1, 1),
    assistant(2, 1, 1, [{ type: 'reasoning', text: 'lu inside thinking' }]),
  ])
  assert.equal(documents.length, 0)
})

console.log(`\n${passed} checks passed`)
