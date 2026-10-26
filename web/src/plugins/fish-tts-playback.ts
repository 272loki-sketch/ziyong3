/** One explicit Fish playback at a time, across messages and settings previews. */
let current: (() => void) | undefined;
export function claimFishPlayback(stop: () => void): () => void {
	if (current !== stop) current?.();
	current = stop;
	return () => { if (current === stop) current = undefined; };
}
export function stopFishPlayback(): void { const stop = current; current = undefined; stop?.(); }

export function fishTtsSettingsChanged(): void { stopFishPlayback(); window.dispatchEvent(new Event("liyuan:fish-tts-settings-changed")); }
