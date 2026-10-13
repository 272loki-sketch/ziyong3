import type { IncomingMessage, ServerResponse } from "node:http";
import { abortable } from "../src/async-abort.ts";
import type { SideModelDelta } from "./side-model-result.ts";

/** SSE is an acknowledged transport, not a partial-JSON substitute for a saved discussion. */
export async function streamOutlineDiscussion(
	req: IncomingMessage, res: ServerResponse,
	run: (options: { signal: AbortSignal; onDelta: (event: SideModelDelta) => void }) => Promise<unknown>,
	heartbeatMs = 15_000,
): Promise<void> {
	const controller = new AbortController();
	const disconnect = () => controller.abort(new Error("创作对谈连接已关闭"));
	const send = (event: string, value: unknown) => {
		if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
	};
	res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "connection": "keep-alive", "x-accel-buffering": "no" });
	res.flushHeaders();
	req.once("aborted", disconnect);
	res.once("close", disconnect);
	send("status", { message: "导演正在读取当前分支与最近讨论…" });
	const heartbeat = setInterval(() => {
		if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) res.write(": keep-alive\n\n");
	}, heartbeatMs);
	heartbeat.unref();
	try {
		const result = await abortable(run({ signal: controller.signal, onDelta: event => {
			if (event.kind === "text") send("delta", event.delta);
			else throw new Error(event.text);
		} }), controller.signal);
		send("done", result);
	} catch (cause) {
		send("error", cause instanceof Error ? cause.message : String(cause));
	} finally {
		clearInterval(heartbeat);
		req.removeListener("aborted", disconnect);
		res.removeListener("close", disconnect);
		if (!res.destroyed && !res.writableEnded) res.end();
	}
}
