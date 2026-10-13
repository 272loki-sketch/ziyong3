import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getReadingPosition } from "./reading-preference.ts";
import { syncReadingAnchoring } from "./use-reading-position.ts";

const BATCH = 50;

export function useReadingHistory({ count, sessionId, welcome, navigation, listRef, atBottomRef, setAtBottom }: {
	count: number;
	sessionId: string;
	welcome: boolean;
	navigation: number;
	listRef: RefObject<HTMLDivElement | null>;
	atBottomRef: RefObject<boolean>;
	setAtBottom: (value: boolean) => void;
}) {
	const [range, setRange] = useState({ sessionId: "", initialized: false, start: 0, navigation });
	const anchor = useRef<{ element: HTMLElement; top: number; scrollTop: number } | null>(null);
	let current = range;
	if (range.sessionId !== sessionId || (!range.initialized && !welcome && !!sessionId)) {
		current = { sessionId, initialized: !welcome && !!sessionId, navigation,
			start: getReadingPosition() === "latest" ? Math.max(0, count - BATCH) : 0 };
	} else if (navigation !== range.navigation) {
		// An explicit return can expose more history, but never recycle mounted scripts.
		current = { ...range, navigation, start: getReadingPosition() === "start" ? 0 : range.start };
	}
	if (current.start > 0 && current.start >= count) current = { ...current, start: Math.max(0, count - BATCH) };
	if (current !== range) setRange(current);
	const start = current.start;

	useLayoutEffect(() => {
		anchor.current = null;
		const list = listRef.current;
		if (!list || welcome) return;
		const cancel = () => {
			anchor.current = null;
			delete list.dataset.readingPrepend;
			syncReadingAnchoring(list, atBottomRef.current);
		};
		const onScroll = () => {
			if (anchor.current && Math.abs(list.scrollTop - anchor.current.scrollTop) > 2) cancel();
		};
		const preserve = () => {
			const saved = anchor.current;
			if (!saved) return;
			if (!saved.element.isConnected || atBottomRef.current) { cancel(); return; }
			// A scrollbar drag or other external scroll relinquishes the anchor too.
			if (Math.abs(list.scrollTop - saved.scrollTop) > 2) { cancel(); return; }
			list.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
			saved.scrollTop = list.scrollTop;
		};
		const observer = new ResizeObserver(preserve);
		if (list.firstElementChild) observer.observe(list.firstElementChild);
		list.addEventListener("wheel", cancel, { passive: true });
		list.addEventListener("touchstart", cancel, { passive: true });
		list.addEventListener("pointerdown", cancel);
		list.addEventListener("keydown", cancel);
		list.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			cancel(); observer.disconnect();
			list.removeEventListener("wheel", cancel);
			list.removeEventListener("touchstart", cancel);
			list.removeEventListener("pointerdown", cancel);
			list.removeEventListener("keydown", cancel);
			list.removeEventListener("scroll", onScroll);
		};
	}, [sessionId, welcome, navigation, listRef, atBottomRef]);
	useLayoutEffect(() => {
		const saved = anchor.current;
		const list = listRef.current;
		if (!saved || !list || !saved.element.isConnected) return;
		list.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
		saved.scrollTop = list.scrollTop;
	}, [start, listRef]);

	const loadEarlier = () => {
		const list = listRef.current;
		if (!list || start === 0) return;
		const top = list.getBoundingClientRect().top;
		const element = Array.from(list.querySelectorAll<HTMLElement>("[data-reading-block]"))
			.find(node => node.getBoundingClientRect().bottom > top);
		anchor.current = element ? { element, top: element.getBoundingClientRect().top, scrollTop: list.scrollTop } : null;
		atBottomRef.current = false;
		if (anchor.current) list.dataset.readingPrepend = "true";
		syncReadingAnchoring(list, false);
		setAtBottom(false);
		setRange(value => ({ ...value, start: Math.max(0, value.start - BATCH) }));
	};
	return { start, loadEarlier };
}
