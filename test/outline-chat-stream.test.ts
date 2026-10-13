import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { streamOutlineDiscussion } from "../server/outline-chat-stream.ts";
import { readDiscussionStream, DiscussionEventParser, discussionReplyPreview } from "../web/src/planning/discussion-stream.ts";

async function serve(run: Parameters<typeof streamOutlineDiscussion>[2], testRun: (base: string) => Promise<void>) {
	const server = createServer((req, res) => { void streamOutlineDiscussion(req, res, run, 20); });
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	try { await testRun(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
	finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
test("SSE is immediately flushed and kept alive before a slow director produces any tokens", { timeout: 5000 }, async () => {
	let finish!: (value: unknown) => void;
	await serve(() => new Promise(resolve => { finish = resolve; }), async base => {
		const res = await fetch(base);
		assert.equal(res.headers.get("x-accel-buffering"), "no");
		const reader = res.body!.getReader(), decoder = new TextDecoder();
		const first = decoder.decode((await reader.read()).value);
		assert.match(first, /event: status/);
		const second = decoder.decode((await reader.read()).value);
		assert.match(second, /keep-alive/);
		finish({ requestId: "slow-fixture", reply: "Complete saved reply", warnings: [] });
		let rest = "";
		while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += decoder.decode(chunk.value); }
		assert.match(rest, /event: done/);
	});
});
test("SDK deltas preserve newlines, quotes, backslashes, and Chinese through real HTTP SSE", async () => {
	const delta = '第一行\n第二行 "引用" \\尾部';
	await serve(async options => {
		options.onDelta({ kind: "text", delta });
		return { requestId: "unicode-fixture", reply: delta, warnings: [] };
	}, async base => {
		const deltas: string[] = [];
		const result = await readDiscussionStream(await fetch(base), text => deltas.push(text));
		assert.deepEqual(deltas, [delta]); assert.equal(result.reply, delta);
	});
});
test("disconnect aborts the provider-facing signal rather than committing a late reply", { timeout: 5000 }, async () => {
	let cancelled!: () => void;
	const stopped = new Promise<void>(resolve => { cancelled = resolve; });
	await serve(async options => {
		options.signal.addEventListener("abort", cancelled, { once: true });
		return new Promise(() => undefined);
	}, async base => {
		const res = await fetch(base);
		await res.body!.cancel(); await stopped;
	});
});
test("SSE model failure appears as an explicit error, not a blank reply", async () => {
	await serve(async () => { throw new Error("Synthetic provider failure\ntry again"); }, async base => {
		await assert.rejects(readDiscussionStream(await fetch(base)), /Synthetic provider failure\ntry again/);
	});
});
test("SSE parser handles arbitrary chunk boundaries, comments, CRLF, and multi-line data", () => {
	const parser = new DiscussionEventParser(), events: any[] = [];
	for (const chunk of ["event: del", "ta\r", "\ndata: first\r\n", ": keep-alive\r\n", "data: second\r\n\r", "\n"]) events.push(...parser.feed(chunk));
	assert.deepEqual(events, [{ event: "delta", data: "first\nsecond" }]);
});
test("truncated stream cannot be treated as success from parseable partial JSON", async () => {
	await assert.rejects(readDiscussionStream(new Response('event: delta\ndata: "{\\\"answer\\\":\\\"draft\\\"}"\n\n')), /提前断开/);
	await assert.rejects(readDiscussionStream(new Response('event: done\ndata: {"requestId":"invalid","reply":""}\n\n')), /有效回答/);
});
test("provisional UI shows answer text, not JSON, and tolerates split escapes", () => {
	assert.equal(discussionReplyPreview('{"answer":"第一行\\n第二行\\\"引用\\\"","proposal":null}'), '第一行\n第二行"引用"');
	assert.equal(discussionReplyPreview('{"answer":"前缀\\u4e'), "前缀");
	assert.equal(discussionReplyPreview('{"options":['), "");
});
