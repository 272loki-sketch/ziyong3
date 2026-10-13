/** Static dossier display only. Uses the existing read-only plugin context; no runtime/parse/recover calls. */
import { useContext, useEffect, useState } from "react";
import { selectDossierSnapshot } from "../cardDossierView.ts";
import { HtmlFrame } from "./HtmlFrame.tsx";
import { TavernEntryContext } from "./TavernMessageFrame.tsx";

export function DossierMessageFrame({ html, title, collapsible, variables, readOnly = false }: { html: string; title?: string; collapsible?: boolean; variables?: unknown; readOnly?: boolean }) {
	const { entryId, entryScope } = useContext(TavernEntryContext) ?? {};
	const key = JSON.stringify([entryId, entryScope, html]);
	const [saved, setSaved] = useState<{ key: string; data: Record<string, unknown> | null } | null>(null);
	useEffect(() => {
		if (readOnly || !entryId || !entryScope) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;
		let request = 0;
		const refresh = async () => {
			const generation = ++request;
			if (timer) clearTimeout(timer);
			try {
				const response = await fetch("/api/tavern-plugins/context", { method: "GET", cache: "no-store", signal: controller.signal });
				if (!response.ok) throw new Error("snapshot unavailable");
				const context: unknown = await response.json();
				if (controller.signal.aborted || generation !== request) return;
				const data = selectDossierSnapshot(context, { entryId, entryScope });
				setSaved({ key, data });
				// Author delivery can reach the UI before native MVU settlement. Only re-read saved state.
				// Bounded backoff avoids a per-frame context storm; it never initiates or repeats settlement.
				if (!data && ++attempt < 15) timer = setTimeout(() => void refresh(), Math.min(30_000, 2_000 * 2 ** (attempt - 1)));
			} catch {
				if (!controller.signal.aborted && generation === request) setSaved({ key, data: null });
			}
		};
		const onChanged = () => { attempt = 0; void refresh(); };
		const onSettled = (event: Event) => {
			const source = (event as CustomEvent<{ entryId?: string; entryScope?: string }>).detail;
			if (source?.entryId === entryId && source?.entryScope === entryScope) onChanged();
		};
		void refresh();
		window.addEventListener("liyuan:tavern-plugins-changed", onChanged);
		window.addEventListener("liyuan:turn-state-refreshed", onSettled);
		return () => {
			controller.abort(); if (timer) clearTimeout(timer);
			window.removeEventListener("liyuan:tavern-plugins-changed", onChanged);
			window.removeEventListener("liyuan:turn-state-refreshed", onSettled);
		};
	}, [key, entryId, entryScope, readOnly]);
	const snapshot = !readOnly && saved?.key === key ? saved.data : null;
	const status = !readOnly && entryId && entryScope && !snapshot ? (saved?.key === key ? "unavailable" : "loading") : undefined;
	return <HtmlFrame html={html} scripts={false} seamless title={title} collapsible={collapsible} variables={variables} dossierSnapshot={snapshot} dossierStatus={status} />;
}

/** Delegated parsing removes author update tags; expose only this reply's stored-state reader. */
export function DelegatedDossierFrame({ html }: { html: string }) {
	const binding = useContext(TavernEntryContext);
	const [enabled, setEnabled] = useState<string | null>(null);
	const key = JSON.stringify(binding);
	useEffect(() => {
		if (!binding?.entryId || !binding.entryScope) return;
		const controller = new AbortController();
		const refresh = async () => {
			try {
				const response = await fetch("/api/tavern-plugins/context", { cache: "no-store", signal: controller.signal });
				if (!response.ok) return;
				const context = await response.json();
				if (controller.signal.aborted) return;
				const active = context.scopeKey === binding.entryScope && context.visibleEntryIds?.includes(binding.entryId)
					&& context.mvu?.enabled && context.plugins?.some((plugin: { id: string; enabled: boolean }) => plugin.id === "helper" && plugin.enabled)
					&& context.state?.extensionSettings?.mvu_settings?.更新方式 === "额外模型解析";
				setEnabled(active ? key : null);
			} catch { /* No display on missing or stale binding. */ }
		};
		void refresh();
		window.addEventListener("liyuan:tavern-plugins-changed", refresh);
		return () => { controller.abort(); window.removeEventListener("liyuan:tavern-plugins-changed", refresh); };
	}, [key, binding?.entryId, binding?.entryScope]);
	return enabled === key ? <DossierMessageFrame html={html} /> : null;
}
