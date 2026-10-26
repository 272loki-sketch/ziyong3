/** Stop awaiting even when an upstream promise ignores cancellation; consume late rejections. */
export function abortable<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
	const pending = Promise.resolve(work);
	if (!signal) return pending;
	if (signal.aborted) { void pending.catch(() => undefined); return Promise.reject(signal.reason ?? new Error("操作已取消")); }
	return new Promise<T>((resolve, reject) => {
		const stop = () => { signal.removeEventListener("abort", stop); reject(signal.reason ?? new Error("操作已取消")); };
		signal.addEventListener("abort", stop, { once: true });
		pending.then(value => { signal.removeEventListener("abort", stop); if (signal.aborted) stop(); else resolve(value); }, error => { signal.removeEventListener("abort", stop); reject(error); });
	});
}

/** Drain with cancellation without waiting for an uncooperative producer's return(). */
export async function* abortableEvents<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
 const iterator = source[Symbol.asyncIterator]();
 try {
  while (true) {
   const next = await abortable(iterator.next(), signal);
   if (next.done) return;
   yield next.value;
  }
 } finally {
  try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* best effort */ }
 }
}
