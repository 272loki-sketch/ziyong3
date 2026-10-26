import { useContext, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { workspaceStale } from "../workspace.ts";
import { TavernEntryContext } from "./TavernMessageFrame.tsx";
import type { NovelAiImage, NovelAiStatus } from "../../../src/novelai-types.ts";

/** Cache reads are automatic; paid generation is only reachable from this explicit click. */
export function NovelAiImageControls({ prompt, title, readOnly, incomplete, hasImage, onGenerated }: {
	prompt: string; title: string; readOnly: boolean; incomplete?: boolean; hasImage: boolean; onGenerated: (src: string) => void;
}) {
	const entry = useContext(TavernEntryContext), entryId = entry?.entryId, entryScope = entry?.entryScope;
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	const operation = useRef<AbortController | null>(null), mounted = useRef(false);
	useEffect(() => {
		mounted.current = true; setError(""); setBusy(false);
		const controller = new AbortController();
		if (!incomplete && entryId && entryScope && !workspaceStale()) {
			const query = new URLSearchParams({ prompt, entryId, entryScope });
			void api<{ src: string | null }>(`/api/novelai/cached?${query}`, { signal: controller.signal })
				.then(result => { if (!controller.signal.aborted && result.src && /^\/media\/nai-[a-f0-9]{64}\.(png|jpg|webp)$/.test(result.src)) onGenerated(result.src); })
				.catch(() => { /* Missing cache never causes generation or an automatic retry. */ });
		}
		const stop = () => { controller.abort(); operation.current?.abort(); };
		window.addEventListener("liyuan:workspace-changed", stop);
		return () => { mounted.current = false; stop(); operation.current = null; window.removeEventListener("liyuan:workspace-changed", stop); };
	}, [prompt, entryId, entryScope, incomplete, onGenerated]);
	if (readOnly || incomplete || !entryId || !entryScope || hasImage) return null;
	const generate = async () => {
		if (operation.current || workspaceStale()) return;
		const controller = new AbortController(); operation.current = controller;
		setBusy(true); setError("");
		try {
			const status = await api<NovelAiStatus>("/api/novelai", { signal: controller.signal });
			if (!status.config.enabled || !status.apiKeyConfigured) throw new Error("请先在设置 → NovelAI 生图中明确启用并保存连接。");
			const result = await api<NovelAiImage>("/api/novelai/generate", {
				method: "POST", signal: controller.signal,
				body: JSON.stringify({ prompt, revision: status.revision, binding: status.binding, entryId, entryScope }),
			});
			if (!/^\/media\/nai-[a-f0-9]{64}\.(png|jpg|webp)$/.test(result.src)) throw new Error("生图服务未返回有效的本地图片地址");
			if (mounted.current && !controller.signal.aborted && !workspaceStale()) onGenerated(result.src);
		} catch (err) {
			if (mounted.current && operation.current === controller) setError(controller.signal.aborted ? "已取消；如果请求已发送，仍可能计费。不会自动重试。" : err instanceof Error ? err.message : "生图失败，未自动重试");
		} finally {
			if (operation.current === controller) { operation.current = null; if (mounted.current) setBusy(false); }
		}
	};
	return <div className="nai-image-controls">
		<button type="button" className="drawer-btn nai-generate-btn" disabled={busy || workspaceStale()} onClick={() => void generate()}>{busy ? "排队 / 生图中…" : `生成图片 · ${title}`}</button>
		{busy && <button type="button" className="drawer-btn" onClick={() => operation.current?.abort()}>取消</button>}
		{error && <div className="panel-error" role="alert">{error}</div>}
	</div>;
}
