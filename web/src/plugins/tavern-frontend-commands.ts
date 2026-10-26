import { executeNativeFrontendSlash, type SlashExecResult } from "../tavernShim.ts";
import { scopedUrl, workspaceStale } from "../workspace.ts";

type Target = { window: Window | null; entryId?: string; entryScope?: string; token: number; enabled: boolean };
type Binding = { scopeKey: string; sourceEntryId: string };
type Command = { requestId: string; command: string; entryId: string; entryScope: string; sourceEntryId: string };
type Result = { ok: boolean; pipe?: string; error?: string };
type Attempt = { command: Command; result: Promise<Result>; controller: AbortController };

/** Only a mounted native render realm can enter the existing composer path. Never sends WS/model requests itself. */
export function createTavernFrontendCommands(options: {
 target: () => Target;
 origin: string;
 loadBinding?: (signal: AbortSignal) => Promise<Binding>;
 execute?: (command: string) => SlashExecResult;
 stale?: () => boolean;
}) {
 const attempts = new Map<string, Attempt>();
 let closed = false;
 const current = (expected: Target) => {
  const next = options.target();
  return !closed && !(options.stale ?? workspaceStale)() && next.enabled && next.window === expected.window && next.token === expected.token && next.entryId === expected.entryId && next.entryScope === expected.entryScope;
 };
 const loadBinding = options.loadBinding ?? (async (signal: AbortSignal) => {
  const response = await fetch(scopedUrl("/api/tavern-plugins/binding"), { signal, cache: "no-store" });
  if (!response.ok) throw new Error("无法核对前端来源，输入未提交，请刷新后重试");
  return response.json() as Promise<Binding>;
 });
 const receive = (event: MessageEvent) => {
  const target = options.target(), data = event.data as Partial<Command> & { type?: unknown } | null;
  if (closed || event.origin !== options.origin || !target.window || event.source !== target.window || data?.type !== "liyuan-tavern-command") return;
  if (typeof data.requestId !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(data.requestId)) return;
  const reply = (result: Result) => {
   if (!closed && options.target().window === target.window) target.window!.postMessage({ type: "liyuan-tavern-command-result", requestId: data.requestId, entryId: data.entryId, entryScope: data.entryScope, sourceEntryId: data.sourceEntryId, ...result }, options.origin);
  };
  if (!current(target) || !target.entryId || !target.entryScope || data.entryId !== target.entryId || data.entryScope !== target.entryScope || typeof data.sourceEntryId !== "string" || typeof data.command !== "string" || !data.command.trim() || data.command.length > 256_000) {
   reply({ ok: false, error: "原前端来源已变化或命令无效，输入未提交" }); return;
  }
  const command: Command = { requestId: data.requestId, command: data.command, entryId: data.entryId, entryScope: data.entryScope, sourceEntryId: data.sourceEntryId };
  const existing = attempts.get(command.requestId);
  if (existing) {
   if (JSON.stringify(existing.command) !== JSON.stringify(command)) reply({ ok: false, error: "请求编号已绑定其他命令，未重复执行" });
   else void existing.result.then(reply);
   return;
  }
  if (attempts.size >= 32) { reply({ ok: false, error: "本前端命令回执过多，请重新打开界面后核对，不自动重试" }); return; }
  const controller = new AbortController();
  const result = (async (): Promise<Result> => {
   try {
    const binding = await loadBinding(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
    if (!current(target) || controller.signal.aborted || binding.scopeKey !== command.entryScope || binding.sourceEntryId !== command.sourceEntryId) throw new Error("会话、角色卡或分支已变化，旧前端输入未提交");
    const value = (options.execute ?? executeNativeFrontendSlash)(command.command);
    if (!value.ok) throw new Error(value.error || "输入未被接收，草稿仍保留");
    return { ok: true, pipe: value.text ?? "" };
   } catch (error) {
    return { ok: false, error: (error instanceof Error ? error.message : "原前端输入未提交").replace(/[\u0000-\u001f]/g, " ").slice(0, 500) };
   }
  })();
  attempts.set(command.requestId, { command, result, controller });
  void result.then(reply);
 };
 return { receive, dispose() { closed = true; for (const attempt of attempts.values()) attempt.controller.abort(); attempts.clear(); } };
}
