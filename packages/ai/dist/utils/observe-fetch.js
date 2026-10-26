/** Wrap only this client's fetch, without buffering, teeing, or issuing another request. */
export function observeFetch(notify) {
    let traceId = "";
    const emit = (type, fields = {}) => {
        try {
            notify({ type, traceId, timestamp: Date.now(), ...fields });
        }
        catch { /* Diagnostics must not break transport. */ }
    };
    const failure = (error) => {
        const raw = error;
        const code = raw?.cause?.code ?? raw?.code;
        emit("transportError", typeof code === "string" && /^(?:UND_ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ABORT_ERR)$/.test(code) ? { errorCode: code } : {});
    };
    return {
        effective: () => emit("firstEffectiveDelta"),
        fetch: (async (input, init) => {
            traceId = globalThis.crypto.randomUUID();
            emit("transportStarted");
            let response;
            try {
                response = await globalThis.fetch(input, init);
            }
            catch (error) {
                failure(error);
                throw error;
            }
            const id = response.headers.get("x-request-id");
            emit("responseHeaders", { status: response.status, ...(id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? { requestId: id } : {}) });
            if (!response.body)
                return response;
            const reader = response.body.getReader();
            let first = true;
            const body = new ReadableStream({
                async pull(controller) {
                    try {
                        const result = await reader.read();
                        if (result.done) {
                            emit("bodyEnd");
                            controller.close();
                            reader.releaseLock();
                        }
                        else {
                            if (first && result.value.byteLength) {
                                first = false;
                                emit("firstByte");
                            }
                            controller.enqueue(result.value);
                        }
                    }
                    catch (error) {
                        failure(error);
                        controller.error(error);
                        reader.releaseLock();
                    }
                },
                async cancel(reason) { try {
                    await reader.cancel(reason);
                }
                finally {
                    reader.releaseLock();
                } },
            }, { highWaterMark: 0 });
            const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
            for (const key of ["url", "redirected", "type"])
                Object.defineProperty(observed, key, { value: response[key] });
            return observed;
        }),
    };
}
//# sourceMappingURL=observe-fetch.js.map