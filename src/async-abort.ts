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
