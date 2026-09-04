/* Loaded as a classic script before any module, so these exist before pdf.js,
 * tesseract or app code runs.
 *
 * pdf.js 6 is built against a very recent JavaScript baseline, and the
 * features it assumes are not optional extras: they sit on the path every
 * document takes. Promise.withResolvers reached Safari in 17.4 and pdf.js
 * calls it in dozens of places; Promise.try reached 18.2 and the worker
 * message handler wraps every call in it; Math.sumPrecise reached 18.4 and
 * the font sanitiser sizes every glyph table with it; Map.getOrInsertComputed
 * reached 26. On an iPhone a version or two behind, importing a PDF fails
 * with the famously unhelpful "undefined is not a function" — or, in the
 * quieter case, getMetadata throws where the caller shrugs it off and the
 * document ends up titled after the journal's masthead.
 *
 * The pdf.js worker runs in its own realm and never sees this file, so the
 * same shim is injected into both vendored bundles by tools/vendor.ps1.
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

  /** Install a method only where it is missing, and leave it non-enumerable
   *  the way a real built-in is: a plain assignment to Map.prototype would
   *  show up in every `for (const k in map)` anywhere on the page. */
  function def(obj, name, value) {
    if (!obj || name in obj) return;
    Object.defineProperty(obj, name, { value: value, writable: true, configurable: true });
  }

  if (typeof Promise !== 'undefined' && !Promise.try) {
    Promise.try = function pTry(fn) {
      const args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve) { resolve(fn.apply(null, args)); });
    };
  }

  /* The upsert proposal, used when pdf.js walks a document's dictionaries.
   * Its absence is why getMetadata() throws on anything before Safari 26. */
  const getOrInsert = function (key, value) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  };
  const getOrInsertComputed = function (key, fn) {
    if (!this.has(key)) this.set(key, fn(key));
    return this.get(key);
  };
  for (const Ctor of [typeof Map === 'undefined' ? null : Map,
                      typeof WeakMap === 'undefined' ? null : WeakMap]) {
    if (!Ctor) continue;
    def(Ctor.prototype, 'getOrInsert', getOrInsert);
    def(Ctor.prototype, 'getOrInsertComputed', getOrInsertComputed);
  }

  /* Neumaier summation. The real thing is exactly rounded; this is not, but
   * pdf.js only sums glyph table sizes and character counts, which are
   * integers, and compensating costs one addition. */
  if (!Math.sumPrecise) {
    Math.sumPrecise = function sumPrecise(values) {
      let sum = 0, comp = 0;
      for (const x of values) {
        const t = sum + x;
        comp += Math.abs(sum) >= Math.abs(x) ? (sum - t) + x : (x - t) + sum;
        sum = t;
      }
      return sum + comp;
    };
  }

  if (typeof Uint8Array !== 'undefined') {
    def(Uint8Array.prototype, 'toHex', function toHex() {
      let s = '';
      for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, '0');
      return s;
    });

    if (typeof btoa !== 'undefined') {
      def(Uint8Array.prototype, 'toBase64', function toBase64() {
        // Chunked: String.fromCharCode.apply blows the argument limit on a
        // font-sized array.
        let s = '';
        for (let i = 0; i < this.length; i += 8192) {
          s += String.fromCharCode.apply(null, this.subarray(i, i + 8192));
        }
        return btoa(s);
      });
    }

    if (typeof atob !== 'undefined') {
      def(Uint8Array, 'fromBase64', function fromBase64(b64) {
        const s = atob(b64);
        const u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        return u;
      });
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
