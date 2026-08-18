/* Crash reporting for a device with no console.
 *
 * iOS Safari cannot be inspected without a Mac, and its error messages are
 * famously vague ("undefined is not a function", with no clue what was
 * undefined). This captures the real error object — message, stack, file and
 * line — the moment it happens, survives the app being killed, and makes the
 * whole thing selectable so it can be pasted somewhere useful.
 *
 * Classic script on purpose: it must be installed before any module runs.
 */
(function () {
  'use strict';

  var KEY = 'reader.diag.v1';
  var MAX = 15;
  var log = [];

  try {
    var saved = localStorage.getItem(KEY);
    if (saved) log = JSON.parse(saved) || [];
  } catch (e) { log = []; }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(log.slice(-MAX))); } catch (e) { /* full or private */ }
  }

  function record(kind, err, extra) {
    var entry = {
      at: new Date().toISOString(),
      kind: kind,
      message: (err && (err.message || err.reason || err)) + '',
      name: (err && err.name) || '',
      stack: (err && err.stack) || '',
      where: extra || '',
    };
    log.push(entry);
    if (log.length > MAX) log = log.slice(-MAX);
    persist();
    return entry;
  }

  window.addEventListener('error', function (e) {
    if (e.error) record('error', e.error, e.filename + ':' + e.lineno + ':' + e.colno);
    else record('error', { message: e.message }, e.filename + ':' + e.lineno);
  });

  window.addEventListener('unhandledrejection', function (e) {
    record('unhandledrejection', e.reason);
  });

  function has(fn) { try { return !!fn(); } catch (e) { return false; } }

  function features() {
    return {
      'Promise.withResolvers': has(function () { return Promise.withResolvers; }),
      'DecompressionStream':   has(function () { return DecompressionStream; }),
      'OffscreenCanvas':       has(function () { return OffscreenCanvas; }),
      'structuredClone':       has(function () { return structuredClone; }),
      'dialog.showModal':      has(function () { return document.createElement('dialog').showModal; }),
      'crypto.randomUUID':     has(function () { return crypto.randomUUID; }),
      'indexedDB':             has(function () { return indexedDB; }),
      'serviceWorker':         has(function () { return navigator.serviceWorker; }),
      'wakeLock':              has(function () { return navigator.wakeLock; }),
      'speechSynthesis':       has(function () { return speechSynthesis; }),
      'Array.at':              has(function () { return [].at; }),
      'Array.findLast':        has(function () { return [].findLast; }),
      'moduleWorker':          moduleWorkerOk(),
      'secureContext':         !!window.isSecureContext,
    };
  }

  /* Module workers are the one capability pdf.js genuinely depends on that a
     browser can plausibly lack, and it cannot be feature-detected by looking
     at a property — you have to try to construct one. */
  function moduleWorkerOk() {
    try {
      var used = false;
      var url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
      var w = new Worker(url, { get type() { used = true; return 'module'; } });
      w.terminate();
      URL.revokeObjectURL(url);
      return used;
    } catch (e) { return 'error: ' + e.message; }
  }

  window.__diag = {
    log: function () { return log; },
    record: record,
    clear: function () { log = []; persist(); },

    report: function () {
      var lines = [];
      lines.push('Mobile Reader diagnostics');
      lines.push('generated ' + new Date().toISOString());
      lines.push('url       ' + location.href);
      lines.push('standalone ' + !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches));
      lines.push('ua        ' + navigator.userAgent);
      lines.push('screen    ' + screen.width + 'x' + screen.height + ' dpr' + (devicePixelRatio || 1));
      lines.push('sw        ' + (navigator.serviceWorker && navigator.serviceWorker.controller
                                  ? 'controlling' : 'not controlling'));
      lines.push('');
      lines.push('pdf worker  ' + (window.__pdfWorkerMode || 'not yet used'));
      lines.push('');
      lines.push('features');
      var f = features();
      Object.keys(f).forEach(function (k) {
        lines.push('  ' + (f[k] === true ? 'yes ' : f[k] === false ? 'NO  ' : '??  ') + k +
                   (typeof f[k] === 'string' ? ' (' + f[k] + ')' : ''));
      });
      lines.push('');
      if (!log.length) {
        lines.push('no errors recorded');
      } else {
        lines.push('errors (newest last)');
        log.forEach(function (e, i) {
          lines.push('');
          lines.push('--- ' + (i + 1) + ' [' + e.kind + '] ' + e.at);
          if (e.where) lines.push('    at ' + e.where);
          lines.push('    ' + (e.name ? e.name + ': ' : '') + e.message);
          if (e.stack) {
            String(e.stack).split('\n').slice(0, 12).forEach(function (s) {
              lines.push('      ' + s.trim());
            });
          }
        });
      }
      return lines.join('\n');
    },
  };
})();
