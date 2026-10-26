/** Live sidecar state: do not use the generic panel GET cache or treat a settled warning as an HTTP error. */
export async function requestPlotOptions<T>(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown): Promise<T> {
    const response = await fetch(path, { method, cache: "no-store", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data: unknown;
    try { data = await response.json(); } catch { throw Error(`剧情选项响应不是 JSON（HTTP ${response.status}）`); }
    if (!response.ok) throw Error((data as { error?: string })?.error || `剧情选项请求失败（HTTP ${response.status}）`);
    return data as T;
}
