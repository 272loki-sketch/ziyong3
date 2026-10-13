import { createContext, useContext, useEffect, useRef, useState, type RefObject } from "react";

type Leave = (next: () => void) => void;
export const PluginLeaveContext = createContext<Leave | null>(null);

/** Drain only the known same-origin adapters. Never infer persistence from a delay. */
export async function flushPluginFrame(frame: HTMLIFrameElement): Promise<void> {
	const hostWindow = frame.contentWindow as (Window & {
		LiyuanNpcParallel?: { flush?: () => Promise<void> };
		LiyuanVeridisRewrite?: { flush?: () => Promise<void>; failed?: boolean; pending?: number };
		LiyuanTavernPlugins?: { host?: { flush?: () => Promise<void> } };
	}) | null;
	const host = hostWindow?.LiyuanNpcParallel ?? hostWindow?.LiyuanVeridisRewrite ?? hostWindow?.LiyuanTavernPlugins?.host;
	if (!host?.flush) {
		// An inaccessible/loading canvas has never been offered for editing.
		if (frame.getAttribute("aria-hidden") === "true") return;
		throw new Error("原设置宿主未提供可确认的保存接口，页面已保留；不能确认设置已保存。");
	}
	do {
		await host.flush();
		if ("failed" in host && host.failed) throw new Error("原设置保存失败，页面已保留。请在原页核对错误；不会自动丢弃未保存设置。");
	} while ("pending" in host && typeof host.pending === "number" && host.pending > 0);
}

export function usePluginLeave(root: RefObject<HTMLElement | null>, contextTick: number, waitMs = 15_000) {
	const parentLeave = useContext(PluginLeaveContext);
	const epoch = useRef(0);
	const currentContext = useRef(contextTick);
	currentContext.current = contextTick;
	type Attempt = { next: () => void; frame: HTMLIFrameElement; document: Document | null; tick: number; token: number; restore: () => void; failed: boolean };
	const attempt = useRef<Attempt | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		setError(""); setPending(false);
		return () => { epoch.current++; attempt.current?.restore(); attempt.current = null; };
	}, [contextTick]);
	const valid = (value: Attempt) => attempt.current === value && value.tick === currentContext.current && value.token === epoch.current
		&& value.frame.isConnected && root.current?.querySelector("iframe") === value.frame && value.frame.contentDocument === value.document;
	const leave: Leave = next => {
		if (parentLeave) { parentLeave(next); return; }
		// Keep the original destination after failure; another close must not retry writes.
		if (attempt.current) return;
		const frame = root.current?.querySelector<HTMLIFrameElement>("iframe");
		if (!frame) { next(); return; }
		setPending(true); setError("");
		const wasInert = frame.inert;
		let timer: ReturnType<typeof setTimeout>;
		const value: Attempt = { next, frame, document: frame.contentDocument, tick: contextTick, token: ++epoch.current, failed: false,
			restore: () => { clearTimeout(timer); frame.inert = wasInert; } };
		attempt.current = value;
		const fail = (message: string) => {
			if (!valid(value) || value.failed) return;
			value.failed = true; value.restore(); setPending(false); setError(message);
		};
		timer = setTimeout(() => fail("等待保存确认超时，结果未知，设置可能已经保存。页面已恢复操作；此超时不取消服务端请求，离开也不会撤销已保存的更改。"), waitMs);
		// Commit blur/change handlers before draining, then prevent edits during the drain.
		try { (frame.contentDocument?.activeElement as HTMLElement | null)?.blur(); } catch { /* flush reports inaccessible hosts */ }
		frame.inert = true;
		void flushPluginFrame(frame).then(() => {
			if (!valid(value) || value.failed) return;
			value.restore(); attempt.current = null; setPending(false); next();
		}).catch(cause => {
			fail((cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string" ? cause.message : "设置保存未完成，页面已保留。") + " 离开不会撤销已保存的更改，也不表示服务端请求已取消。");
		});
	};
	const discard = () => {
		const value = attempt.current;
		if (!value?.failed || !valid(value)) return;
		if (!window.confirm("放弃未确认的更改并离开？设置可能已经保存。离开不会撤销已保存的更改，也不会取消服务端请求。")) return;
		if (!valid(value)) return;
		epoch.current++; value.restore(); attempt.current = null; setError(""); setPending(false); value.next();
	};
	return { leave, pending, error, discard };
}

export function PluginLeaveError({ error, discard }: { error: string; discard: () => void }) {
	return error ? <div className="npc-parallel-feedback is-error" role="alert"><p>{error}</p><button type="button" className="npc-parallel-button" onClick={discard}>放弃未确认的更改并离开</button></div> : null;
}
