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

  /* Async iteration over a ReadableStream — `for await (const chunk of stream)`.
   *
   * Chrome and Firefox ship it; WebKit does not, and that single gap is what
   * stops this app reading a PDF on an iPhone. pdf.js streams text content out
   * of the worker and consumes it with exactly that loop, so without this the
   * very first getTextContent() throws and no document can ever be read.
   *
   * Implemented per the Streams standard's ReadableStreamAsyncIteratorPrototype:
   * next() delegates to a reader, and return() cancels unless preventCancel. */
  if (typeof ReadableStream !== 'undefined' &&
      typeof Symbol !== 'undefined' && Symbol.asyncIterator &&
      !ReadableStream.prototype[Symbol.asyncIterator]) {

    const values = function values(options) {
      const preventCancel = !!(options && options.preventCancel);
      const reader = this.getReader();
      return {
        next: function () {
          return reader.read().then(function (result) {
            if (result.done) reader.releaseLock();
            return result;
          }, function (err) {
            reader.releaseLock();
            throw err;
          });
        },
        return: function (value) {
          if (preventCancel) {
            reader.releaseLock();
            return Promise.resolve({ done: true, value: value });
          }
          return reader.cancel(value).then(function () {
            reader.releaseLock();
            return { done: true, value: value };
          });
        },
        throw: function (err) {
          reader.releaseLock();
          return Promise.reject(err);
        },
        [Symbol.asyncIterator]: function () { return this; },
      };
    };

    const def = { value: values, writable: true, configurable: true };
    Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, def);
    if (!ReadableStream.prototype.values) {
      Object.defineProperty(ReadableStream.prototype, 'values', def);
    }
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
