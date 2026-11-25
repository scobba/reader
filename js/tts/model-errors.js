/* Telling a damaged voice model from a bad moment.
 *
 * onnxruntime reports an unparseable model from the wrong end of the problem.
 * The download failed, silently, possibly days ago; what the listener sees is
 *
 *   Can't create a session. ERROR_CODE: 2,
 *   ERROR_MESSAGE: No graph was found in the protobuf.
 *
 * which names neither the voice nor the download, and — because the file stays
 * in the Origin Private File System — says the same thing every time until
 * someone thinks to delete the voice by hand.
 *
 * So the engine throws the file away when it sees this and asks for it again.
 * That makes the match a decision with a cost on both sides: too narrow and
 * the reader stays stuck, too wide and a passing failure throws away a 63 MB
 * download. It is therefore matched on the parser's own vocabulary — a model
 * that could not be read as a model — and never on the generic wrapper around
 * it. "Can't create a session" on its own is not enough: running out of memory
 * says that too, and memory comes back.
 */

const UNREADABLE = [
  /no graph was found/i,       // onnxruntime: the protobuf parsed, but held no model
  /protobuf parsing failed/i,
  /failed to load model/i,
  /invalid model/i,
  /invalid protobuf/i,
];

/**
 * Does this error mean the model file itself cannot be read?
 * @param {unknown} err  an Error, or a message
 * @returns {boolean}
 */
export function isModelUnreadable(err) {
  const text = typeof err === 'string' ? err : (err && err.message) || '';
  return UNREADABLE.some(re => re.test(text));
}
