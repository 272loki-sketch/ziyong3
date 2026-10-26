let pending: Promise<unknown> | undefined;

/** Prepare only the fixed host worker while browsing the catalogue. Never load a plugin or story. */
export function prepareTavernManager(): void {
	if (typeof navigator === "undefined" || !navigator.serviceWorker || pending) return;
	pending = navigator.serviceWorker.register("/tavern-plugin-sw.js", {
		scope: "/tavern-plugin-host.html", updateViaCache: "none",
	}).catch(() => { /* The iframe retries, and restricted browsers retain their fallback. */ })
		.finally(() => { pending = undefined; });
}
