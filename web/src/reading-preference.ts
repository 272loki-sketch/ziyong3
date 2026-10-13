import { useSyncExternalStore } from "react";

export type ReadingPosition = "latest" | "start";
export const READING_POSITION_KEY = "liyuan.reading-position";
const changed = "liyuan:reading-position";

export function getReadingPosition(): ReadingPosition {
	try { return localStorage.getItem(READING_POSITION_KEY) === "start" ? "start" : "latest"; }
	catch { return "latest"; }
}

export function setReadingPosition(value: ReadingPosition) {
	localStorage.setItem(READING_POSITION_KEY, value);
	window.dispatchEvent(new Event(changed));
}

function subscribe(listener: () => void) {
	window.addEventListener(changed, listener);
	window.addEventListener("storage", listener);
	return () => {
		window.removeEventListener(changed, listener);
		window.removeEventListener("storage", listener);
	};
}

export function useReadingPosition() {
	return useSyncExternalStore(subscribe, getReadingPosition, () => "latest" as const);
}
