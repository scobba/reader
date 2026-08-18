/* Loaded as a classic script before any module, so these exist before pdf.js,
 * tesseract or app code runs.
 *
 * The one that actually matters is Promise.withResolvers: pdf.js 6 calls it in
 * dozens of places and it only reached Safari in 17.4 (March 2024). On an
 * iPhone a version or two behind, importing a PDF fails with the famously
 * unhelpful "undefined is not a function". The rest are cheap insurance for
 * the same class of device.
 *
 * The pdf.js worker runs in its own realm and never sees this file, so the
 * same shim is injected into the vendored worker bundle by tools/vendor.ps1.
 */
(function () {
  'use strict';

  if (typeof Promise !== 'undefined' && !Promise.withResolvers) {
    Promise.withResolvers = function withResolvers() {
      let resolve, reject;
      const promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }

  const AP = Array.prototype;

  if (!AP.findLast) {
    Object.defineProperty(AP, 'findLast', {
      configurable: true, writable: true,
      value: function findLast(fn, thisArg) {
        for (let i = this.length - 1; i >= 0; i--) {
          if (fn.call(thisArg, this[i], i, this)) return this[i];
        }
        return undefined;
      },
    });
  }

  if (!AP.findLastIndex) {
    Object.defineProperty(AP, 'findLastIndex', {
      configurable: true, writable: true,
      value: function findLastIndex(fn, thisArg) {
        for (let i = this.length - 1; i >= 0; i--) {
          if (fn.call(thisArg, this[i], i, this)) return i;
        }
        return -1;
      },
    });
  }

  if (!AP.at) {
    Object.defineProperty(AP, 'at', {
      configurable: true, writable: true,
      value: function at(i) {
        const n = Math.trunc(i) || 0;
        return this[n < 0 ? this.length + n : n];
      },
    });
  }
})();
