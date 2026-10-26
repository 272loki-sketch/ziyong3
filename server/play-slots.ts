/** Outer process isolation only. Each slot runs the unchanged single-story server/engine. */
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createPortServer } from "node:net";
import type { Duplex } from "node:stream";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { loadCardFile, readCardRawJson } from "../src/card.ts";
import { resolveWorldbooks, scopedLorebookPaths, worldbookCardKey } from "../src/worldbook-bindings.ts";
import type { RpConfig } from "../src/types.ts";
import { overlayPathFor } from "../src/lorebook.ts";
import { novelPlayCardBinding } from "../src/novel-play/runtime.ts";
import { worldProfilePath } from "../src/stage/literary-world-profile.ts";
import { ACCESS_COOKIE, issueToken, loadAccess, setPassword } from "../src/access.ts";
import { isSameOriginRequest, requestPathname } from "./http-security.ts";
import { writeJsonAtomicWithBackup } from "../src/atomic-json.ts";
import { PRIMARY_WORKSPACE, parentRequest, resourceContext, proxyWorkspaceHttp, type WorkspaceContext } from "./main-workspace.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ACTIVE = 3, MAX_STORED = 12, MAX_BYTES = 32 * 1024 * 1024, MAX_HISTORY_BYTES = 128 * 1024 * 1024;
export interface PlaySlotMeta { version: 1; id: string; name: string; createdAt: string; card?: string }
export interface PlaySlotView { owner?: "main" | "parallel"; id: string; name: string; createdAt: string; card?: string; lease?:string; state: "paused" | "starting" | "pausing" | "running" | "error"; busy: boolean; settling: boolean; error?: string }
export interface PlaySlotHost {
	cardFile(card: string): { file: string; name: string };
	snapshot(): { config: Record<string, unknown>; agent: Record<string, unknown>; agentDirectory?: string };
	authorized(req: IncomingMessage): boolean;
 mainBusy?(): boolean;
 persist?(): void;
 mainChanged?(): void;
 cards?(): unknown;
}
interface Running {
	process: ChildProcess; port: number; token: string; ready: Promise<void>;
	monitor?: WebSocket; sessionId?: string; busy: boolean; settling: boolean; pausing?: boolean; transferring?: boolean; pending: Set<string>; controls: Set<string>; viewers: Set<WebSocket>;
}
function privateDir(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("并行卡位目录类型无效");
	if (process.platform !== "win32") chmodSync(path, 0o700);
}
function regularBytes(path: string, max = MAX_BYTES): Buffer {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw Error("卡位资料类型或大小无效");
	const bytes = readFileSync(path); if (bytes.length > max) throw Error("卡位资料过大"); return bytes;
}
function privateJson(path: string, data: unknown): void {
	privateDir(dirname(path)); writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
}
function copyFile(source: string, target: string): void {
	const bytes = regularBytes(source); privateDir(dirname(target)); writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
}
async function freePort(): Promise<number> {
	const server = createPortServer();
	await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok())); return port;
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []; let size = 0;
	for await (const value of req) { const chunk = Buffer.from(value); size += chunk.length; if (size > 8192) throw Error("卡位管理请求过大"); chunks.push(chunk); }
	const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("卡位管理请求无效"); return body as Record<string, unknown>;
}

export class PlaySlots {
	readonly root: string;
	readonly #meta = new Map<string, PlaySlotMeta>();
	readonly #running = new Map<string, Running>();
	readonly #slotLeases = new Map<string,string>();
	readonly #errors = new Set<string>();
	readonly #gateway = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES });
	readonly #host: PlaySlotHost;
	readonly #cwd: string;
	readonly #disabled: boolean;
	#closed = false;
	#mainId: string | null = null;
 #lease = randomBytes(16).toString("hex");
 #handedOff = false;
	#switching = false;
	#activeHttp = 0;
	constructor(cwd: string, host: PlaySlotHost, disabled = false) {
		this.#cwd = resolve(cwd); this.#host = host; this.#disabled = disabled; this.root = join(this.#cwd, ".liyuan", "play-slots");
		if (disabled || !existsSync(this.root)) return;
		privateDir(join(this.#cwd, ".liyuan")); privateDir(this.root);
		for (const id of readdirSync(this.root)) {
			if (!ID.test(id)) continue;
			try {
				privateDir(join(this.root, id));
				const meta = JSON.parse(regularBytes(join(this.root, id, "meta.json"), 8192).toString("utf8")) as PlaySlotMeta;
				if (meta.version !== 1 || meta.id !== id || typeof meta.name !== "string" || meta.name.length > 200 || typeof meta.createdAt !== "string" || !Number.isFinite(Date.parse(meta.createdAt)) || meta.card!==undefined&&(typeof meta.card!=="string"||meta.card.length>4096)) throw Error("invalid meta");
				this.#meta.set(id, meta);this.#slotLeases.set(id,randomBytes(16).toString("hex"));
			} catch { /* Invalid directories are neither launched nor deleted. */ }
		}

  const selected=join(this.root,"main-window.json");
  if(existsSync(selected)){
   const stored=JSON.parse(regularBytes(selected,4096).toString("utf8"));
   if(stored.version!==1||!(stored.id===null||typeof stored.id==="string"&&this.#meta.has(stored.id)))throw Error("主窗口接管记录无效，未丢弃原存档");
   this.#mainId=stored.id;this.#handedOff=true;
   if(stored.lease!==undefined&&!/^[a-f0-9]{32}$/.test(stored.lease))throw Error("主窗口租约无效");
   // Every server restart invalidates old tabs, without discarding ownership or saves.
  }
	}

 get mainWorkspace(): string { return this.#mainId??PRIMARY_WORKSPACE; }
 get context(): WorkspaceContext { return {workspace:this.mainWorkspace,lease:this.#lease}; }
 mainStatus(){const slot=this.#mainId?this.list().find(s=>s.id===this.#mainId):undefined;return{...this.context,slot:slot??null,switching:this.#switching};}
 /** Legacy primary clients remain compatible only before any handoff has been saved.
  * A lease prevents ABA (primary -> card -> primary) and restart replay. */
 accepts(req:IncomingMessage):boolean {
  if(this.#disabled)return true;
  const scope=resourceContext(req);
  if(scope.workspace===undefined&&scope.lease===undefined){
   if(!this.#handedOff&&this.#mainId===null)return true;
   const path=requestPathname(req.url??"/");
   // Module imports and CSS cannot propagate custom headers; these routes serve
   // code only, never story state. Explicit stale leases are still rejected.
   if(["GET","HEAD"].includes(req.method??"GET")&&(
    path.startsWith("/tavern-compat/")||path.startsWith("/veridis-rewrite/")||
    path==="/database-plugin-host.js"||path==="/database-plugin-host.css"||path.startsWith("/api/database-plugin/vendor/")
   ))return true;
  }
  return scope.workspace===this.mainWorkspace&&scope.lease===this.#lease;
 }
 rootWritable(req:IncomingMessage):boolean { return this.#disabled||!this.#switching&&this.#mainId===null&&this.accepts(req); }
 async #idle(running: Running, allowPausing=false): Promise<void> {
  if(running.busy||running.settling||running.pending.size||running.controls.size||!allowPausing&&running.pausing)throw Error("故事仍在生成、后台整理或受理输入，请完成后再切换");
  const response=await fetch(`http://127.0.0.1:${running.port}/api/play-slots/idle`,{headers:{cookie:`${ACCESS_COOKIE}=${running.token}`},signal:AbortSignal.timeout(6000)});
  if(!response.ok||(await response.json() as {busy:boolean}).busy!==false||running.pending.size)throw Error("卡位仍忙，未切换主窗口");
 }
 async openMain(id: string|null, expected: string, lease: string): Promise<void> {
  if(this.#disabled||this.#closed||this.#switching||expected!==this.mainWorkspace||lease!==this.#lease)throw Error("主窗口归属已变化，请刷新后再操作");
  if(id!==null&&(!ID.test(id)||!this.#meta.has(id)))throw Error("卡位不存在");
  if(this.#mainId===id)return;
  if(this.#host.mainBusy?.()||this.#activeHttp)throw Error("主窗口仍忙或正在保存，请稍后再切换");
  this.#switching=true;const old=this.#mainId;const previous=old?this.#running.get(old):undefined;let target:Running|undefined;
  try{
   if(previous){previous.transferring=true;await this.#idle(previous);}
   else if(old===null)this.#host.persist?.();
   if(id){await this.start(id);target=this.#running.get(id);if(!target)throw Error("卡位未启动");target.transferring=true;await this.#idle(target);}
   if(this.#host.mainBusy?.()||this.#activeHttp)throw Error("切换期间主窗口状态改变，请稍后重试");
   const nextLease=randomBytes(16).toString("hex");
   privateDir(join(this.#cwd,".liyuan"));privateDir(this.root);const file=join(this.root,"main-window.json");if(existsSync(file))regularBytes(file,4096);
   writeJsonAtomicWithBackup(file,{version:1,id,lease:nextLease});this.#mainId=id;this.#lease=nextLease;this.#handedOff=true;
   for(const changedId of [old,id])if(changedId)this.#slotLeases.set(changedId,randomBytes(16).toString("hex"));
   for(const run of [previous,target])if(run)for(const ws of run.viewers){try{ws.send(JSON.stringify({type:"workspace_changed"}));ws.close(4410,"workspace changed");}catch{}}
   this.#host.mainChanged?.();
  }finally{if(previous)previous.transferring=false;if(target)target.transferring=false;this.#switching=false;}
 }
 /** Authentication happens first; private in-process plugin tokens stay in their own engine. */
 async mainRequest(req:IncomingMessage,res:ServerResponse,internal=false):Promise<boolean>{
  if(this.#disabled||internal)return false;
  const pathname=requestPathname(req.url??"/");
  if(parentRequest(pathname))return false;
  if(this.#switching||!this.accepts(req)){res.writeHead(409,{"content-type":"application/json","cache-control":"private, no-store"});res.end(JSON.stringify({error:"故事工作区已变化，旧页面请求未执行，请刷新后重试",code:"workspace_changed"}));return true;}
  if(!this.#mainId){
   if(!["GET","HEAD"].includes(req.method??"GET")){this.#activeHttp++;let ended=false;const end=()=>{if(ended)return;ended=true;this.#activeHttp--;};res.once("finish",end);res.once("close",end);}
   return false;
  }
  if(!this.#host.authorized(req)||!isSameOriginRequest(req)){res.writeHead(403,{"content-type":"application/json"});res.end(JSON.stringify({error:"主窗口接管未获授权"}));return true;}
  const id=this.#mainId,context=this.context;this.#activeHttp++;
  try{await this.start(id);const run=this.#running.get(id);if(!run||this.#mainId!==id)throw Error("故事归属已变化");await proxyWorkspaceHttp(req,res,run,()=>this.#mainId===id&&this.#running.get(id)===run,context);}
  catch{if(!res.headersSent){res.writeHead(503,{"content-type":"application/json"});res.end(JSON.stringify({error:"主窗口故事暂不可用；原存档保留，可返回原主窗口或重试恢复"}));}else res.destroy();}
  finally{this.#activeHttp--;}
  return true;
 }
	assertCanRestart(): void {
		if (this.#disabled) throw Error("请在主服务管理产品更新");
		if (this.#running.size) throw Error("仍有并行卡位在运行；请先暂停全部卡位，再重启应用更新，避免中断其它故事");
	}
	list(): PlaySlotView[] {
		return [...this.#meta.values()].map(meta => {
			const running = this.#running.get(meta.id);
			return { ...meta, lease:this.#slotLeases.get(meta.id), owner: this.#mainId===meta.id ? "main" as const : "parallel" as const, state: running ? running.pausing ? "pausing" : running.monitor?.readyState === WebSocket.OPEN && running.sessionId ? "running" : "starting" : this.#errors.has(meta.id) ? "error" : "paused", busy: !!running && (running.busy || running.pending.size > 0 || running.controls.size > 0), settling: !!running?.settling, ...(this.#errors.has(meta.id) ? { error: "卡位子服务未正常启动或意外退出，原存档保留，可重试" } : {}) };
		});
	}
	#createWorkspace(id: string, card: string): PlaySlotMeta {
		const source = this.#host.cardFile(card), snapshot = this.#host.snapshot();
		if (!source.name.trim() || source.name.length > 200) throw Error("角色卡名称无效");
		const cardData = loadCardFile(source.file);
		if (novelPlayCardBinding(readCardRawJson(source.file).raw)) throw Object.assign(Error("绑定私有原著包的开演卡暂不支持并行复制"), { code: "slot_novel_unsupported" });
		privateDir(join(this.#cwd, ".liyuan")); privateDir(this.root);
		const directory = join(this.root, id); mkdirSync(directory, { mode: 0o700 });
		try {
			const work = join(directory, "work"); privateDir(work);
			let copiedBytes = 0;
			const copy = (source: string, target: string) => {
				copiedBytes += lstatSync(source).size;
				if (copiedBytes > 128 * 1024 * 1024) throw Error("启用资料超过并行卡位复制上限，未创建卡位");
				copyFile(source, target);
			};
			const localPath = (value: string, category: string) => !isAbsolute(value) && !value.includes("\\") && value.replace(/^(?:\.\/)+/, "").split("/").every(part => part && part !== "." && part !== "..") ? value.replace(/^(?:\.\/)+/, "") : `materials/${category}/${createHash("sha256").update(value).digest("hex").slice(0, 12)}/${basename(value)}`;
			const cardPath = localPath(card, "cards");
			const pathMap = new Map<string, string>([[card.replace(/\\/g, "/"), cardPath]]);
			if (typeof snapshot.config.card === "string" && resolve(this.#cwd, snapshot.config.card) === resolve(source.file)) pathMap.set(snapshot.config.card.replace(/\\/g, "/"), cardPath);
			copy(source.file, join(work, cardPath));
			const config = structuredClone(snapshot.config); config.card = cardPath;
			if (snapshot.config.card !== card) { delete config.displayName; config.greetingIndex = 0; }
			// New stories never inherit branch-bound package/worldline bindings or automatic product updates.
			delete config.novelPlay; delete config.novelPlayBinding;
			const material = (file: unknown, target: string): string => {
				if (typeof file !== "string" || !file) throw Error("启用资料路径无效");
				if (pathMap.has(file.replace(/\\/g, "/"))) return pathMap.get(file.replace(/\\/g, "/"))!;
				copy(isAbsolute(file) ? file : join(this.#cwd, file), join(work, target)); pathMap.set(file.replace(/\\/g, "/"), target); return target;
			};
			if (typeof config.preset === "string" && config.preset) config.preset = material(config.preset, localPath(config.preset, "presets"));
			const books = Array.isArray(config.lorebooks) ? config.lorebooks : typeof config.lorebook === "string" && config.lorebook ? [config.lorebook] : [];
			config.lorebooks = books.map(book => material(book, typeof book === "string" ? localPath(book, "lorebooks") : "invalid")); delete config.lorebook;
			// Copy ONLY this card's bound/auxiliary entities; a new story never inherits another session's books.
			const sourceConfig = { ...snapshot.config, card } as unknown as RpConfig;
			const resolvedBooks = resolveWorldbooks(this.#cwd, sourceConfig, { card: cardData, rawCard: readCardRawJson(source.file).raw });
			const auxBooks = scopedLorebookPaths(sourceConfig, "character_aux").map(path => material(path, localPath(path, "lorebooks")));
			const primary = resolvedBooks.primary;
			const bindings = { ...sourceConfig.lorebookBindings }; delete bindings.chat; delete bindings.character; delete bindings.primary;
			if (auxBooks.length) bindings.character = { [worldbookCardKey(cardPath)]: auxBooks };
			if (primary?.source === "file" && resolvedBooks.declaredPrimary) {
				const path = material(primary.path, localPath(primary.path, "lorebooks"));
				bindings.primary = { [worldbookCardKey(cardPath)]: { reference: resolvedBooks.declaredPrimary, path } };
			}
			if (Object.keys(bindings).length) config.lorebookBindings = bindings; else delete config.lorebookBindings;
			if (Array.isArray(config.cardSkinOff)) config.cardSkinOff = config.cardSkinOff.map(path => typeof path === "string" ? pathMap.get(path.replace(/\\/g, "/")) ?? path : path);
			if (config.loreEntryOverrides && typeof config.loreEntryOverrides === "object" && !Array.isArray(config.loreEntryOverrides)) {
				config.loreEntryOverrides = Object.fromEntries(Object.entries(config.loreEntryOverrides).map(([key, value]) => {
					try { const parts = JSON.parse(key); if (Array.isArray(parts) && typeof parts[1] === "string" && pathMap.has(parts[1])) { parts[1] = pathMap.get(parts[1]); return [JSON.stringify(parts), value]; } } catch { /* Unknown compatibility keys remain unchanged. */ }
					return [key, value];
				}));
			}
			const overlay = overlayPathFor(this.#cwd, cardData.name);
			if (existsSync(overlay)) copy(overlay, overlayPathFor(work, cardData.name));
			const modernProfile = worldProfilePath(this.#cwd, card, cardData), legacyProfile = worldProfilePath(this.#cwd, card);
			const profile = existsSync(modernProfile) ? modernProfile : legacyProfile;
			if (existsSync(profile)) copy(profile, worldProfilePath(work, cardPath, cardData));
			privateJson(join(work, "liyuan.config.json"), config);
			privateJson(join(work, "liyuan.agent.json"), snapshot.agent);
			// Seed a complete enabled profile so legacy first-open migration cannot split away channels.
			privateJson(join(work, "liyuan-profiles/parallel.json"), { id: "parallel", name: "并行卡位配置快照", updatedAt: Date.now(), config: snapshot.agent });
			privateJson(join(work, "liyuan.agent.meta.json"), { activeId: "parallel" });
			privateJson(join(work, "package.json"), { name: "liyuan-private-play-slot", version: JSON.parse(regularBytes(join(CODE_ROOT, "package.json"), 8192).toString("utf8")).version, type: "module" });
			for (const file of [".liyuan/preset-override.json", ".liyuan-personas.json"]) if (existsSync(join(this.#cwd, file))) copy(join(this.#cwd, file), join(work, file));
			if (snapshot.agentDirectory && existsSync(join(snapshot.agentDirectory, "auth.json"))) {
				const stored = JSON.parse(regularBytes(join(snapshot.agentDirectory, "auth.json"), 256 * 1024).toString("utf8")) as Record<string, { type?: string }>;
				const providers = snapshot.agent.providers as Record<string, { apiKey?: unknown }> | undefined;
				const inherited: Record<string, unknown> = {};
				for (const [provider, config] of Object.entries(providers ?? {})) {
					if (typeof config.apiKey === "string" && config.apiKey.trim() && config.apiKey.trim() !== "placeholder" && !config.apiKey.trim().startsWith("$")) continue;
					if (stored[provider]?.type === "oauth") throw Object.assign(Error("此配置依赖共享 OAuth 刷新凭据；并行卡位暂需独立 API Key 配置，不会复制刷新令牌或影响主窗口登录"), { code: "slot_oauth_unsupported" });
					if (stored[provider]?.type === "api_key") inherited[provider] = stored[provider];
				}
				if (Object.keys(inherited).length) privateJson(join(work, "agent/auth.json"), inherited);
			}

			// Built-in source is shared read-only by convention; all runtime directories are slot-private.
			for (const file of ["src", "skills", "node_modules"]) symlinkSync(join(CODE_ROOT, file), join(work, file), process.platform === "win32" ? "junction" : "dir");
			privateDir(join(work, ".liyuan"));
			symlinkSync(join(CODE_ROOT, ".liyuan/extensions"), join(work, ".liyuan/extensions"), process.platform === "win32" ? "junction" : "dir");
			const userSkills = join(this.#cwd, ".liyuan-stage-skills");
			let count = 0, total = 0;
			const copySkills = (from: string, to: string) => {
				const stat = lstatSync(from); if (stat.isSymbolicLink()) throw Error("私人 Skill 包含符号链接，未创建卡位");
				if (stat.isDirectory()) { privateDir(to); for (const name of readdirSync(from)) copySkills(join(from, name), join(to, name)); }
				else { if (++count > 256 || (total += stat.size) > 16 * 1024 * 1024) throw Error("私人 Skill 过大，未创建卡位"); copy(from, to); }
			};
			if (existsSync(userSkills)) copySkills(userSkills, join(work, ".liyuan-stage-skills"));
			setPassword(work, randomBytes(32).toString("hex"));
			const meta: PlaySlotMeta = { version: 1, id, name: source.name, card, createdAt: new Date().toISOString() };
			privateJson(join(directory, "meta.json"), meta); return meta;
		} catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; } // Only our unpublished, newly created workspace.
	}
	async create(card: string): Promise<PlaySlotView> {
		if (this.#disabled) throw Error("子卡位不能再次多开");
		if (this.#meta.size >= MAX_STORED || this.#running.size >= MAX_ACTIVE) throw Error("同时最多运行三个并行卡位；请先暂停一个空闲卡位");
		if(this.#switching)throw Error("主窗口正在交接，请稍后再新开卡位");
		const id = randomUUID(), meta = this.#createWorkspace(id, card); this.#meta.set(id, meta);this.#slotLeases.set(id,randomBytes(16).toString("hex"));
		await this.start(id); return this.list().find(slot => slot.id === id)!;
	}
	async start(id: string): Promise<void> {
		if (!ID.test(id) || !this.#meta.has(id) || this.#disabled || this.#closed) throw Error("卡位不存在");
		const prior = this.#running.get(id); if (prior?.pausing) throw Error("卡位正在暂停，请稍后恢复"); if (prior) return prior.ready;
		if (this.#running.size >= MAX_ACTIVE) throw Error("同时最多运行三个并行卡位");
		const work = join(this.root, id, "work"); privateDir(work);
  // Existing slots predate full-window hosting. Share only host-owned static code,
  // never another workspace's runtime/plugin data or sessions.
  privateDir(join(work,"web"));
  const publicDir=join(work,"web/public");
  if(!existsSync(publicDir))symlinkSync(join(CODE_ROOT,"web/public"),publicDir,process.platform==="win32"?"junction":"dir");
		const data = loadAccess(work); if (!data) throw Error("子卡位鉴权资料缺失，拒绝启动");
		const token = issueToken(work, data);
		// Reserve a slot before any async operation; concurrent launches must not exceed the limit.
		let fulfill!: () => void, reject!: (error: Error) => void;
		const ready = new Promise<void>((ok, fail) => { fulfill = ok; reject = fail; }); void ready.catch(() => {});
		const running: Running = { process: undefined as unknown as ChildProcess, port: 0, token, ready, busy: false, settling: false, pending: new Set(), controls:new Set(), viewers: new Set() };
		this.#running.set(id, running); this.#errors.delete(id);
		try {
			running.port = await freePort();
			if (this.#closed || this.#running.get(id) !== running) throw Error("卡位管理已关闭");
			const env = { ...process.env, HOME: join(work, "home"), LIYUAN_CODING_AGENT_DIR: join(work, "agent"), PI_CODING_AGENT_DIR: join(work, "agent"), HOST: "127.0.0.1", PORT: String(running.port), LIYUAN_PLAY_SLOT_CHILD: "1", LIYUAN_PLAY_SLOT_ID: id };
			for (const key of ["LIYUAN_HTTP", "LIYUAN_WEB_DIST_DIR", "LIYUAN_AUTH_TOKEN"]) delete (env as Record<string, string | undefined>)[key];
   (env as Record<string,string|undefined>).LIYUAN_WEB_DIST_DIR=process.env.LIYUAN_WEB_DIST_DIR??join(CODE_ROOT,"web/dist");
			running.process = spawn(process.execPath, [join(CODE_ROOT, "server/main.ts")], { cwd: work, env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
			let finished = false;
			const fail = () => {
				if (this.#running.get(id) !== running || running.pausing) return;
				this.#running.delete(id); this.#errors.add(id); running.monitor?.close(); running.process.kill();
				for (const viewer of running.viewers) viewer.close(1011, "slot unavailable");
				if (!finished) { finished = true; reject(Error("卡位子服务启动失败，原存档保留")); }
			};
			running.process.once("error", fail); running.process.once("exit", fail);
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline && this.#running.get(id) === running) {
				try {
					const health = await fetch(`http://127.0.0.1:${running.port}/healthz`, { headers: { cookie: `${ACCESS_COOKIE}=${token}` }, signal: AbortSignal.timeout(1000) });
					if (health.ok && (await health.json() as { playSlotId?: string }).playSlotId === id) break;
				} catch { /* startup retry */ }
				await new Promise(ok => setTimeout(ok, 100));
			}
			if (this.#running.get(id) !== running || Date.now() >= deadline) throw Error("卡位启动超时");
			const monitor = new WebSocket(`ws://127.0.0.1:${running.port}/ws`, { headers: { cookie: `${ACCESS_COOKIE}=${token}` }, maxPayload: MAX_HISTORY_BYTES }); running.monitor = monitor;
			monitor.on("message", raw => {
				try {
					const frame = JSON.parse(raw.toString());
					if (frame.type === "hello") { for (const message of frame.messages ?? []) if (message.messageId) running.pending.delete(message.messageId); running.sessionId = frame.sessionId; running.busy = frame.streaming === true; running.settling = frame.settling === true; if (!finished) { finished = true; fulfill(); } }
					if (frame.type === "agent") { running.busy = frame.state !== "end"; running.settling = frame.state === "settling"; }
					if (frame.type === "prompt_ack") running.pending.delete(frame.messageId);
				} catch { /* Never expose malformed/internal packets. */ }
			});
			monitor.once("error", fail); monitor.once("close", fail);
			const timer = setTimeout(() => { if (!finished) { fail(); running.process.kill(); } }, 15_000); timer.unref();
			void ready.finally(() => clearTimeout(timer)).catch(() => {});
			await ready;
		} catch { if (this.#running.get(id) === running) this.#running.delete(id); this.#errors.add(id); running.process?.kill(); reject(Error("卡位子服务启动失败，原存档保留")); }
		return ready;
	}
	async pause(id: string): Promise<void> {
  if(this.#switching)throw Error("主窗口正在交接");
  if(this.#mainId===id)throw Error("该故事正在主窗口游玩，请先放回多卡或返回原主窗口");
		if (!ID.test(id) || !this.#meta.has(id)) throw Error("卡位不存在");
		const running = this.#running.get(id); if (!running) return;
		if (!running.sessionId || running.busy || running.settling || running.pending.size || running.controls.size || running.pausing) throw Error("卡位仍在生成、结算或受理输入；请等待完成后暂停");
		running.pausing = true;
		try {
   // Freeze gateway inputs before asking the actual worker, including its assistant.
   await this.#idle(running,true);
   if(this.#running.get(id)!==running)throw Error("卡位已换代");
			for (const viewer of running.viewers) viewer.close(1000, "slot paused");
			running.monitor?.close();
			await new Promise<void>(ok => {
				if (running.process.exitCode !== null || running.process.signalCode !== null) { ok(); return; }
				const timer = setTimeout(() => running.process.kill("SIGKILL"), 10_000); timer.unref();
				running.process.once("exit", () => { clearTimeout(timer); ok(); }); running.process.kill();
			});
			if (this.#running.get(id) === running) this.#running.delete(id);
		} finally { running.pausing = false; }
	}

	revokeInvalidSockets(): void {
		for (const running of this.#running.values()) for (const socket of running.viewers) {
			const request = (socket as WebSocket & { slotRequest?: IncomingMessage }).slotRequest;
			if (request && !this.#host.authorized(request)) socket.close(4401, "unauthorized");
		}
	}
	async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
		const path = requestPathname(req.url??"/");
		if (path !== "/api/play-slots" && !path.startsWith("/api/play-slots/")) return false;
		const json = (code: number, value: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "private, no-store" }); res.end(JSON.stringify(value)); };
		if(this.#disabled && path==="/api/play-slots/idle" && req.method==="GET" && this.#host.authorized(req) && isSameOriginRequest(req)){const busy=this.#host.mainBusy?.()!==false;if(!busy)this.#host.persist?.();json(200,{busy});return true;}
		if (this.#disabled) { json(404, { error: "子卡位不支持再次多开" }); return true; }
		if (!this.#host.authorized(req) || !isSameOriginRequest(req)) { json(403, { error: "卡位管理未获授权" }); return true; }
		try {

   if(path==="/api/play-slots/main"&&req.method==="GET"){json(200,this.mainStatus());return true;}
   if(path==="/api/play-slots/cards"&&req.method==="GET"){json(200,this.#host.cards?.()??{cards:[]});return true;}
   if(path==="/api/play-slots/main"&&req.method==="POST"){
    const body=await jsonBody(req);if(Object.keys(body).some(k=>!["id","expectedWorkspace","expectedLease"].includes(k))||!(body.id===null||typeof body.id==="string")||typeof body.expectedWorkspace!=="string"||typeof body.expectedLease!=="string")throw Error("请提供当前主窗口归属与目标卡位");
    await this.openMain(body.id,body.expectedWorkspace,body.expectedLease);json(200,this.mainStatus());return true;
   }
			if (path === "/api/play-slots" && req.method === "GET") { json(200, { slots: this.list(), main:this.mainStatus(), maxActive: MAX_ACTIVE, maxStored: MAX_STORED }); return true; }
			if (path === "/api/play-slots" && req.method === "POST") { const body = await jsonBody(req); if (typeof body.card !== "string" || Object.keys(body).some(key => key !== "card")) throw Error("请选择卡库中的角色卡"); json(201, { slot: await this.create(body.card) }); return true; }
			const match = /^\/api\/play-slots\/([^/]+)\/(start|pause)$/.exec(path);
			if (match && req.method === "POST") { if (match[2] === "start") await this.start(match[1]); else await this.pause(match[1]); json(200, { slots: this.list() }); return true; }
			json(404, { error: "卡位接口不存在" });
		} catch (error) {
			if ((error as { code?: string }).code === "slot_novel_unsupported") json(400, { error: "绑定私有原著包的开演卡暂不支持并行复制；请在主窗口继续使用，不会剥离绑定或修改原卡。" });
			else if ((error as { code?: string }).code === "slot_oauth_unsupported") json(400, { error: "此配置依赖共享 OAuth 刷新凭据；并行卡位暂需独立 API Key 配置，不会复制刷新令牌或影响主窗口登录。" });
			else json(409, { error: path==="/api/play-slots/main" ? "主窗口切换未完成：请确认当前归属未变化，生成/后台/助手和保存已结束；恢复已暂停的卡位须留出运行名额（最多三席）。原存档保留。" : "卡位操作未完成：请检查卡位是否忙碌、已达三个并行上限，以及所选卡和启用资料是否可用。原存档保留。" });
		}
		return true;
	}
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		const pathname=(req.url??"").split("?")[0];
  const main=pathname==="/ws"&&this.#mainId!==null;
  if(pathname==="/ws"&&!this.#disabled&&!this.rootWritable(req)&&!main){socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");return true;}
  if(main&&(!this.#host.authorized(req)||!isSameOriginRequest(req)||!this.accepts(req)||this.#switching)){socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");return true;}
  const match = main?["",this.#mainId!] : /^\/api\/play-slots\/([^/]+)\/ws$/.exec(pathname);
  if(!match)return false;
  if(main&&!this.#running.get(match[1])?.sessionId){const selected=match[1];void this.start(selected).then(()=>{if(this.#mainId===selected&&this.accepts(req))this.handleUpgrade(req,socket,head);else socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");},()=>socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"));return true;}
		const running = this.#running.get(match[1]);
  const slotLease=new URL(req.url??"/","http://localhost").searchParams.get("slotLease");
  const slotCurrent=()=>main?this.accepts(req):slotLease===this.#slotLeases.get(match[1])||!slotLease&&!this.#handedOff;
		if (!slotCurrent() || this.#disabled || this.#switching || running?.transferring || running?.pausing || !main&&this.#mainId===match[1] || !running?.sessionId || !this.#host.authorized(req) || !isSameOriginRequest(req)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return true; }
		this.#gateway.handleUpgrade(req, socket, head, viewer => {
			(viewer as WebSocket & { slotRequest?: IncomingMessage }).slotRequest = req;
			running.viewers.add(viewer);
			const upstream = new WebSocket(`ws://127.0.0.1:${running.port}/ws`, { headers: { cookie: `${ACCESS_COOKIE}=${running.token}` }, maxPayload: MAX_HISTORY_BYTES });
   const controls=new Set<string>(),sentPrompts=new Set<string>();
   const cleanup=()=>{for(const id of controls)running.controls.delete(id);for(const id of sentPrompts)running.pending.delete(id);controls.clear();sentPrompts.clear();};
			const authorize = () => this.#host.authorized(req) && slotCurrent() && this.#running.get(match[1]) === running && (main?this.#mainId===match[1]&&this.accepts(req):this.#mainId!==match[1]);
			viewer.on("message", (raw, binary) => {
				if (!authorize()) { viewer.close(4401, "unauthorized"); return; }
				if (binary || upstream.readyState !== WebSocket.OPEN) return;
				try {
					const frame = JSON.parse(raw.toString());
					if (running.pausing || running.transferring || this.#switching) { if (["prompt","assistant_prompt"].includes(frame.type)) viewer.send(JSON.stringify({ type: "prompt_ack", messageId: frame.messageId, sessionId: frame.sessionId ?? running.sessionId, status: "rejected", reason: "卡位正在暂停或交接，输入未受理，草稿保留" })); return; }
					if(main){
      if(running.controls.size>=64){viewer.send(JSON.stringify({type:"notify",level:"warning",text:"卡位请求较多，请等待受理后重试"}));return;}
      const id=randomUUID();controls.add(id);running.controls.add(id);
      if(["prompt","assistant_prompt"].includes(frame.type)&&typeof frame.messageId==="string"&&MESSAGE_ID.test(frame.messageId))running.pending.add(frame.messageId);
      if(["prompt","assistant_prompt"].includes(frame.type)&&typeof frame.messageId==="string")sentPrompts.add(frame.messageId);
      upstream.send(JSON.stringify({type:"workspace_command",id,frame}));return;
     }
					if (frame.type === "abort") { upstream.send(JSON.stringify({ type: "abort" })); return; }
					if (frame.type !== "prompt" || typeof frame.text !== "string" || !frame.text.trim() || frame.text.length > 256_000 || frame.text.trimStart().startsWith("/") || frame.plotChoice !== undefined || frame.sessionId !== running.sessionId || typeof frame.messageId !== "string" || !MESSAGE_ID.test(frame.messageId) || !["direct", "director"].includes(frame.generationMode)) { if (frame.type === "prompt" && typeof frame.messageId === "string" && MESSAGE_ID.test(frame.messageId) && typeof frame.sessionId === "string") viewer.send(JSON.stringify({ type: "prompt_ack", messageId: frame.messageId, sessionId: frame.sessionId, status: "rejected", reason: "并行卡位只接受当前会话的普通正文输入；命令或剧情方向请在主窗口处理，草稿保留" })); else viewer.send(JSON.stringify({ type: "notify", level: "warning", text: "并行卡位只接受当前会话的普通正文输入" })); return; }
					if (running.pending.size >= 24 && !running.pending.has(frame.messageId)) { viewer.send(JSON.stringify({ type: "prompt_ack", messageId: frame.messageId, sessionId: frame.sessionId, status: "rejected", reason: "并行卡位待受理队列已满，输入未受理，草稿保留" })); return; }
					running.pending.add(frame.messageId);sentPrompts.add(frame.messageId);
					upstream.send(JSON.stringify({ type: "prompt", text: frame.text, sessionId: frame.sessionId, messageId: frame.messageId, generationMode: frame.generationMode }));
				} catch { viewer.close(1008, "invalid packet"); }
			});
			upstream.on("message", (raw, binary) => {
    if(!binary){try{const ack=JSON.parse(raw.toString());if(ack.type==="prompt_ack"){running.pending.delete(ack.messageId);sentPrompts.delete(ack.messageId);if(viewer.readyState!==WebSocket.OPEN&&!controls.size&&!sentPrompts.size)upstream.close();}if(main&&ack.type==="workspace_command_done"){controls.delete(ack.id);running.controls.delete(ack.id);if(viewer.readyState!==WebSocket.OPEN&&!controls.size)upstream.close();return;}}catch{}}
				if (!authorize()) { viewer.close(4401, "unauthorized"); return; }
				if (!binary && viewer.readyState === WebSocket.OPEN) {
					try { const frame = JSON.parse(raw.toString()); if (!main&&(String(frame.type).startsWith("assistant_") || ["update", "sessions", "choice"].includes(frame.type))) return; if (frame.type === "prompt_ack") running.pending.delete(frame.messageId); } catch { return; }
					viewer.send(raw.toString());
				}
			});
			upstream.once("error", () => viewer.close(1011, "slot unavailable")); upstream.once("close", () => {cleanup();viewer.close(1011, "slot disconnected");});
			viewer.once("close", () => { running.viewers.delete(viewer); if(!controls.size&&!sentPrompts.size)upstream.close(); }); viewer.once("error", () => upstream.close());
		}); return true;
	}
	close(): void { if (this.#closed) return; this.#closed = true; for (const running of this.#running.values()) { running.monitor?.close(); for (const viewer of running.viewers) viewer.close(); running.process?.kill(); } this.#running.clear(); this.#gateway.close(); }
}
