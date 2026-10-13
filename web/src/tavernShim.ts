/**
 * 三档程序卡运行时垫片（对照酒馆助手 JS-Slash-Runner 公开调用面的最小子集）。
 *
 * 设计纪律（docs card-frontend §6/§8）：
 * - 读族/存在性：先给桩，保证卡初始化不炸
 * - 生成族 / 斜杠：可接到梨园聊天总线（App 注册 bridge）
 * - 写正文：不提供
 *
 * 卡实际调用面：
 * - parent.TavernHelper.generate / stopAllGeneration
 * - triggerSlash(`/send …|/trigger`)  ← 某卡 开场表单
 * - eventOn / eventEmit
 * - parent.TheaterAPI / handleTheaterAction
 */

export type TavernGenerateParams = {
	user_input?: string;
	should_stream?: boolean;
	disable_extras?: boolean;
	[k: string]: unknown;
};

/** App 注册：把卡侧 slash / generate 接到输入框与 WS prompt */
export type TavernChatBridge = {
	/** 只填输入框，不发送 */
	setInput: (text: string) => void;
	/** 作为用户消息发送并触发生成（空串 = 发送当前输入框内容） */
	sendPrompt: (text: string) => void;
	/** 可选：执行梨园斜杠命令原文（如 /rewind） */
	runCommand?: (text: string) => void;
	/** 把程序卡 toastr 通知映射到梨园 toast */
	notify?: (level: "info" | "success" | "warning" | "error", text: string) => void;
};

export type TavernWorldbookEntry = {
	uid: number;
	name: string;
	comment?: string;
	key?: string[];
	keysecondary?: string[];
	content?: string;
	constant?: boolean;
	selective?: boolean;
	order?: number;
	enabled: boolean;
	[k: string]: unknown;
};

type TavernWorldbookResponse = { name: string; path: string; entries: TavernWorldbookEntry[] };

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		headers: { "content-type": "application/json" },
		...init,
	});
	const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}

/**
 * 当前挂载书名。酒馆公开 API 是同步函数，程序卡普遍直接读取 `.primary`，故这里使用
 * 同源同步 XHR；只取极小的书名清单，不读取正文。世界书正文与写入仍走异步 fetch。
 */
export function getCharWorldbookNames(_scope?: string): { primary: string | null; additional: string[] } {
    try {
        const native=readNativeTavernRaw();const books=native.readonlyBooks??{};
        const primary=native.character?.data?.extensions?.world??Object.keys(books)[0];
        if(typeof primary==="string"&&Object.hasOwn(books,primary))return {primary,additional:Object.keys(books).filter(name=>name!==primary)};
    }catch{ /* native plugin unavailable: preserve the mounted-book legacy seam */ }
	const xhr = new XMLHttpRequest();
	xhr.open("GET", "/api/lorebooks", false);
	xhr.send();
	if (xhr.status < 200 || xhr.status >= 300) throw new Error(`读取挂载世界书失败：HTTP ${xhr.status}`);
	const data = JSON.parse(xhr.responseText || "{}") as { active?: string[] };
	const paths = Array.isArray(data.active) ? data.active : [];
	const names = paths.map((p) => p.split(/[\\/]/).pop()?.replace(/\.json$/i, "") || p);
	return { primary: names[0] ?? null, additional: names.slice(1) };
}

export async function getWorldbook(name?: string): Promise<TavernWorldbookEntry[]> {
    try {
        const native=await apiJson<{readonlyBooks:Record<string,{entries:TavernWorldbookEntry[]}>;character?:{data?:{extensions?:{world?:string}}}}>("/api/tavern-plugins/context");
        const books=native.readonlyBooks??{},key=name??native.character?.data?.extensions?.world??Object.keys(books)[0];
        if(key&&Object.hasOwn(books,key))return books[key].entries.map(entry=>({...entry,name:entry.name||entry.comment||String(entry.uid),enabled:entry.enabled??!entry.disable}));
    }catch{ /* fall back to the existing mounted-worldbook REST API */ }
	const q = name ? `?name=${encodeURIComponent(name)}` : "";
	const data = await apiJson<TavernWorldbookResponse>(`/api/tavern/worldbook${q}`);
	return data.entries;
}

export async function replaceWorldbook(name: string, entries: TavernWorldbookEntry[]): Promise<void> {
	await apiJson("/api/tavern/worldbook", {
		method: "PUT",
		body: JSON.stringify({ name, entries: entries.map((e) => ({ uid: e.uid, enabled: e.enabled })) }),
	});
}

/** Real opening snapshot: indices are zero-based; no fake "always 0" read. */
export interface TavernGreetingContext {
 sessionId: string; card: string; leafId: string | null; messageCount: number;
 greetingIndex: number; greetings: string[];
}
export type TavernGreetingBinding = Pick<TavernGreetingContext,"sessionId"|"card"|"leafId"|"greetingIndex">;
export function readTavernGreeting(expected?: TavernGreetingBinding): TavernGreetingContext {
 const xhr=new XMLHttpRequest();xhr.open("GET","/api/tavern/greeting-context",false);xhr.send();
 const data=JSON.parse(xhr.responseText||"{}");
 if(xhr.status<200||xhr.status>=300)throw new Error(data.error||`读取开场会话失败：HTTP ${xhr.status}`);
 if(typeof data.sessionId!=="string"||typeof data.card!=="string"||!(data.leafId===null||typeof data.leafId==="string")||!Number.isSafeInteger(data.messageCount)||data.messageCount<0||!Number.isInteger(data.greetingIndex)||!Array.isArray(data.greetings)||data.greetings.some((value:unknown)=>typeof value!=="string"))throw new Error("开场会话快照无效");
 if(expected&&(expected.sessionId!==data.sessionId||expected.card!==data.card||expected.leafId!==data.leafId||expected.greetingIndex!==data.greetingIndex))throw new Error("会话、角色卡或分支已变化，请重新打开开场界面");
 return data as TavernGreetingContext;
}
/** Read the existing sanitized native-plugin context; no thinking, secrets, or write APIs. */
function readNativeTavernRaw():any {
 const xhr=new XMLHttpRequest();xhr.open("GET","/api/tavern-plugins/context",false);xhr.send();
 if(xhr.status<200||xhr.status>=300)throw new Error("无法读取原酒馆插件上下文");const context=JSON.parse(xhr.responseText||"{}");
 if(!Array.isArray(context.chat)||!context.state||!context.character)throw new Error("原酒馆插件上下文无效");return context;
}
export function readNativeTavernContext():{chat:unknown[];characters:unknown[];characterId:number;chatMetadata:Record<string,unknown>;extensionSettings:Record<string,unknown>;name1:string;name2:string} {
 const context=readNativeTavernRaw();
 return {chat:context.chat.length?context.chat:getChatMessages(0,{include_swipes:true}),characters:[context.character],characterId:0,chatMetadata:context.state.chatMetadata??{},extensionSettings:context.state.extensionSettings??{},name1:context.userName??"用户",name2:context.character.name??"角色"};
}

export function getTavernHelperVersion():string {
 const xhr=new XMLHttpRequest();xhr.open("GET","/api/tavern-plugins/status",false);xhr.send();
 if(xhr.status<200||xhr.status>=300)throw new Error("无法读取酒馆助手状态");
 const plugin=JSON.parse(xhr.responseText||"{}").plugins?.find((p:{id?:string;enabled?:boolean;installed?:boolean;version?:string})=>p.id==="helper"&&p.enabled&&p.installed);
 if(!plugin||typeof plugin.version!=="string")return "";return plugin.version;
}
export function getLastMessageId():number { return readTavernGreeting().messageCount-1; }
export function openingChatMessages(context:TavernGreetingContext,range:number|string=0,options?:{include_swipes?:boolean}) {
 if(![0,"0","0-0"].includes(range)&&!(range===-1&&context.messageCount===1))throw new Error("梨园开场兼容读取仅支持第0楼，不伪造其它正文楼层");
 if(context.messageCount===0)return [];
 return [{message_id:0,role:"assistant",message:context.greetings[context.greetingIndex]??"",swipe_id:context.greetingIndex,...(options?.include_swipes===false?{}:{swipes:[...context.greetings]})}];
}
/** Upstream getChatMessages is synchronous. Returning a Promise breaks card selectors. */
export function getChatMessages(range:number|string=0,options?:{include_swipes?:boolean}) { return openingChatMessages(readTavernGreeting(),range,options); }
export async function selectTavernGreeting(index:number,expected:TavernGreetingBinding):Promise<TavernGreetingContext> {
 if(!Number.isInteger(index)||index<0)throw new Error("开场白序号无效");
 const result=await apiJson<{context:TavernGreetingContext}>("/api/tavern/greeting-select",{method:"POST",body:JSON.stringify({index,expected})});
 if(!result.context||result.context.sessionId!==expected.sessionId||result.context.card!==expected.card||result.context.greetingIndex!==index)throw new Error("开场切换未确认，请刷新后核对");
 return result.context;
}
export interface TavernOpeningUpdate {message_id:number;swipe_id?:number}
function openingIndex(updates:TavernOpeningUpdate[]):number|undefined {
 if(!Array.isArray(updates)||updates.length!==1||!updates[0]||Object.keys(updates[0]).some(k=>!['message_id','swipe_id'].includes(k))||updates[0].message_id!==0||updates[0].swipe_id!==undefined&&(!Number.isInteger(updates[0].swipe_id)||(updates[0].swipe_id as number)<0))throw new Error("梨园仅支持切换第0楼已有开场白，不允许脚本改写正文");
 return updates[0].swipe_id;
}
/** Strict greeting-swipe subset, not a general story-editing API. */
export async function setChatMessages(updates:TavernOpeningUpdate[],_options?:{refresh?:string}):Promise<void> {
 const index=openingIndex(updates);if(index===undefined)return;
 await selectTavernGreeting(index,readTavernGreeting());
}
export async function setChatMessage(_text:string,messageId:number|string,options?:{swipe_id?:number}):Promise<void> {
 if(Number(messageId)!==0||!Number.isInteger(options?.swipe_id)||_text.trim())throw new Error("梨园仅支持程序卡切换第0楼已有开场白，不支持正文改写");
 await setChatMessages([{message_id:0,swipe_id:options!.swipe_id}]);
}

type BusMap = Map<string, Set<(...args: unknown[]) => void>>;

let chatBridge: TavernChatBridge | null = null;

export function registerTavernChatBridge(bridge: TavernChatBridge | null): void {
	chatBridge = bridge;
}

export function getTavernChatBridge(): TavernChatBridge | null {
	return chatBridge;
}

function getBus(target: object): BusMap {
	const w = target as { __liyuanEventBus?: BusMap };
	if (!w.__liyuanEventBus) w.__liyuanEventBus = new Map();
	return w.__liyuanEventBus;
}

/** 挂 eventOn / eventEmit（iframe 内与父页各一份即可） */
export function installEventBus(target: object = typeof window !== "undefined" ? window : {}): void {
	const t = target as {
		eventOn?: (name: string, cb: (...args: unknown[]) => void) => void;
		eventEmit?: (name: string, ...args: unknown[]) => void;
	};
	if (typeof t.eventOn === "function" && typeof t.eventEmit === "function") return;

	const bus = getBus(target);
	t.eventOn = (name, cb) => {
		if (!bus.has(name)) bus.set(name, new Set());
		bus.get(name)!.add(cb);
	};
	t.eventEmit = (name, ...args) => {
		const set = bus.get(name);
		if (!set) return;
		for (const cb of set) {
			try {
				cb(...args);
			} catch (e) {
				console.error("[liyuan eventEmit]", name, e);
			}
		}
	};
}

/**
 * 解析酒馆式管道斜杠：`/send 文本|/trigger`
 * 分段以 `|` 分隔（ST STscript 同款）。
 */
export function parseSlashPipeline(raw: string): string[] {
	const source = String(raw ?? "");
	// 只把后面紧跟斜杠命令名的 | 当管道符；开局正文里的普通竖线必须原样保留。
	const matches = [...source.matchAll(/\|\s*(?=\/[a-z][\w-]*\b)/gi)];
	const parts: string[] = [];
	let start = 0;
	for (const match of matches) {
		parts.push(source.slice(start, match.index).trim());
		start = (match.index ?? 0) + match[0].length;
	}
	parts.push(source.slice(start).trim());
	return parts.filter(Boolean);
}

export type SlashExecResult = {
	ok: boolean;
	/** 已填入输入框或已发送的正文 */
	text?: string;
	/** 是否触发了生成 */
	triggered?: boolean;
	/** 仅填入输入框未发送 */
	filledOnly?: boolean;
	error?: string;
};

/**
 * 执行 triggerSlash 命令串（纯逻辑，可测）。
 * 支持：/send、/trigger，以及二者管道组合。
 */
export function executeTriggerSlash(
	raw: string,
	bridge: TavernChatBridge | null,
): SlashExecResult {
	if (!bridge) {
		return { ok: false, error: "聊天桥未就绪（App 未注册 TavernChatBridge）" };
	}
	const parts = parseSlashPipeline(raw);
	if (!parts.length) return { ok: false, error: "空命令" };

	let pendingSend = "";
	let wantTrigger = false;
	let filledOnly = false;

	for (const part of parts) {
		const cmd = part.startsWith("/") ? part : `/${part}`;
		const mSend = cmd.match(/^\/send(?:as)?(?:\s+name=[^\s]+)?\s*([\s\S]*)$/i);
		if (mSend) {
			pendingSend = (mSend[1] ?? "").trim();
			continue;
		}
		if (/^\/trigger\b/i.test(cmd)) {
			wantTrigger = true;
			continue;
		}
		// 其它斜杠：尽量当梨园命令
		if (cmd.startsWith("/") && bridge.runCommand) {
			try {
				bridge.runCommand(cmd);
			} catch (e) {
				console.warn("[liyuan triggerSlash] runCommand", cmd, e);
			}
			continue;
		}
		console.warn("[liyuan triggerSlash] 未识别命令", cmd);
	}

	if (wantTrigger) {
		// /send X|/trigger → 直接发 X 并生成；仅 /trigger → 发当前输入框
		const text = pendingSend;
		try {
			bridge.sendPrompt(text);
			return { ok: true, text, triggered: true };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	if (pendingSend) {
		try {
			bridge.setInput(pendingSend);
			filledOnly = true;
			return { ok: true, text: pendingSend, filledOnly };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	return { ok: true };
}

/** 父页全局 triggerSlash（iframe 通过 parent 或 postMessage 调用） */
export async function triggerSlash(raw: string): Promise<string> {
	const r = executeTriggerSlash(raw, chatBridge);
	if (!r.ok) {
		console.warn("[liyuan triggerSlash]", r.error, raw?.slice?.(0, 80));
		return r.error || "";
	}
	return r.text || "";
}

/** 父页安装：卡脚本通过 window.parent.TavernHelper / triggerSlash 访问 */
export function installParentTavernShim(): void {
	if (typeof window === "undefined") return;
	const w = window as Window & {
		__liyuanTavernShimInstalled?: boolean;
		TavernHelper?: {
			generate: (params?: TavernGenerateParams) => Promise<string>;
			stopAllGeneration: () => void;
            getTavernHelperVersion:typeof getTavernHelperVersion;getCharWorldbookNames:typeof getCharWorldbookNames;getWorldbook:typeof getWorldbook;replaceWorldbook:typeof replaceWorldbook;
            getLastMessageId:typeof getLastMessageId; getChatMessages:typeof getChatMessages; setChatMessages:typeof setChatMessages; setChatMessage:typeof setChatMessage;
		};
		TheaterAPI?: { call: (method: string, ...args: unknown[]) => Promise<unknown> };
		handleTheaterAction?: (msg: unknown) => void;
		triggerSlash?: (cmd: string) => Promise<string> | string;
		getCharWorldbookNames?: (scope?: string) => { primary: string | null; additional: string[] };
		getWorldbook?: (name?: string) => Promise<TavernWorldbookEntry[]>;
		replaceWorldbook?: (name: string, entries: TavernWorldbookEntry[]) => Promise<void>;
		getChatMessages?: typeof getChatMessages;
        SillyTavern?:{getContext:typeof readNativeTavernContext;readonly chat:unknown[]};
        getTavernHelperVersion?:typeof getTavernHelperVersion;getLastMessageId?:typeof getLastMessageId;setChatMessages?:typeof setChatMessages;
        __liyuanTavernGreeting?:{read:typeof readTavernGreeting;select:typeof selectTavernGreeting};
		setChatMessage?: (text: string, id: number | string, options?: { swipe_id?: number }) => Promise<void>;
		toastr?: Record<"info" | "success" | "warning" | "error", (text: string) => void>;
	};
	if (w.__liyuanTavernShimInstalled) return;
	w.__liyuanTavernShimInstalled = true;

	installEventBus(w);

	w.triggerSlash = (cmd: string) => triggerSlash(cmd);
	w.getCharWorldbookNames = getCharWorldbookNames;
	w.getWorldbook = getWorldbook;
	w.replaceWorldbook = replaceWorldbook;
	w.getChatMessages = getChatMessages;
    w.getTavernHelperVersion=getTavernHelperVersion;w.getLastMessageId = getLastMessageId;w.setChatMessages=setChatMessages;
    w.__liyuanTavernGreeting={read:readTavernGreeting,select:selectTavernGreeting};
    w.SillyTavern??={getContext:readNativeTavernContext,get chat(){return readNativeTavernContext().chat;}};
	w.setChatMessage = setChatMessage;
	w.toastr = {
		info: (text) => chatBridge?.notify?.("info", String(text)),
		success: (text) => chatBridge?.notify?.("success", String(text)),
		warning: (text) => chatBridge?.notify?.("warning", String(text)),
		error: (text) => chatBridge?.notify?.("error", String(text)),
	};

	// iframe 无 same-origin 时走 postMessage（测试桩可能没有 addEventListener）
	if (typeof window.addEventListener === "function") {
		window.addEventListener("message", (ev: MessageEvent) => {
			const d = ev.data as { liyuanTriggerSlash?: unknown } | null;
			if (!d || typeof d.liyuanTriggerSlash !== "string") return;
			void triggerSlash(d.liyuanTriggerSlash);
		});
	}

	w.TavernHelper = {
        getTavernHelperVersion,getCharWorldbookNames,getWorldbook,replaceWorldbook,getLastMessageId,getChatMessages,setChatMessages,setChatMessage,
		/**
		 * 对照卡内：await generate({ user_input, should_stream }) → string
		 * 已注册 bridge 时：把 user_input 当用户发言并触发生成。
		 */
		async generate(params) {
			const input = String(params?.user_input ?? "").trim();
			if (chatBridge && input) {
				try {
					chatBridge.sendPrompt(input);
					return input;
				} catch (e) {
					console.warn("[liyuan TavernHelper.generate]", e);
				}
			}
			console.warn("[liyuan TavernHelper.generate] 无 bridge 或空输入", {
				len: input.length,
				stream: params?.should_stream,
			});
			return `（梨园：界面内 AI 生成未接入聊天桥。输入：${input.slice(0, 80) || "（空）"}）`;
		},
		stopAllGeneration() {
			console.warn("[liyuan TavernHelper.stopAllGeneration] no-op");
		},
	};

	w.TheaterAPI = {
		async call(method, ...args) {
			console.warn("[liyuan TheaterAPI.call]", method, args?.length ?? 0);
			return null;
		},
	};

	w.handleTheaterAction = (msg) => {
		console.warn("[liyuan handleTheaterAction]", msg);
	};
}

/**
 * 注入到脚本帧 head 最前：同源下挂 TavernHelper + triggerSlash；
 * 并尽量镜像 parent（双保险）；跨域则 postMessage。
 */
export const IFRAME_TAVERN_BRIDGE_SNIPPET = `<script>(function(){
try{
  var g=typeof window!=="undefined"?window:null;if(!g)return;
  function bus(){if(!g.__liyuanEventBus)g.__liyuanEventBus=new Map();return g.__liyuanEventBus;}
  if(typeof g.eventOn!=="function"){
    g.eventOn=function(name,cb){var b=bus();if(!b.has(name))b.set(name,new Set());b.get(name).add(cb);};
  }
  if(typeof g.eventEmit!=="function"){
    g.eventEmit=function(name){var args=[].slice.call(arguments,1),b=bus(),s=b.get(name);if(!s)return;
      s.forEach(function(cb){try{cb.apply(null,args);}catch(e){console.error(e);}});};
  }
  function parentWin(){try{return g.parent&&g.parent!==g?g.parent:null;}catch(e){return null;}}
  function parentTH(){var p=parentWin();return p&&p.TavernHelper?p.TavernHelper:null;}
  if(typeof g.triggerSlash!=="function"){
    g.triggerSlash=function(cmd){
      var p=parentWin();
      try{
        if(p&&typeof p.triggerSlash==="function"){
          var r=p.triggerSlash(cmd);
          return r&&typeof r.then==="function"?r:Promise.resolve(r);
        }
      }catch(e){}
      try{if(p)p.postMessage({liyuanTriggerSlash:String(cmd||"")},"*");}catch(e2){}
      return Promise.resolve("");
    };
  }
  if(!g.TavernHelper){
    g.TavernHelper={
      generate:function(params){
        var p=parentTH();
        if(p&&typeof p.generate==="function")return p.generate(params);
        console.warn("[liyuan iframe] TavernHelper.generate stub");
        var u=(params&&params.user_input)||"";
        return Promise.resolve("（梨园：界面内 AI 生成尚未接入）"+String(u).slice(0,80));
      },
      stopAllGeneration:function(){
        var p=parentTH();
        if(p&&typeof p.stopAllGeneration==="function")return p.stopAllGeneration();
      }
    };
  }
	/* 世界书/开场白兼容 API：脚本帧只代理父页，文件与会话主权仍在梨园。 */
	/* getCharWorldbookNames 必须同步透传：社区程序卡直接读返回值的 .primary。 */
	if(typeof g.getCharWorldbookNames!=="function"){
		g.getCharWorldbookNames=function(){var p=parentWin();if(!p||typeof p.getCharWorldbookNames!=="function")return {primary:null,additional:[]};return p.getCharWorldbookNames.apply(p,arguments);};
	}
	// Each frame captures its own binding, so an old card cannot choose a new card's swipe.
 if(typeof g.getTavernHelperVersion!=="function")g.getTavernHelperVersion=function(){var p=parentWin();if(!p||typeof p.getTavernHelperVersion!=="function")throw new Error("酒馆助手尚未就绪");return p.getTavernHelperVersion();};
 try{var sillyParent=parentWin();if(!g.SillyTavern&&sillyParent&&sillyParent.SillyTavern)g.SillyTavern=sillyParent.SillyTavern;}catch(e){}
 var openingBinding=null,openingBindingError=null;
 function greetingApi(){var p=parentWin(),a=p&&p.__liyuanTavernGreeting;if(!a)throw new Error("梨园开场兼容 API 未就绪，请重新打开前端");return a;}
 function bindingOf(c){return {sessionId:c.sessionId,card:c.card,leafId:c.leafId,greetingIndex:c.greetingIndex};}
 try{openingBinding=bindingOf(greetingApi().read());}catch(e){openingBindingError=e;}
 function readOpening(){if(openingBindingError)throw openingBindingError;return greetingApi().read(openingBinding);}
 if(typeof g.getLastMessageId!=="function")g.getLastMessageId=function(){return readOpening().messageCount-1;};
 if(typeof g.getChatMessages!=="function")g.getChatMessages=function(range,options){
  var c=readOpening();range=range==null?0:range;if(range!==0&&range!=="0"&&range!=="0-0"&&!(range===-1&&c.messageCount===1))throw new Error("梨园开场兼容读取仅支持第0楼");
  if(c.messageCount===0)return [];var m={message_id:0,role:"assistant",message:c.greetings[c.greetingIndex]||"",swipe_id:c.greetingIndex};if(!options||options.include_swipes!==false)m.swipes=c.greetings.slice();return [m];
 };
 if(typeof g.setChatMessages!=="function")g.setChatMessages=async function(updates){
  if(!Array.isArray(updates)||updates.length!==1||!updates[0]||Object.keys(updates[0]).some(function(k){return k!=="message_id"&&k!=="swipe_id";})||updates[0].message_id!==0)throw new Error("梨园仅支持切换第0楼已有开场白，不允许脚本改写正文");
  var index=updates[0].swipe_id;if(index===undefined){readOpening();return;}if(!Number.isInteger(index)||index<0)throw new Error("开场白序号无效");
  readOpening();var selected=await greetingApi().select(index,openingBinding);openingBinding=bindingOf(selected);
 };
 if(typeof g.setChatMessage!=="function")g.setChatMessage=function(text,id,options){if(String(text||"").trim()||Number(id)!==0||!options||!Number.isInteger(options.swipe_id))return Promise.reject(new Error("梨园仅支持切换第0楼已有开场白"));return g.setChatMessages([{message_id:0,swipe_id:options.swipe_id}]);};
 var compat=["getWorldbook","replaceWorldbook"];
	for(var ci=0;ci<compat.length;ci++)(function(name){
		if(typeof g[name]==="function")return;
		g[name]=function(){var p=parentWin();if(!p||typeof p[name]!=="function")return Promise.reject(new Error("梨园兼容 API 未就绪："+name));return p[name].apply(p,arguments);};
	})(compat[ci]);
	if(!g.toastr){
		g.toastr={};
		["info","success","warning","error"].forEach(function(level){
			g.toastr[level]=function(text){var p=parentWin();if(p&&p.toastr&&typeof p.toastr[level]==="function")p.toastr[level](String(text||""));};
		});
	}
  try{
    if(g.parent&&g.parent.TheaterAPI)g.TheaterAPI=g.parent.TheaterAPI;
    else if(!g.TheaterAPI)g.TheaterAPI={call:function(){return Promise.resolve(null);}};
  }catch(e){}
  try{
    if(g.parent&&typeof g.parent.handleTheaterAction==="function"){
      g.handleTheaterAction=function(m){return g.parent.handleTheaterAction(m);};
    }
  }catch(e){}
}catch(e){console.error("[liyuan bridge]",e);}
})();</script>`;

import { JQUERY_MIN } from "./vendor/jquery-min.ts";

/**
 * 酒馆全局垫片（脚本帧专用，注入在 bridge 之后、卡脚本之前）。
 *
 * 酒馆页面内置 jQuery/lodash/变量系统/MVU 插件对象，卡界面脚本直接裸用这些全局
 * （模拟修仙2 状态栏 UI 30 处 `$`、`_.get`、`getAllVariables()`、`Mvu`/`eventOn`）——
 * 梨园 srcdoc 沙箱里没有这些，脚本第一行就 ReferenceError，按钮事件永远绑不上
 * （8/05 实弹：状态栏出来了但页签全点不动）。
 *
 * 垫片面（对照酒馆公开调用面）：
 * - `$`/`jQuery`：完整 jQuery 3.7.1（离线内置，MIT）
 * - `_`：lodash 常用子集（get/set/has/each/isArray/isObject/escape 等，按需扩充）
 * - `getAllVariables()`：酒馆变量系统 → 梨园侧变量 JSON（默认空壳 `{stat_data:{}}`，
 *   父页可 postMessage {liyuanVariables} 注入——后续接梨园账本）
 * - `Mvu`：由原生酒馆助手加载真实MVU；沙箱垫片不创建假的可用对象
 * - `waitGlobalInitialized(name)`：酒馆等待全局就绪 → 目标已存在立即 resolve
 */
export const IFRAME_TAVERN_GLOBALS_SNIPPET = `<script>(function(){
var g=typeof window!=="undefined"?window:null;if(!g)return;
try{
  if(typeof g.jQuery!=="function"){
    ${JQUERY_MIN}
  }
  if(!g._||typeof g._!=="object"){
    function lp(obj,path){if(path==null)return obj;if(!Array.isArray(path))path=String(path).split(".");var o=obj;for(var i=0;i<path.length;i++){if(o==null)return undefined;o=o[path[i]];}return o;}
    g._={
      get:function(obj,path,def){var v=lp(obj,path);return v===undefined?def:v;},
      set:function(obj,path,val){if(path==null)return obj;if(!Array.isArray(path))path=String(path).split(".");var o=obj;for(var i=0;i<path.length-1;i++){if(o[path[i]]==null||typeof o[path[i]]!=="object")o[path[i]]={};o=o[path[i]];}o[path[path.length-1]]=val;return obj;},
      has:function(obj,path){return lp(obj,path)!==undefined;},
      each:function(coll,fn){if(Array.isArray(coll)){for(var i=0;i<coll.length;i++){if(fn(coll[i],i)===false)break;}}else{for(var k in coll){if(Object.prototype.hasOwnProperty.call(coll,k)){if(fn(coll[k],k)===false)break;}}}return coll;},
      forEach:function(coll,fn){return g._.each(coll,fn);},
      isArray:function(v){return Array.isArray(v);},
      isObject:function(v){return v!=null&&typeof v==="object"&&!Array.isArray(v);},
      isString:function(v){return typeof v==="string";},
      isNumber:function(v){return typeof v==="number"&&isFinite(v);},
      isBoolean:function(v){return typeof v==="boolean";},
      isFunction:function(v){return typeof v==="function";},
      isEmpty:function(v){if(v==null)return true;if(Array.isArray(v)||typeof v==="string")return v.length===0;if(typeof v==="object")return Object.keys(v).length===0;return false;},
      escape:function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});},
      unescape:function(s){return String(s==null?"":s).replace(/&(?:amp|lt|gt|quot|#39);/g,function(m){return {"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&#39;":"'"}[m];});},
      clone:function(v){if(v==null||typeof v!=="object")return v;return JSON.parse(JSON.stringify(v));},
      debounce:function(fn,wait){var t=null;return function(){var a=arguments,c=this;clearTimeout(t);t=setTimeout(function(){fn.apply(c,a);},wait||100);};},
      now:function(){return Date.now();}
    };
  }
  if(typeof g.getAllVariables!=="function"){
    g.getAllVariables=function(){var v=g.__liyuanVariables||null;return v&&typeof v==="object"?v:{stat_data:{}};};
  }
  // No fake Mvu object: the original native MVU must initialize through TavernHelper.
  if(typeof g.waitGlobalInitialized!=="function"){
    g.waitGlobalInitialized=function(name,timeoutMs){
      return new Promise(function(res){
        var t0=Date.now(),lim=timeoutMs||5000;
        (function poll(){
          try{if(g[name])return res(true);}catch(e){return res(false);}
          if(Date.now()-t0>lim)return res(false);
          setTimeout(poll,50);
        })();
      });
    };
  }
	if(typeof g.errorCatched!=="function"){
		g.errorCatched=function(fn){return function(){try{return fn.apply(this,arguments);}catch(e){console.error("[liyuan card init]",e);}};};
	}
}catch(e){console.error("[liyuan globals]",e);}
})();</script>`;
