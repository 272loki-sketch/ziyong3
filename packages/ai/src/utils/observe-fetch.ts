import type { TransportObservation } from "../types.ts";

/** Wrap only this client's fetch, without buffering, teeing, or issuing another request. */
export function observeFetch(notify: (event: TransportObservation) => void): {fetch: typeof fetch; effective: () => void} {
	let traceId = "";
	const emit = (type: TransportObservation["type"], fields: Partial<TransportObservation> = {}) => {
		try { notify({ type, traceId, timestamp: Date.now(), ...fields }); } catch { /* Diagnostics must not break transport. */ }
	};
	const failure = (error: unknown) => {
		const raw = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
		const code = raw?.cause?.code ?? raw?.code;
		emit("transportError", typeof code === "string" && /^(?:UND_ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ABORT_ERR)$/.test(code) ? { errorCode: code } : {});
	};
	return {
		effective: () => emit("firstEffectiveDelta"),
		fetch: (async (input, init) => {
			traceId = globalThis.crypto.randomUUID();
			emit("transportStarted");
			let response: Response;
			try { response = await globalThis.fetch(input, init); } catch (error) { failure(error); throw error; }
			const id = response.headers.get("x-request-id");
			emit("responseHeaders", { status: response.status, ...(id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? { requestId: id } : {}) });
			if (!response.body) return response;
			const reader = response.body.getReader();
			let first = true;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const result = await reader.read();
						if (result.done) { emit("bodyEnd"); controller.close(); reader.releaseLock(); }
						else { if (first && result.value.byteLength) { first = false; emit("firstByte"); } controller.enqueue(result.value); }
					} catch (error) { failure(error); controller.error(error); reader.releaseLock(); }
				},
				async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
			}, { highWaterMark: 0 });
			const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
			for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(observed, key, { value: response[key] });
			return observed;
		}) satisfies typeof fetch,
	};
}
