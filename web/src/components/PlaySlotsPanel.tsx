import { switchMainWorkspace } from "./WorkspaceBar.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CardsResponse } from "../api.ts";
import { DeliverySessionGate, newMessageId, PromptOutbox, type OutboxItem, type OutboxStorage } from "../ws-lifecycle.ts";
import type { GenerationMode } from "../generation-mode.ts";
import type { WireMsg } from "../wire.ts";
import { IconClose } from "./icons.tsx";

export interface PlaySlot { owner?: "main" | "parallel"; card?:string; lease?:string; id: string; name: string; state: "paused" | "starting" | "pausing" | "running" | "error"; busy: boolean; settling: boolean; error?: string }
type SlotPacket = { type: string; sessionId?: string; charName?: string; streaming?: boolean; settling?: boolean; deliveryProtocol?: number; messages?: WireMsg[]; message?: WireMsg; messageId?: string; status?: "accepted" | "rejected"; reason?: string; text?: string; state?: string; delta?: string; kind?: string; draft?: boolean; reset?: boolean; segments?: string[]; generationMode?: GenerationMode };

/** Browser storage, delivery gates and socket are all scoped to one independently running card. */
function PlaySlotPane({ slot, active }: { slot: PlaySlot; active: boolean }) {
	const [messages, setMessages] = useState<WireMsg[]>([]);
	const [visibleCount, setVisibleCount] = useState(80);
	const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(`liyuan.play-slot.${slot.id}.draft`) ?? ""; } catch { return ""; } });
	const storedMode = useRef<GenerationMode | null>(null);
	if (storedMode.current === null) {
		try { const saved = sessionStorage.getItem(`liyuan.play-slot.${slot.id}.mode`); if (saved === "direct" || saved === "director") storedMode.current = saved; } catch { /* The input still binds its explicit selected mode. */ }
	}
	const [fullDraft,setFullDraft]=useState(()=>{try{return !!JSON.parse(sessionStorage.getItem(`liyuan.play-slot.${slot.id}.plot-draft`)??"null");}catch{return false;}});
 const [mode, setMode] = useState<GenerationMode>(storedMode.current ?? "director");
	const modeChosen = useRef(storedMode.current !== null);
	const [connected, setConnected] = useState(false), [busy, setBusy] = useState(false), [settling, setSettling] = useState(false);
	const [notice, setNotice] = useState("");
	const [outbox, setOutbox] = useState<OutboxItem[]>([]);
	const [live, setLive] = useState("");
	const socket = useRef<WebSocket | null>(null), gate = useRef(new DeliverySessionGate());
	const box = useRef<PromptOutbox | null>(null);
	const body = useRef<HTMLDivElement>(null);
	if (!box.current) {
		const storage: OutboxStorage = { getItem: key => sessionStorage.getItem(`liyuan.play-slot.${slot.id}.${key}`), setItem: (key, value) => sessionStorage.setItem(`liyuan.play-slot.${slot.id}.${key}`, value) };
		box.current = new PromptOutbox(storage);
	}
	const refresh = () => { setOutbox([...box.current!.items]); if (box.current!.error) setNotice(box.current!.error); };
	const flush = () => {
		if (socket.current?.readyState !== WebSocket.OPEN) return;
		for (const frame of gate.current.frames(box.current!, "prompt")) {
   if(frame.type==="prompt"&&frame.plotChoice){box.current!.ack(frame.messageId,frame.sessionId,"rejected","该输入带有主窗口剧情方向，请用主窗口继续提交；不会去掉绑定后重放");refresh();continue;}
   socket.current.send(JSON.stringify(frame)); gate.current.sent.add(frame.messageId); }
	};
	useEffect(() => {
		if (slot.state !== "running" || slot.owner === "main") { setConnected(false); return; }
		let disposed = false, retry: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
		let delay = 1500;
		const connect = () => {
			if (disposed) return;
			gate.current.disconnect();
			const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/play-slots/${slot.id}/ws${slot.lease?`?slotLease=${encodeURIComponent(slot.lease)}`:""}`); socket.current = ws;
			watchdog = setTimeout(() => { if (!gate.current.ready.has("prompt")) ws.close(); }, 10_000);
			ws.onmessage = event => {
				if (disposed || socket.current !== ws) return;
				let frame: SlotPacket; try { frame = JSON.parse(event.data); } catch { return; }
				if (frame.type === "hello" && frame.sessionId) {
					if (watchdog) clearTimeout(watchdog); delay = 1500;
					gate.current.hello("prompt", frame.sessionId, frame.deliveryProtocol); box.current!.align("prompt", frame.sessionId);
					for (const message of frame.messages ?? []) if (message.messageId) box.current!.ack(message.messageId, frame.sessionId, "accepted");
					setMessages(frame.messages ?? []); setConnected(true); setBusy(frame.streaming === true); setSettling(frame.settling === true); setLive("");
					if (!modeChosen.current && (frame.generationMode === "direct" || frame.generationMode === "director")) { setMode(frame.generationMode); modeChosen.current = true; }
					refresh(); flush();
				} else if (frame.type === "prompt_ack" && frame.messageId && frame.sessionId && frame.status) {
					box.current!.ack(frame.messageId, frame.sessionId, frame.status, frame.reason); refresh(); if (frame.status === "rejected") setNotice(frame.reason ?? "输入未受理，草稿保留");
				} else if (frame.type === "message" && frame.message) {
					const message = frame.message; setMessages(prior => [...prior, message]); if (message.channel === "narrative") setLive("");
				} else if (frame.type === "agent") { setBusy(frame.state !== "end"); setSettling(frame.state === "settling"); }
				else if (frame.type === "delta" && frame.kind === "text") setLive(prior => (frame.reset ? "" : prior) + (frame.delta ?? ""));
				else if (frame.type === "draft_resync") setLive((frame.segments ?? []).join("\n\n"));
				else if (frame.type === "stream") setLive("");
				else if (frame.type === "notify" || frame.type === "error") setNotice(frame.text ?? "");
			};
			ws.onclose = event => {
				if (disposed || socket.current !== ws) return;
				if (watchdog) clearTimeout(watchdog); setConnected(false); gate.current.disconnect(); box.current!.disconnect(); refresh();
				if(event.code===4410){setNotice("该存档已交由主窗口接管，输入草稿保留");return;}
    retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 10_000);
			};
			ws.onerror = () => { setNotice("卡位连接暂不可用，草稿保留，将尝试重连"); };
		};
		connect(); refresh();
		return () => { disposed = true; if (retry) clearTimeout(retry); if (watchdog) clearTimeout(watchdog); socket.current?.close(); gate.current.disconnect(); };
	}, [slot.id, slot.state, slot.owner, slot.lease]);
	useEffect(() => { if (active && body.current) body.current.scrollTop = body.current.scrollHeight; }, [messages, active]);
	const changeDraft = (value: string) => {
		setDraft(value);
		try { sessionStorage.setItem(`liyuan.play-slot.${slot.id}.draft`, value); }
		catch { setNotice("输入框草稿未能保存；发送前仍会检查可靠投递日志，请保留副本"); }
	};
	const restoreItem = (item: OutboxItem) => {
  if(item.frame.type!=="prompt")return;
  try{
   if(item.frame.plotChoice){sessionStorage.setItem(`liyuan.play-slot.${slot.id}.plot-draft`,JSON.stringify({choice:item.frame.plotChoice,title:"恢复的已选剧情"}));setFullDraft(true);}
   if(item.frame.generationMode){sessionStorage.setItem(`liyuan.play-slot.${slot.id}.mode`,item.frame.generationMode);setMode(item.frame.generationMode);modeChosen.current=true;}
   sessionStorage.setItem(`liyuan.play-slot.${slot.id}.draft`,item.frame.text);setDraft(item.frame.text);
   box.current!.discard(item.frame.messageId);refresh();
  }catch{setNotice("未能安全保存恢复草稿，原投递记录保留，请复制后在主窗口处理");}
 };
 const send = () => {
		const sessionId = gate.current.targets.prompt;
		if (fullDraft || !draft.trim() || !sessionId || !connected || !gate.current.canDeliverReliably("prompt")) return;
		if (draft.trimStart().startsWith("/")) { setNotice("并行面板只支持普通正文输入，不执行管理命令。输入仍保留。"); return; }
		const result = box.current!.enqueue({ type: "prompt", text: draft, sessionId, messageId: newMessageId(), generationMode: mode }, true);
		refresh();
		if (!result.accepted) { setNotice(result.reason); return; }
		changeDraft(""); setNotice(""); flush();
	};
	return <section className="play-slot-pane" hidden={!active} aria-label={`${slot.name}独立游玩`}>
		<header><strong>{slot.name}</strong><span role="status">{slot.owner === "main" ? "正在主窗口游玩 · 同一份存档" : !connected ? slot.state === "paused" ? "已暂停 · 存档保留" : slot.state === "error" ? "启动失败 · 存档保留" : slot.state === "pausing" ? "正在暂停" : "正在连接" : settling ? "正文已就绪 · 后台整理" : busy ? "生成中" : "可以输入"}</span></header>
		{slot.error && <p role="alert" className="panel-error">{slot.error}</p>}
		<div ref={body} className="play-slot-history" aria-label={`${slot.name}原稿记录`}>
			{messages.length > visibleCount && <button type="button" className="drawer-btn" onClick={() => setVisibleCount(count => count + 80)}>查看更早的80条记录（尚有{messages.length - visibleCount}条）</button>}
			{messages.slice(-visibleCount).map((message, index) => message.channel === "backstage" ? <details key={`${message.entryId ?? "backstage"}:${index}`} className="play-slot-message"><summary>幕后信息 · 非正文</summary><pre>{message.text}</pre></details> : <article key={`${message.entryId ?? "message"}:${index}`} className={`play-slot-message ${message.channel === "user" ? "is-user" : ""}`}>
				<strong>{message.channel === "user" ? message.name ?? "你" : ["narrative", "greeting", "import"].includes(message.channel) ? message.name ?? slot.name : "辅助信息 · 非正文"}</strong>
				<pre>{message.authorDelivery ?? message.text}</pre>
				{message.unfinished && <p role="status" className="field-hint">这是一份未完成原稿，不是定稿。</p>}
				{message.generationError && <p role="alert" className="panel-error">{message.generationError}</p>}
				{message.thinking && <details><summary>思考记录</summary><pre>{message.thinking}</pre></details>}
			</article>)}
			{live && <article className="play-slot-message"><strong>正在生成 · 未定稿</strong><pre>{live}</pre></article>}
			{!messages.length && <p className="field-hint">此卡位是独立新故事。不会读取主窗口或其它卡位的正文与记忆。</p>}
		</div>
		{fullDraft&&<p role="status" className="field-hint">该草稿带有主窗口剧情方向，请在主窗口提交。<button type="button" className="act" onClick={()=>{try{sessionStorage.removeItem(`liyuan.play-slot.${slot.id}.plot-draft`);setFullDraft(false);}catch{setNotice("未能取消方向，草稿保留");}}}>取消方向，仅保留文字</button></p>}
  {notice && <p className="panel-error" role="alert">{notice}</p>}
		{outbox.map(item => <div className="play-slot-outbox" key={item.frame.messageId}><span>{item.state === "rejected" ? item.reason : "输入已保存，等待服务端受理确认；并非生成完成"}</span><details><summary>查看输入原文</summary><pre>{item.frame.text}</pre></details>{item.state === "rejected" && item.frame.type === "prompt" && <button type="button" onClick={() => restoreItem(item)}>恢复到输入框</button>}{item.frame.type === "assistant_prompt" && <span className="field-hint">助手草稿请用主窗口继续处理，不会作为正文发送。</span>}</div>)}
		<div className="play-slot-compose"><textarea disabled={slot.owner === "main"} aria-label={`${slot.name}输入`} value={draft} onChange={event => changeDraft(event.target.value)} placeholder="在这一张卡里继续故事…" />
			<div><select aria-label={`${slot.name}生成模式`} value={mode} onChange={event => {
					const value = event.target.value as GenerationMode; modeChosen.current = true; setMode(value);
					try { sessionStorage.setItem(`liyuan.play-slot.${slot.id}.mode`, value); } catch { setNotice("本次模式已选择，但浏览器未能保存偏好；每条输入仍绑定所选模式。"); }
				}}><option value="director">导演</option><option value="direct">直出</option></select>
				<button type="button" className="drawer-btn" disabled={!connected || fullDraft || !draft.trim()} onClick={send}>{busy ? "提交并排队" : "发送"}</button>
				{busy && <button type="button" className="drawer-btn" onClick={() => socket.current?.send(JSON.stringify({ type: "abort" }))}>{settling ? "停止本席后台" : "停止本席生成"}</button>}
			</div>
		</div>
	</section>;
}

export function PlaySlotsPanel({ onClose, prepareWorkspaceSwitch = () => true }: { onClose: () => void; prepareWorkspaceSwitch?:()=>boolean }) {
	const [slots, setSlots] = useState<PlaySlot[]>([]), [cards, setCards] = useState<CardsResponse["cards"]>([]);
	const [card, setCard] = useState(""), [active, setActive] = useState("");
	const [error, setError] = useState(""), [loadError, setLoadError] = useState(""), [working, setWorking] = useState(false);
	const mounted = useRef(true), request = useRef(0), formPending = useRef(false);
	const root = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
	const closeAction = useRef(onClose); closeAction.current = onClose;
	const refresh = useCallback(async () => {
		const token = ++request.current;
		try { const result = await api<{ slots: PlaySlot[] }>("/api/play-slots"); if (mounted.current && token === request.current) { setSlots(result.slots); setActive(prior => prior || result.slots[0]?.id || ""); setLoadError(""); } }
		catch (cause) { if (mounted.current && token === request.current) setLoadError(cause instanceof Error ? cause.message : "卡位状态无法读取"); }
	}, []);
	useEffect(() => {
		mounted.current = true; void refresh();
		const controller = new AbortController();
		void api<CardsResponse>("/api/play-slots/cards", { signal: controller.signal }).then(result => { if (!mounted.current) return; setCards(result.cards); setCard(result.cards.find(card => card.path.replace(/^\.\//, "") === result.current?.replace(/^\.\//, ""))?.path ?? result.cards[0]?.path ?? ""); }).catch(cause => { if (!controller.signal.aborted) setLoadError(String(cause)); });
		const poll = setInterval(() => { if (!formPending.current) void refresh(); }, 3000);
		return () => { mounted.current = false; request.current++; controller.abort(); clearInterval(poll); };
	}, [refresh]);
	useEffect(() => {
		const previous = document.activeElement, parent = root.current?.parentElement;
		const siblings = Array.from(parent?.parentElement?.children ?? []).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== parent).map(element => ({ element, inert: element.inert }));
		for (const item of siblings) item.element.inert = true;
		close.current?.focus(); document.body.classList.add("tavern-plugins-manager-open");
		const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeAction.current(); } };
		window.addEventListener("keydown", onKey);
		return () => { window.removeEventListener("keydown", onKey); for (const item of siblings) item.element.inert = item.inert; document.body.classList.remove("tavern-plugins-manager-open"); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
	}, []);
	const operate = async (path: string, body: unknown) => {
		if (formPending.current) return; formPending.current = true; setWorking(true); setError("");
		try { const result = await api<{ slot?: PlaySlot }>(path, { method: "POST", body: JSON.stringify(body) }); if (!mounted.current) return; if (result.slot) setActive(result.slot.id); await refresh(); }
		catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "卡位操作失败"); }
		finally { formPending.current = false; if (mounted.current) setWorking(false); }
	};
	return <div className="play-slots-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
		<section ref={root} className="play-slots-panel" role="dialog" aria-modal="true" aria-labelledby="play-slots-title" onKeyDown={event => {
			if (event.key !== "Tab" || !root.current) return;
			const elements = [...root.current.querySelectorAll<HTMLElement>('button:not([disabled]),textarea,select,summary,[tabindex="0"]')].filter(element => element.offsetParent !== null);
			const first = elements[0], last = elements.at(-1); if (!first || !last) return;
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
		}}>
			<header className="play-slots-header"><div><h2 id="play-slots-title">多卡并行</h2><p>最多三个独立卡位；可用完整主窗口接管同一份存档，再放回继续。原主窗口故事保留。关闭面板不会停止生成。</p></div><button ref={close} type="button" className="icon-btn" aria-label="关闭多卡并行" onClick={onClose}><IconClose size={20} /></button></header>
			<div className="play-slots-layout"><aside>
				<label className="field-label">选择角色卡<select aria-label="并行角色卡" className="field-input" value={card} onChange={event => setCard(event.target.value)}>{cards.map(item => <option key={item.path} value={item.path}>{item.name}</option>)}</select></label>
				<button type="button" className="drawer-btn" disabled={working || !card || slots.filter(slot => ["running", "starting", "pausing"].includes(slot.state)).length >= 3} onClick={() => void operate("/api/play-slots", { card })}>{working ? "正在准备卡位…" : "新开独立卡位"}</button>
				<nav aria-label="独立游玩卡位">{slots.map(slot => <div className="play-slot-nav" key={slot.id}><button type="button" aria-current={active === slot.id ? "page" : undefined} onClick={() => setActive(slot.id)}>{slot.name}<small>{slot.owner === "main" ? "主窗口接管" : slot.busy ? slot.settling ? "后台整理" : "生成中" : slot.state === "running" ? "可游玩" : slot.state === "starting" ? "启动中" : slot.state === "pausing" ? "暂停中" : slot.state === "error" ? "启动失败" : "已暂停"}</small></button><button type="button" disabled={working || slot.owner === "main" || slot.busy || ["starting", "pausing"].includes(slot.state)} onClick={() => void operate(`/api/play-slots/${slot.id}/${slot.state === "running" ? "pause" : "start"}`, {})}>{slot.state === "running" ? "暂停" : "恢复"}</button><button type="button" className="slot-takeover" disabled={working || slot.owner==="main" || slot.busy || ["starting","pausing"].includes(slot.state)} onClick={()=>{
     if(formPending.current)return;formPending.current=true;setWorking(true);setError("");
     void switchMainWorkspace(slot.id,prepareWorkspaceSwitch).catch(cause=>setError(cause instanceof Error?cause.message:"接管失败，存档保留")).finally(()=>{formPending.current=false;setWorking(false);});
    }}>{slot.owner==="main"?"已在主窗口":"主窗口继续"}</button></div>)}</nav>
				<p className="field-hint">新卡位从原主窗口的连接与资料快照创建；每席使用独立新故事；不复制主窗口记忆、存档或插件缓存。精简并行台忠实显示原稿文本，不执行卡脚本；“主窗口继续”可使用完整界面、原卡渲染、该席的记忆与插件。接管期间此席暂停收取并行输入，不复制或迁移存档。首版需独立 API Key 配置，不复制共享 OAuth 刷新令牌。并行费用与供应商限流分别累计。</p>
			</aside><div className="play-slots-content">{(error || loadError) && <p role="alert" className="panel-error">{error || loadError}</p>}{slots.map(slot => <PlaySlotPane key={slot.id} slot={slot} active={slot.id === active} />)}{!slots.length && <p className="field-hint">选择一张卡新开卡位，可以同时等待不同故事的回复。</p>}</div></div>
		</section>
	</div>;
}
