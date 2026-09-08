// Keep both memory use and body download time bounded, including responses
// without Content-Length (or with a length smaller than the received body).
async function readBoundedResponseText(response, { maximumBytes, signal, tooLargeMessage }) {
  let reader;
  let iterator;
  let completed = false;
  let abortListener;
  const abortError = () => signal?.reason || Object.assign(new Error('Request aborted'), { name: 'AbortError' });
  if (signal?.aborted) throw abortError();
  const aborted = new Promise((_resolve, reject) => {
    if (!signal) return;
    abortListener = () => reject(abortError());
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  // Cleanup must not wait on an unresponsive transport's cancel/return promise.
  const cancel = (operation) => {
    try { Promise.resolve(operation()).catch(() => {}); } catch { /* Best effort. */ }
  };
  const wait = (promise) => signal ? Promise.race([promise, aborted]) : promise;
  try {
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (contentLength > maximumBytes) throw new Error(tooLargeMessage);
    if (response.body?.getReader) reader = response.body.getReader();
    else if (response.body?.[Symbol.asyncIterator]) iterator = response.body[Symbol.asyncIterator]();
    if (!reader && !iterator) {
      // Compatibility with injected text-only transports; real fetch bodies
      // always use the streaming path above.
      const text = await wait(Promise.resolve().then(() => response.text()));
      if (Buffer.byteLength(text, 'utf8') > maximumBytes) throw new Error(tooLargeMessage);
      completed = true;
      return text;
    }

    // A separate Buffer per tiny chunk can consume far more memory than the
    // byte limit. Grow one bounded buffer instead.
    let contents = Buffer.allocUnsafe(Math.min(maximumBytes, 64 * 1024));
    let bytes = 0;
    while (true) {
      const part = await wait(reader ? reader.read() : iterator.next());
      if (part.done) break;
      const chunk = part.value;
      const offset = bytes;
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      if (bytes > maximumBytes) throw new Error(tooLargeMessage);
      if (bytes > contents.length) {
        const grown = Buffer.allocUnsafe(Math.min(maximumBytes, Math.max(bytes, contents.length * 2)));
        contents.copy(grown, 0, 0, offset);
        contents = grown;
      }
      Buffer.from(chunk).copy(contents, offset);
    }
    completed = true;
    return contents.subarray(0, bytes).toString('utf8');
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
    if (!completed) {
      if (reader) cancel(() => reader.cancel());
      else if (iterator?.return) cancel(() => iterator.return());
      else if (response.body?.cancel) cancel(() => response.body.cancel());
    }
    if (reader) {
      try { reader.releaseLock(); } catch { /* A mocked reader may still be pending. */ }
    }
  }
}

module.exports = { readBoundedResponseText };
