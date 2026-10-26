/** Merge concurrent reads only; no settled response is cached, and writes create a fresh epoch. */
export function sharedStatusRequest<T>(load: () => Promise<T>) {
	let pending: Promise<T> | undefined;
	return {
		get(): Promise<T> {
			if (!pending) {
				const request = Promise.resolve().then(load);
				pending = request;
				void request.then(() => { if (pending === request) pending = undefined; }, () => { if (pending === request) pending = undefined; });
			}
			return pending;
		},
		invalidate(): void { pending = undefined; },
	};
}
