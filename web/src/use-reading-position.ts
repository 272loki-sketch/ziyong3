import { useLayoutEffect, useRef, type RefObject } from "react";
import { getReadingPosition } from "./reading-preference.ts";

export function syncReadingAnchoring(list: HTMLDivElement, following: boolean) {
	// Native anchoring owns ordinary backscroll; never compete with a managed correction.
	list.style.overflowAnchor = following || list.dataset.readingPrepend === "true" ? "none" : "auto";
}

// Navigation owns initial positioning; content/iframe growth only owns bottom follow.
export function useReadingNavigation({ listRef, atBottomRef, setAtBottom, welcome, sessionId, navigation }: {
	listRef: RefObject<HTMLDivElement | null>;
	atBottomRef: RefObject<boolean>;
	setAtBottom: (value: boolean) => void;
	welcome: boolean;
	sessionId: string;
	navigation: number;
}) {
	const pending = useRef<number | null>(null);
	const lastScrollTop = useRef(0);
	const cancel = () => {
		if (pending.current !== null) cancelAnimationFrame(pending.current);
		pending.current = null;
	};
	useLayoutEffect(() => {
		cancel();
		const el = listRef.current;
		if (!el) return;
		const latest = !welcome && !!sessionId && getReadingPosition() === "latest";
		atBottomRef.current = latest;
		setAtBottom(latest);
		syncReadingAnchoring(el, latest);
		el.scrollTop = latest ? el.scrollHeight : 0;
		lastScrollTop.current = el.scrollTop;
		// One cancellable layout pass, never an unbounded delayed navigation retry.
		pending.current = requestAnimationFrame(() => {
			pending.current = null;
			if (latest && atBottomRef.current) {
				el.scrollTop = el.scrollHeight;
				lastScrollTop.current = el.scrollTop;
			}
		});
		const flow = el.firstElementChild;
		const observer = new ResizeObserver(() => {
			if (!welcome && sessionId && atBottomRef.current) {
				el.scrollTop = el.scrollHeight;
				lastScrollTop.current = el.scrollTop;
			}
		});
		if (flow) observer.observe(flow);
		observer.observe(el);
		return () => { cancel(); observer.disconnect(); };
	}, [welcome, sessionId, navigation, listRef, atBottomRef, setAtBottom]);

	const onScroll = () => {
		const el = listRef.current;
		if (!el || welcome) return;
		// A queued programmatic scroll can arrive after iframe growth but before resize delivery.
		// It is not a user departure from the bottom.
		if (el.scrollTop === lastScrollTop.current) return;
		lastScrollTop.current = el.scrollTop;
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
		if (!near) cancel();
		atBottomRef.current = near;
		syncReadingAnchoring(el, near);
		setAtBottom(near);
	};
	const jumpToBottom = () => {
		cancel();
		const el = listRef.current;
		if (!el || welcome) return;
		atBottomRef.current = true;
		setAtBottom(true);
		syncReadingAnchoring(el, true);
		el.scrollTop = el.scrollHeight;
		lastScrollTop.current = el.scrollTop;
	};
	return { onScroll, jumpToBottom };
}
