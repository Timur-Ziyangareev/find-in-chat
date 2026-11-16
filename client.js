/*
 * Browser half of `find-in-chat`.
 *
 * Adds one search control to the conversation header. The control opens a
 * compact panel that asks the Host for matches in the open Session and lists
 * them newest first. Choosing a result pages the Chat history to that Turn,
 * scrolls to the rendered text, and highlights every occurrence with the CSS
 * Custom Highlight API (no DOM rewriting).
 *
 * Plain browser module: the DSH client loader calls the factory, React comes
 * from the shared browser table, and every resource is registered through the
 * plugin context so unloading removes it.
 */
(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__ || typeof window.__ModuleLoader__.load !== 'function') return;

  window.__ModuleLoader__.load({
    id: '@local/find-in-chat',
    factory: function (require) {
      'use strict';

      var React = null;
      try {
        React = require('react');
      } catch (error) {
        React = null;
      }
      if (!React || typeof React.createElement !== 'function') return null;

      var h = React.createElement;
      var NS = 'find-in-chat';
      var HIGHLIGHT_ALL = 'fic-match';
      var HIGHLIGHT_ACTIVE = 'fic-match-active';

      /* ------------------------------------------------------------------ *
       * Copy
       * ------------------------------------------------------------------ */

      var TEXT = {
        en: {
          'action.tooltip': 'Search',
          'action.aria': 'Search in chat',
          'panel.title': 'Find in chat',
          'panel.placeholder': 'Type to search this chat',
          'panel.close': 'Close',
          'panel.idle': 'Start typing. Matches appear newest first.',
          'panel.loading': 'Searching…',
          'panel.empty': 'No matches',
          'panel.error': 'Search failed',
          'panel.count': '{n} matches · newest first',
          'panel.countOne': '1 match · newest first',
          'panel.truncated': 'First {n} shown',
          'panel.jumping': 'Opening message…',
          'panel.keyHint': '↑↓ navigate · Enter jump · Esc close',
          'filter.label': 'Filter results',
          'filter.all': 'All',
          'filter.tools': 'Tools',
          'kind.user': 'You',
          'kind.assistant': 'Assistant',
          'kind.reasoning': 'Thought',
          'kind.tool': 'Tool',
          'turn': 'Turn {n}',
          'error.session': 'This chat is still opening.',
          'error.notFound': 'That message is not in the loaded history yet.',
          'error.jump': 'Could not open that message.',
          'error.collapsed': 'This match is inside a collapsed step — expand it to see the highlight.',
          'error.network': 'The Host did not answer.'
        },
        ru: {
          'action.tooltip': 'Поиск',
          'action.aria': 'Поиск в чате',
          'panel.title': 'Поиск в чате',
          'panel.placeholder': 'Введите текст для поиска',
          'panel.close': 'Закрыть',
          'panel.idle': 'Начните вводить — совпадения появятся от новых к старым.',
          'panel.loading': 'Ищу…',
          'panel.empty': 'Совпадений нет',
          'panel.error': 'Ошибка поиска',
          'panel.count': '{n} совпадений · сначала новые',
          'panel.countOne': '1 совпадение · сначала новые',
          'panel.truncated': 'Показаны первые {n}',
          'panel.jumping': 'Открываю сообщение…',
          'panel.keyHint': '↑↓ выбор · Enter перейти · Esc закрыть',
          'filter.label': 'Фильтр результатов',
          'filter.all': 'Все',
          'filter.tools': 'Инструменты',
          'kind.user': 'Вы',
          'kind.assistant': 'Ассистент',
          'kind.reasoning': 'Рассуждение',
          'kind.tool': 'Инструмент',
          'turn': 'Ход {n}',
          'error.session': 'Чат ещё открывается.',
          'error.notFound': 'Это сообщение ещё не загружено в чат.',
          'error.jump': 'Не удалось открыть сообщение.',
          'error.collapsed': 'Совпадение внутри свёрнутого шага — раскройте его, чтобы увидеть подсветку.',
          'error.network': 'Хост не ответил.'
        },
        zh: {
          'action.tooltip': '搜索',
          'action.aria': '在聊天中搜索',
          'panel.title': '在聊天中查找',
          'panel.placeholder': '输入文字，搜索此聊天',
          'panel.close': '关闭',
          'panel.idle': '开始输入。匹配项按最新优先显示。',
          'panel.loading': '搜索中…',
          'panel.empty': '没有匹配',
          'panel.error': '搜索失败',
          'panel.count': '{n} 个匹配 · 最新在前',
          'panel.countOne': '1 个匹配 · 最新在前',
          'panel.truncated': '仅显示前 {n} 个',
          'panel.jumping': '正在打开消息…',
          'panel.keyHint': '↑↓ 选择 · Enter 跳转 · Esc 关闭',
          'filter.label': '筛选结果',
          'filter.all': '全部',
          'filter.tools': '工具',
          'kind.user': '你',
          'kind.assistant': '助手',
          'kind.reasoning': '思考',
          'kind.tool': '工具',
          'turn': '第 {n} 轮',
          'error.session': '聊天仍在打开。',
          'error.notFound': '该消息尚未加载到聊天中。',
          'error.jump': '无法打开该消息。',
          'error.collapsed': '匹配位于折叠的步骤中 — 展开后即可看到高亮。',
          'error.network': '主机没有响应。'
        }
      };

      /** Current UI language, mirroring the Host document language. */
      function language() {
        try {
          var tag = String(document.documentElement.lang || '').toLowerCase();
          if (tag.indexOf('ru') === 0) return 'ru';
          if (tag.indexOf('zh') === 0) return 'zh';
          if (tag.indexOf('en') === 0) return 'en';
        } catch (error) { /* fall through */ }
        try {
          var nav = String((navigator && navigator.language) || 'en').toLowerCase();
          if (nav.indexOf('ru') === 0) return 'ru';
          if (nav.indexOf('zh') === 0) return 'zh';
        } catch (error) { /* fall through */ }
        return 'en';
      }

      function interpolate(template, values) {
        if (!values) return template;
        return template.replace(/\{(\w+)\}/g, function (match, name) {
          return values[name] === undefined ? match : String(values[name]);
        });
      }

      /** Translate one key, falling back to the local table. */
      function translate(key, values, bound) {
        if (typeof bound === 'function') {
          try {
            var fromHost = bound(key, values);
            if (typeof fromHost === 'string' && fromHost !== key) return fromHost;
          } catch (error) { /* fall back below */ }
        }
        var table = TEXT[language()] || TEXT.en;
        var template = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : TEXT.en[key];
        return template === undefined ? key : interpolate(template, values);
      }

      /* ------------------------------------------------------------------ *
       * Styles (scoped by the fic- prefix; theme tokens only)
       * ------------------------------------------------------------------ */

      var CSS = [
        '.fic-wrap{position:relative;display:inline-flex;align-items:center;flex:none}',
        '.fic-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;transition:background .12s ease,color .12s ease}',
        '.fic-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.fic-button:active{background:var(--dsw-alias-interactive-bg-active)}',
        '.fic-button[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.fic-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
        '.fic-tip{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);z-index:80;display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;background:#2c2c2e;color:#fff;font-size:12px;line-height:16px;white-space:nowrap;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.28)}',
        '.fic-panel{position:fixed;z-index:90;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-family:inherit}',
        '.fic-head{display:flex;align-items:center;gap:8px;padding:10px 12px 4px}',
        '.fic-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.fic-icon-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none}',
        '.fic-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.fic-search{display:flex;align-items:center;gap:8px;margin:2px 12px 8px;padding:0 10px;height:34px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary)}',
        '.fic-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}',
        '.fic-segments{display:inline-flex;align-items:center;gap:2px;align-self:flex-start;max-width:calc(100% - 24px);margin:0 12px 8px;padding:3px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);overflow-x:auto;scrollbar-width:none}',
        '.fic-segments::-webkit-scrollbar{display:none}',
        '.fic-segment{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer;flex:none}',
        '.fic-segment:hover{color:var(--dsw-alias-label-primary)}',
        '.fic-segment[aria-checked="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft)}',
        '.fic-segment:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
        '.fic-chip-dot{width:5px;height:5px;border-radius:50%;flex:none}',
        '.fic-segment[aria-checked="false"] .fic-chip-dot{opacity:.35}',
        '.fic-input{flex:1;min-width:0;height:100%;padding:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px}',
        '.fic-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
        '.fic-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 12px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
        '.fic-notice{margin:0 12px 6px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:17px}',
        '.fic-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 6px 6px;scrollbar-width:thin}',
        '.fic-row{box-sizing:border-box;display:flex;flex-direction:column;gap:3px;width:100%;padding:7px 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}',
        '.fic-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.fic-row[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-active)}',
        '.fic-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
        '.fic-row-top{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
        '.fic-kind{display:inline-flex;align-items:center;gap:5px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
        '.fic-dot{width:5px;height:5px;border-radius:50%;flex:none}',
        '.fic-dot-user{background:var(--dsw-alias-state-business-primary)}',
        '.fic-dot-assistant{background:#8a7cf0}',
        '.fic-dot-reasoning{background:#b58b4a}',
        '.fic-dot-tool{background:#8a8f98}',
        '.fic-sep{opacity:.5}',
        '.fic-snippet{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.fic-row[aria-selected="true"] .fic-snippet{color:var(--dsw-alias-label-primary)}',
        '.fic-snippet mark{padding:0 1px;border-radius:3px;background:rgba(255,178,36,.34);color:inherit}',
        '.fic-row[aria-selected="true"] .fic-snippet mark{background:rgba(255,178,36,.58)}',
        '.fic-state{display:flex;align-items:center;justify-content:center;gap:6px;padding:18px 12px;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
        '.fic-spinner{display:inline-block;width:12px;height:12px;border:1.5px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:fic-spin .7s linear infinite}',
        '@keyframes fic-spin{to{transform:rotate(360deg)}}',
        '.fic-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
        '.fic-foot span{overflow:hidden;text-overflow:ellipsis}',
        '.fic-spot{position:fixed;z-index:86;pointer-events:none;border:2px solid rgba(255,150,30,.9);border-radius:4px;box-shadow:0 0 0 3px rgba(255,178,36,.26),0 0 18px rgba(255,150,30,.36);transition:opacity .25s ease}',
        '::highlight(fic-match){background-color:rgba(255,178,36,.36);color:inherit}',
        '::highlight(fic-match-active){background-color:rgba(255,150,30,.75);color:#1a1206}',
        '@media (prefers-reduced-motion: reduce){.fic-spinner{animation:none}}'
      ].join('\n');

      /* ------------------------------------------------------------------ *
       * Icons
       * ------------------------------------------------------------------ */

      function iconSearch(size) {
        return h('svg', {
          width: size || 16, height: size || 16, viewBox: '0 0 16 16', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, focusable: false
        }, [
          h('circle', { key: 'ring', cx: 7, cy: 7, r: 4.1 }),
          h('path', { key: 'handle', d: 'M10.2 10.2 13.4 13.4' })
        ]);
      }

      function iconClose(size) {
        return h('svg', {
          width: size || 14, height: size || 14, viewBox: '0 0 16 16', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
          'aria-hidden': true, focusable: false
        }, h('path', { d: 'M4 4 12 12M12 4 4 12' }));
      }

      /* ------------------------------------------------------------------ *
       * DOM helpers
       * ------------------------------------------------------------------ */

      function clearHighlights() {
        try {
          if (typeof CSS !== 'undefined' && CSS.highlights) {
            CSS.highlights.delete(HIGHLIGHT_ALL);
            CSS.highlights.delete(HIGHLIGHT_ACTIVE);
          }
        } catch (error) { /* highlighting is an enhancement */ }
      }

      function isVisible(element) {
        if (!element || !element.isConnected) return false;
        try {
          return element.getClientRects().length > 0;
        } catch (error) {
          return false;
        }
      }

      function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      }

      function compileQuery(query) {
        var trimmed = String(query || '').trim();
        if (trimmed === '') return null;
        var source = trimmed.split(/\s+/u).map(function (part) {
          return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        }).join('\\s+');
        try {
          return new RegExp(source, 'giu');
        } catch (error) {
          return null;
        }
      }

      /** Text ranges of every occurrence inside one rendered row. */
      function rangesInRow(row, query) {
        var matcher = compileQuery(query);
        if (matcher === null || typeof document.createTreeWalker !== 'function') return [];
        var ranges = [];
        var walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            var parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            var tag = parent.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        var node;
        while ((node = walker.nextNode()) !== null) {
          var text = node.nodeValue;
          if (!text) continue;
          matcher.lastIndex = 0;
          var match;
          while ((match = matcher.exec(text)) !== null) {
            try {
              var range = document.createRange();
              range.setStart(node, match.index);
              range.setEnd(node, match.index + match[0].length);
              ranges.push(range);
            } catch (error) { /* skip an unselectable range */ }
            if (match[0].length === 0) matcher.lastIndex += 1;
            if (ranges.length >= 300) return ranges;
          }
        }
        return ranges;
      }

      /** Highlight the query inside one row and return the active range list. */
      function highlightRow(row, query, occurrence) {
        clearHighlights();
        var ranges = rangesInRow(row, query);
        if (ranges.length === 0 || typeof Highlight !== 'function' || typeof CSS === 'undefined' || !CSS.highlights) return ranges;
        try {
          var all = new Highlight();
          for (var index = 0; index < ranges.length; index += 1) all.add(ranges[index]);
          CSS.highlights.set(HIGHLIGHT_ALL, all);
          var activeRange = ranges[Math.min(Math.max(occurrence, 0), ranges.length - 1)];
          if (activeRange) {
            var active = new Highlight(activeRange);
            active.priority = 1;
            CSS.highlights.set(HIGHLIGHT_ACTIVE, active);
          }
        } catch (error) { /* ignore an unsupported Highlight implementation */ }
        return ranges;
      }

      function flashRow(row) {
        try {
          var style = row.style;
          var before = { outline: style.outline, offset: style.outlineOffset, radius: style.borderRadius };
          style.outline = '2px solid rgba(255,168,36,.7)';
          style.outlineOffset = '2px';
          if (!before.radius) style.borderRadius = '12px';
          window.setTimeout(function () {
            style.outline = before.outline;
            style.outlineOffset = before.offset;
            if (!before.radius) style.borderRadius = before.radius;
          }, 1500);
        } catch (error) { /* the row may have unmounted */ }
      }

      /**
       * Pick the rendered Chat row that holds one search hit.
       *
       * Chat keys its rows by the conversation context identity, so a message
       * can be addressed exactly: `input-message` plus the user message id, or
       * `assistant-step` plus `<turn>:<step>`. Rows carry their Turn number too;
       * the text check remains as a fallback for a changed key shape.
       */
      function nodeKeyFor(hit) {
        if (hit.kind === 'user' && typeof hit.messageId === 'string') {
          return contextKey('input-message', hit.messageId);
        }
        if (hit.kind !== 'user' && Number.isInteger(hit.turn) && Number.isInteger(hit.step)) {
          // Answers, reasoning, and tool rows live in the assistant step.
          return contextKey('assistant-step', String(hit.turn) + ':' + String(hit.step));
        }
        return null;
      }

      /** Chat's conversation context key: `<kind length>:<kind><id>`. */
      function contextKey(kind, id) {
        return String(kind.length) + ':' + kind + id;
      }

      function pickRow(hit, query) {
        var needle = normalizeText(query);
        function holdsText(row) {
          if (needle === '') return true;
          return normalizeText(row.innerText || row.textContent || '').indexOf(needle) >= 0;
        }

        var key = nodeKeyFor(hit);
        if (key !== null) {
          try {
            var exactRows = Array.prototype.slice.call(document.querySelectorAll('[data-chat-node-key="' + key + '"]'));
            var response = exactRows.filter(function (row) { return row.getAttribute('data-chat-group-part') === 'response' && isVisible(row); });
            var fittingResponse = response.filter(holdsText);
            if (fittingResponse.length > 0) return fittingResponse[0];
            var visible = exactRows.filter(isVisible);
            var fitting = visible.filter(holdsText);
            if (fitting.length > 0) return fitting[0];
            if ((hit.kind === 'tool' || hit.kind === 'reasoning') && visible.length > 0) return visible[0];
          } catch (error) { /* fall through to the turn search */ }
        }

        var rows = [];
        try {
          rows = Array.prototype.slice.call(document.querySelectorAll('[data-chat-turn="' + String(hit.turn) + '"]')).filter(isVisible);
        } catch (error) {
          return null;
        }
        if (rows.length === 0) return null;
        var kindRows = rows.filter(function (row) {
          var kind = row.getAttribute('data-chat-flow-kind');
          if (hit.kind === 'user') return kind === 'user' || kind === 'steering';
          if (hit.kind === 'assistant') return kind === 'assistant-step';
          return true;
        });
        var pool = kindRows.length > 0 ? kindRows : rows;
        var matching = pool.filter(holdsText);
        if (matching.length > 0) return matching[0];
        return pool.length === 1 ? pool[0] : pool[pool.length - 1];
      }

      function waitForRow(hit, query, timeoutMs) {
        return new Promise(function (resolve) {
          var started = Date.now();
          function poll() {
            var row = pickRow(hit, query);
            if (row) {
              resolve(row);
              return;
            }
            if (Date.now() - started >= timeoutMs) {
              resolve(null);
              return;
            }
            window.setTimeout(poll, 60);
          }
          poll();
        });
      }

      /** Map the four-way selector to the Host's result kinds. */
      function kindsForScope(scope) {
        if (scope === 'user') return ['user'];
        if (scope === 'assistant') return ['assistant', 'reasoning'];
        if (scope === 'tool') return ['tool'];
        return ['user', 'assistant', 'reasoning', 'tool'];
      }

      function formatTime(value) {
        try {
          var date = new Date(value);
          if (Number.isNaN(date.getTime())) return '';
          return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        } catch (error) {
          return '';
        }
      }

      /* ------------------------------------------------------------------ *
       * Plugin body
       * ------------------------------------------------------------------ */

      function apply(ctx) {
        var sessions = ctx.sessions;

        function ensureStyles() {
          if (document.querySelector('style[data-fic-styles]') !== null) return null;
          var tag = document.createElement('style');
          tag.setAttribute('data-fic-styles', '1');
          tag.setAttribute('data-plugin', '@local/find-in-chat');
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return tag;
        }

        ctx.effect(function () {
          var tag = ensureStyles();
          return function () {
            if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag);
          };
        }, 'find-in-chat: styles');

        ctx.effect(function () {
          return ctx.locale.register(NS, TEXT);
        }, 'find-in-chat: locale');

        /* ------------------------------------------------------------------ *
         * One search control
         * ------------------------------------------------------------------ */

        function SearchAction(props) {
          var sessionId = String(props.sessionId || '');
          var t = props.t;

          function copy(key, values) {
            return translate(key, values, typeof t === 'function' ? t : null);
          }

          var openState = React.useState(false);
          var open = openState[0];
          var setOpen = openState[1];

          var queryState = React.useState('');
          var query = queryState[0];
          var setQuery = queryState[1];

          var resultState = React.useState({ status: 'idle', hits: [], total: 0, truncated: false, error: null });
          var result = resultState[0];
          var setResult = resultState[1];

          var activeState = React.useState(0);
          var active = activeState[0];
          var setActive = activeState[1];

          var anchorState = React.useState(null);
          var anchor = anchorState[0];
          var setAnchor = anchorState[1];

          var tipState = React.useState(false);
          var tip = tipState[0];
          var setTip = tipState[1];

          var jumpingState = React.useState(0);
          var jumping = jumpingState[0];
          var setJumping = jumpingState[1];

          var noticeState = React.useState(null);
          var notice = noticeState[0];
          var setNotice = noticeState[1];

          var scopeState = React.useState('all');
          var scope = scopeState[0];
          var setScope = scopeState[1];

          var spotState = React.useState(null);
          var spot = spotState[0];
          var setSpot = spotState[1];

          var wrapRef = React.useRef(null);
          var buttonRef = React.useRef(null);
          var inputRef = React.useRef(null);
          var listRef = React.useRef(null);
          var tipTimer = React.useRef(0);
          var spotTimer = React.useRef(0);
          var jumpToken = React.useRef(0);
          var openRef = React.useRef(false);
          var resultRef = React.useRef(result);

          openRef.current = open;
          resultRef.current = result;

          function openPanel() {
            setTip(false);
            setOpen(true);
            window.setTimeout(function () {
              var input = inputRef.current;
              if (input) {
                input.focus();
                input.select();
              }
            }, 0);
          }

          function closePanel() {
            setOpen(false);
            setTip(false);
            setNotice(null);
            setSpot(null);
            clearHighlights();
          }

          function showSpot(range) {
            if (spotTimer.current) window.clearTimeout(spotTimer.current);
            try {
              var rect = range.getBoundingClientRect();
              if (rect.width < 1 && rect.height < 1) return;
              setSpot({
                left: Math.round(rect.left - 3),
                top: Math.round(rect.top - 2),
                width: Math.round(rect.width + 6),
                height: Math.round(rect.height + 4)
              });
            } catch (error) {
              return;
            }
            spotTimer.current = window.setTimeout(function () {
              spotTimer.current = 0;
              setSpot(null);
            }, 2200);
          }

          function togglePanel() {
            if (openRef.current) closePanel();
            else openPanel();
          }

          React.useEffect(function () {
            if (!open) return;
            return function () {
              if (tipTimer.current) {
                window.clearTimeout(tipTimer.current);
                tipTimer.current = 0;
              }
            };
          }, [open]);

          // A different Session keeps the same header seat; start clean.
          React.useEffect(function () {
            setOpen(false);
            setResult({ status: 'idle', hits: [], total: 0, truncated: false, error: null });
            setActive(0);
            setNotice(null);
            setSpot(null);
            clearHighlights();
          }, [sessionId]);

          React.useEffect(function () {
            return function () {
              if (spotTimer.current) window.clearTimeout(spotTimer.current);
              clearHighlights();
            };
          }, []);

          // Search whenever the query settles, with one abortable request.
          React.useEffect(function () {
            if (!open) return;
            var text = query.trim();
            if (text === '') {
              setResult({ status: 'idle', hits: [], total: 0, truncated: false, error: null });
              setActive(0);
              setSpot(null);
              clearHighlights();
              return;
            }
            setResult(function (previous) {
              return { status: 'loading', hits: previous.hits, total: previous.total, truncated: previous.truncated, error: null };
            });
            setSpot(null);
            clearHighlights();
            var controller = null;
            try {
              controller = new AbortController();
            } catch (error) {
              controller = null;
            }
            var current = true;
            var timer = window.setTimeout(function () {
              var url = '/find-in-chat/search?sessionId=' + encodeURIComponent(sessionId)
                + '&kinds=' + encodeURIComponent(kindsForScope(scope).join(','))
                + '&q=' + encodeURIComponent(text);
              var options = { headers: { accept: 'application/json' } };
              if (controller) options.signal = controller.signal;
              window.fetch(url, options)
                .then(function (response) {
                  return response.json().catch(function () { return null; }).then(function (body) {
                    return { status: response.status, body: body };
                  });
                })
                .then(function (payload) {
                  if (!current) return;
                  var body = payload.body;
                  if (!body || body.ok !== true) {
                    var message = body && body.error && body.error.message ? body.error.message : 'HTTP ' + String(payload.status);
                    setResult({ status: 'error', hits: [], total: 0, truncated: false, error: message });
                    return;
                  }
                  setResult({ status: 'ready', hits: body.hits, total: body.total, truncated: body.truncated, error: null });
                  setActive(0);
                  clearHighlights();
                })
                .catch(function (error) {
                  if (!current) return;
                  if (error && error.name === 'AbortError') return;
                  setResult({ status: 'error', hits: [], total: 0, truncated: false, error: copy('error.network') });
                });
            }, 170);
            return function () {
              current = false;
              window.clearTimeout(timer);
              if (controller) controller.abort();
            };
          }, [open, query, sessionId, scope]);

          // Panel geometry follows the header control.
          React.useLayoutEffect(function () {
            if (!open) return;
            function place() {
              var button = buttonRef.current;
              if (!button) return;
              var rect = button.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) return;
              // The header owns two rows (title and View tabs); a dropdown
              // that started at the control would cover the tab row.
              var header = null;
              try {
                header = button.closest('header');
              } catch (error) {
                header = null;
              }
              var bottom = header ? header.getBoundingClientRect().bottom : rect.bottom;
              var width = Math.max(280, Math.min(400, window.innerWidth - 24));
              setAnchor({
                top: Math.round(bottom + 8),
                right: Math.max(12, Math.round(window.innerWidth - rect.right)),
                width: width,
                maxHeight: Math.max(220, Math.min(560, window.innerHeight - bottom - 24))
              });
            }
            place();
            window.addEventListener('resize', place);
            var observer = null;
            if (typeof ResizeObserver === 'function') {
              observer = new ResizeObserver(place);
              if (buttonRef.current) observer.observe(buttonRef.current);
            }
            return function () {
              window.removeEventListener('resize', place);
              if (observer) observer.disconnect();
            };
          }, [open]);

          // Keep the active row visible as the pointer or arrows move it.
          React.useEffect(function () {
            if (!open) return;
            var list = listRef.current;
            if (!list) return;
            var row = list.querySelector('[data-fic-index="' + String(active) + '"]');
            if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
          }, [active, open, result.hits.length]);

          // Pointer outside the control or panel closes it; Escape does too.
          React.useEffect(function () {
            if (!open) return;
            function onPointerDown(event) {
              var wrap = wrapRef.current;
              if (wrap && event.target instanceof Node && !wrap.contains(event.target)) closePanel();
            }
            function onKeyDown(event) {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closePanel();
              }
            }
            document.addEventListener('pointerdown', onPointerDown, true);
            document.addEventListener('keydown', onKeyDown, true);
            return function () {
              document.removeEventListener('pointerdown', onPointerDown, true);
              document.removeEventListener('keydown', onKeyDown, true);
            };
          }, [open]);

          function moveActive(delta) {
            var hits = resultRef.current.hits;
            if (hits.length === 0) return;
            setActive(function (current) {
              var next = current + delta;
              if (next < 0) next = hits.length - 1;
              if (next >= hits.length) next = 0;
              return next;
            });
          }

          function jump(hit, index) {
            if (jumping !== 0) return;
            var token = jumpToken.current + 1;
            jumpToken.current = token;
            setJumping(token);
            setNotice(null);
            setSpot(null);

            var binding = null;
            try {
              binding = sessions.binding(sessionId);
            } catch (error) {
              binding = null;
            }
            if (!binding) {
              setJumping(0);
              setNotice(copy('error.session'));
              return;
            }

            var session = binding.session;
            Promise.resolve()
              .then(function () {
                if (session && typeof session.loadThrough === 'function') return session.loadThrough(hit.seq);
                return undefined;
              })
              .then(function () {
                return waitForRow(hit, query, 6000);
              })
              .then(function (row) {
                if (jumpToken.current !== token) return;
                if (!row) throw new Error('row-not-found');
                var ranges = highlightRow(row, query, hit.occurrence);
                flashRow(row);
                var range = ranges.length > 0 ? ranges[Math.min(hit.occurrence, ranges.length - 1)] : null;
                var target = range && range.startContainer.parentElement ? range.startContainer.parentElement : row;
                if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                if (range) {
                  window.setTimeout(function () {
                    if (jumpToken.current === token) showSpot(range);
                  }, 420);
                }
                var collapsed = false;
                if (range) {
                  try {
                    var rect = range.getBoundingClientRect();
                    collapsed = rect.width === 0 && rect.height === 0;
                  } catch (error) {
                    collapsed = true;
                  }
                }
                if ((hit.kind === 'tool' || hit.kind === 'reasoning') && (range === null || collapsed)) {
                  setNotice(copy('error.collapsed'));
                }
                setActive(index);
              })
              .catch(function (error) {
                if (jumpToken.current !== token) return;
                if (window.console && typeof window.console.warn === 'function') {
                  window.console.warn('[find-in-chat] could not open the match:', error);
                }
                setNotice(error && error.message === 'row-not-found' ? copy('error.notFound') : copy('error.jump'));
              })
              .then(function () {
                if (jumpToken.current === token) setJumping(0);
              });
          }

          function onInputKeyDown(event) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              event.stopPropagation();
              moveActive(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              event.stopPropagation();
              moveActive(-1);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              var hit = result.hits[active];
              if (hit) jump(hit, active);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closePanel();
            }
          }

          function scheduleTip() {
            if (openRef.current) return;
            if (tipTimer.current) window.clearTimeout(tipTimer.current);
            tipTimer.current = window.setTimeout(function () {
              tipTimer.current = 0;
              setTip(true);
            }, 450);
          }

          function hideTip() {
            if (tipTimer.current) {
              window.clearTimeout(tipTimer.current);
              tipTimer.current = 0;
            }
            setTip(false);
          }

          function stateLine() {
            if (result.status === 'loading') {
              return h('div', { className: 'fic-state' }, [h('span', { className: 'fic-spinner', key: 's' }), h('span', { key: 't' }, copy('panel.loading'))]);
            }
            if (result.status === 'error') {
              return h('div', { className: 'fic-state' }, copy(result.error || copy('panel.error')));
            }
            if (result.status === 'ready' && result.hits.length === 0) {
              return h('div', { className: 'fic-state' }, copy('panel.empty'));
            }
            return h('div', { className: 'fic-state' }, copy('panel.idle'));
          }

          function metaLine() {
            if (result.status !== 'ready' || result.hits.length === 0) return null;
            var count = result.total === 1 ? copy('panel.countOne') : copy('panel.count', { n: result.total });
            return h('div', { className: 'fic-meta' }, [
              h('span', { key: 'count' }, count),
              result.truncated ? h('span', { key: 'truncated' }, copy('panel.truncated', { n: result.hits.length })) : null
            ]);
          }

          function scopeFilter() {
            var options = [
              { id: 'all', label: copy('filter.all') },
              { id: 'user', label: copy('kind.user'), dot: 'user' },
              { id: 'assistant', label: copy('kind.assistant'), dot: 'assistant' },
              { id: 'tool', label: copy('filter.tools'), dot: 'tool' }
            ];
            return h('div', {
              className: 'fic-segments',
              key: 'filters',
              role: 'radiogroup',
              'aria-label': copy('filter.label')
            }, options.map(function (option) {
              var checked = scope === option.id;
              return h('button', {
                key: option.id,
                type: 'button',
                role: 'radio',
                className: 'fic-segment',
                'aria-checked': checked ? 'true' : 'false',
                onClick: function () { setScope(option.id); }
              }, [
                option.dot ? h('span', { className: 'fic-chip-dot fic-dot-' + option.dot, key: 'dot' }) : null,
                h('span', { key: 'label' }, option.label)
              ]);
            }));
          }

          function rowNode(hit, index) {
            var dotClass = 'fic-dot fic-dot-' + (hit.kind === 'user' || hit.kind === 'assistant' || hit.kind === 'reasoning' ? hit.kind : 'tool');
            return h('button', {
              key: String(hit.seq) + ':' + hit.kind + ':' + String(hit.occurrence),
              type: 'button',
              className: 'fic-row',
              role: 'option',
              'aria-selected': index === active ? 'true' : 'false',
              'data-fic-index': index,
              onClick: function () { jump(hit, index); },
              onMouseEnter: function () { setActive(index); },
              onMouseDown: function (event) { event.preventDefault(); }
            }, [
              h('div', { className: 'fic-row-top', key: 'top' }, [
                h('span', { className: 'fic-kind', key: 'kind' }, [
                  h('span', { className: dotClass, key: 'dot' }),
                  h('span', { key: 'label' }, copy('kind.' + hit.kind))
                ]),
                h('span', { className: 'fic-sep', key: 'sep1' }, '·'),
                h('span', { key: 'turn' }, copy('turn', { n: hit.turn })),
                h('span', { className: 'fic-sep', key: 'sep2' }, '·'),
                h('span', { key: 'time' }, formatTime(hit.time))
              ]),
              h('div', { className: 'fic-snippet', key: 'snippet' }, [
                hit.before,
                h('mark', { key: 'match' }, hit.match),
                hit.after
              ])
            ]);
          }

          if (!sessionId) return null;

          var panel = null;
          if (open && anchor) {
            panel = h('div', {
              className: 'fic-panel',
              role: 'dialog',
              'aria-label': copy('panel.title'),
              'aria-modal': 'false',
              'data-fic-panel': '1',
              style: {
                top: String(anchor.top) + 'px',
                right: String(anchor.right) + 'px',
                width: String(anchor.width) + 'px',
                maxHeight: String(anchor.maxHeight) + 'px'
              }
            }, [
              h('div', { className: 'fic-head', key: 'head' }, [
                h('span', { className: 'fic-title', key: 'title' }, copy('panel.title')),
                h('button', {
                  key: 'close',
                  type: 'button',
                  className: 'fic-icon-button',
                  'aria-label': copy('panel.close'),
                  title: copy('panel.close'),
                  onClick: closePanel
                }, iconClose(14))
              ]),
              h('div', { className: 'fic-search', key: 'search' }, [
                iconSearch(15),
                h('input', {
                  key: 'input',
                  ref: inputRef,
                  className: 'fic-input',
                  type: 'text',
                  value: query,
                  placeholder: copy('panel.placeholder'),
                  'aria-label': copy('action.aria'),
                  spellCheck: false,
                  autoComplete: 'off',
                  onChange: function (event) { setQuery(event.target.value); },
                  onKeyDown: onInputKeyDown
                })
              ]),
              scopeFilter(),
              metaLine(),              notice ? h('div', { className: 'fic-notice', key: 'notice' }, notice) : null,
              h('div', { className: 'fic-list', key: 'list', ref: listRef, role: 'listbox', 'aria-label': copy('panel.title') },
                result.status === 'ready' && result.hits.length > 0
                  ? result.hits.map(rowNode)
                  : stateLine()
              ),
              h('div', { className: 'fic-foot', key: 'foot' }, [
                h('span', { key: 'hint' }, jumping !== 0 ? copy('panel.jumping') : copy('panel.keyHint'))
              ])
            ]);
          }

          return h('div', { className: 'fic-wrap', ref: wrapRef, 'data-find-in-chat': '1' }, [
            h('button', {
              key: 'button',
              ref: buttonRef,
              type: 'button',
              className: 'fic-button',
              'aria-label': copy('action.aria'),
              'aria-haspopup': 'dialog',
              'aria-expanded': open ? 'true' : 'false',
              onMouseDown: function (event) { if (event.button === 0) event.preventDefault(); },
              onMouseEnter: scheduleTip,
              onMouseLeave: hideTip,
              onFocus: scheduleTip,
              onBlur: hideTip,
              onClick: togglePanel
            }, iconSearch(16)),
            tip && !open ? h('div', { className: 'fic-tip', key: 'tip', role: 'tooltip' }, [
              h('span', { key: 'label' }, copy('action.tooltip'))
            ]) : null,
            panel,
            spot ? h('div', {
              key: 'spot',
              className: 'fic-spot',
              'aria-hidden': 'true',
              style: {
                left: String(spot.left) + 'px',
                top: String(spot.top) + 'px',
                width: String(spot.width) + 'px',
                height: String(spot.height) + 'px'
              }
            }) : null
          ]);
        }

        ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'find-in-chat',
            order: -20,
            locale: NS
          }, SearchAction);
        });
      }

      return {
        name: 'find-in-chat',
        inject: ['slots', 'sessions', 'locale'],
        apply: apply
      };
    }
  });
})();

