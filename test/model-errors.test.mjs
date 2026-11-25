/* When to throw a voice model away.
 *
 *   node --test
 *
 * Both ways of getting this wrong cost the listener something. Too narrow and
 * a damaged download goes on failing with an error about protobufs until
 * someone works out that the voice has to be deleted by hand. Too wide and a
 * passing failure — out of memory on a phone, a worker killed mid-call —
 * throws away 63 MB they have to fetch again over mobile data.
 *
 * The real strings are what matter here, so the first case is the one that was
 * reported, copied verbatim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isModelUnreadable } from '../js/tts/model-errors.js';

test('the reported error is recognised', () => {
  assert.ok(isModelUnreadable(
    "Can't create a session. ERROR_CODE: 2, ERROR_MESSAGE: No graph was found in the protobuf."));
});

test('the other ways onnxruntime reports an unreadable model', () => {
  for (const msg of [
    'Failed to load model because protobuf parsing failed.',
    'Load model from <stream> failed: Invalid protobuf.',
    'invalid model: tensor count mismatch',
  ]) {
    assert.ok(isModelUnreadable(msg), `should match: ${msg}`);
  }
});

test('an Error object works as well as a string', () => {
  assert.ok(isModelUnreadable(new Error('No graph was found in the protobuf')));
});

test('a passing failure does not cost someone their download', () => {
  // Every one of these is survivable, and the model on disk is fine. Deleting
  // it would turn a retry into a 63 MB download.
  for (const msg of [
    "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Out of memory",
    'Aborted(). Build with -sASSERTIONS for more info.',
    'RuntimeError: memory access out of bounds',
    'The Piper voice engine did not start. Check that vendor/piper exists.',
    'Download of model stopped at 41123840 of 63221248 bytes',
    'Download failed for model: HTTP 502 Bad Gateway',
    'NetworkError: Failed to fetch',
    'QuotaExceededError: The quota has been exceeded.',
  ]) {
    assert.ok(!isModelUnreadable(msg), `should NOT match: ${msg}`);
  }
});

test('nothing at all is not an unreadable model', () => {
  for (const nothing of [undefined, null, '', {}, new Error()]) {
    assert.equal(isModelUnreadable(nothing), false);
  }
});
