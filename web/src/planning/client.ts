import { apiGet, apiPost, apiPut, apiDelete } from "../api.ts";
import { readDiscussionStream } from "./discussion-stream.ts";
import type {
	CorpusCreateResponse, CorpusDetailResponse, CorpusDiscoveryResponse, CorpusWorkbenchResponse,
	MemoryDiffResponse, MemoryEventsResponse,
	OutlineChatHistory, OutlineChatResponse, OutlineDiscussionFocus, OutlineHistoryResponse, OutlineProposal, OutlineReconcileResponse,
	OutlineResearchSearchResponse, OutlineResearchView, ResearchSearchScheduleRun, ResearchSearchScheduleStatus, OutlineSettings, OutlineSettingsResponse, OutlineViewResponse, ResearchSearchLogsResponse, TurnDiagnosticsResponse,
} from "./types.ts";

export const getOutline = () => apiGet<OutlineViewResponse>("/api/outline", { bypassCache: true });
export const getOutlineVersions = () => apiGet<OutlineHistoryResponse>("/api/outline/versions", { bypassCache: true });
export const chatOutline = (message: string, researchMode?: OutlineSettings["researchMode"], focus: OutlineDiscussionFocus = "open") =>
	apiPost<OutlineChatResponse>("/api/outline/chat", { message, researchMode, focus });
export const bootstrapOutline = (experienceWish?: string) =>
	apiPost<OutlineProposal>("/api/outline/bootstrap", { experienceWish });
export const reconcileOutline = () => apiPost<OutlineReconcileResponse>("/api/outline/reconcile", {});
export const confirmOutlineProposal = (id: string, proposalHash: string) =>
	apiPost(`/api/outline/proposals/${encodeURIComponent(id)}/confirm`, { proposalHash });
export const rejectOutlineProposal = (id: string, reason?: string) =>
	apiPost(`/api/outline/proposals/${encodeURIComponent(id)}/reject`, { reason });
export const getOutlineResearch = () => apiGet<OutlineResearchView>("/api/outline/research", { bypassCache: true });
export const refreshOutlineResearch = (topic?: string) =>
	apiPost<OutlineResearchView>("/api/outline/research/refresh", { topic });
export const searchOutlineResearch = (topic?: string) =>
	apiPost<OutlineResearchSearchResponse>("/api/outline/research/search", { topic });
export const searchResearchLogs = () => apiGet<ResearchSearchLogsResponse>("/api/outline/research/search/logs", { bypassCache: true });
export const getResearchSearchSchedule = () => apiGet<ResearchSearchScheduleStatus>("/api/outline/research/search/schedule", { bypassCache: true });
export const runResearchSearchSchedule = () => apiPost<ResearchSearchScheduleRun>("/api/outline/research/search/schedule/run", {});
export const retrySearchExtraction = (id: string) =>
	apiPost<OutlineResearchSearchResponse>(`/api/outline/research/search/logs/${encodeURIComponent(id)}/retry`, {});
export const putOutlineSettings = (settings: Required<OutlineSettings>) =>
	apiPut<OutlineSettingsResponse>("/api/outline/settings", settings);
export const getTurnDiagnostics = (limit = 12) => apiGet<TurnDiagnosticsResponse>(`/api/turn-diagnostics?limit=${limit}`, { bypassCache: true });
export const listCorpus = () => apiGet<CorpusWorkbenchResponse>("/api/outline/corpus", { bypassCache: true });
export const createCorpus = (file: string) => apiPost<CorpusCreateResponse>("/api/outline/corpus", { file });
export const createCorpusVersion = (baseDocId: string, file: string) => apiPost<CorpusCreateResponse & { reusedChunks: number; newChunks: number }>("/api/outline/corpus/version", { baseDocId, file });
export const createCorpusUrl = (url: string) => apiPost<CorpusCreateResponse>("/api/outline/corpus/url", { url });
export const discoverCorpus = () => apiPost<CorpusDiscoveryResponse>("/api/outline/corpus/discover", {});
export const getCorpusDetail = (id: string) => apiGet<CorpusDetailResponse>(`/api/outline/corpus/${encodeURIComponent(id)}`, { bypassCache: true });
export const pauseCorpus = (id: string) => apiPost<CorpusWorkbenchResponse>(`/api/outline/corpus/${encodeURIComponent(id)}/pause`, {});
export const resumeCorpus = (id: string) => apiPost<CorpusWorkbenchResponse>(`/api/outline/corpus/${encodeURIComponent(id)}/resume`, {});
export const deleteCorpus = (id: string) => apiDelete<{ ok: true; removedMechanisms: number }>(`/api/outline/corpus/${encodeURIComponent(id)}`);
export const clearChats = (contextKey?: string,discussionId?:string) => apiDelete<{ ok: true; chats: OutlineChatHistory[] }>(`/api/outline/chats${"?"+new URLSearchParams({...contextKey?{contextKey}:{},...discussionId?{discussionId}:{} }).toString()}`);
export const deleteChat = (id: string, contextKey?: string,discussionId?:string) => apiDelete<{ ok: true; chats: OutlineChatHistory[] }>(`/api/outline/chats/${encodeURIComponent(id)}${"?"+new URLSearchParams({...contextKey?{contextKey}:{},...discussionId?{discussionId}:{} }).toString()}`);

export const getMemoryEvents = () => apiGet<MemoryEventsResponse>("/api/memory/events", { bypassCache: true });
export const getMemoryDiff = (limit = 50) => apiGet<MemoryDiffResponse>(`/api/memory/diff?limit=${limit}`, { bypassCache: true });

export async function streamOutlineChat(message: string, researchMode?: OutlineSettings["researchMode"], focus: OutlineDiscussionFocus = "open", onDelta?: (text: string) => void, options: { signal?: AbortSignal; contextKey?: string; discussionId?:string; onStatus?: (text: string) => void } = {}): Promise<OutlineChatResponse> {
	const deadline = AbortSignal.timeout(300_000);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	try {
		const response = await fetch("/api/outline/chat/stream", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ message, researchMode, focus, contextKey: options.contextKey,discussionId:options.discussionId }), signal,
		});
		return await readDiscussionStream(response, onDelta, options.onStatus);
	} catch (cause) {
		if (options.signal?.aborted) throw new Error("讨论已停止，输入已保留");
		if (deadline.aborted) throw new Error("导演对谈超过 5 分钟仍未完成，请重试；输入已保留");
		throw cause;
	}
}

export const createDiscussion=(title:string,contextKey?:string)=>apiPost<OutlineViewResponse>("/api/outline/discussions",{title,contextKey});
export const selectDiscussion=(id:string,contextKey?:string)=>apiPost<OutlineViewResponse>("/api/outline/discussions/"+encodeURIComponent(id)+"/select",{contextKey});
export const renameDiscussion=(id:string,title:string,contextKey?:string)=>apiPut<OutlineViewResponse>("/api/outline/discussions/"+encodeURIComponent(id),{title,contextKey});
export const getEarlierDiscussion=(id:string,before:string,contextKey?:string)=>apiGet<{chats:OutlineChatHistory[];hasMore:boolean}>("/api/outline/discussions/"+encodeURIComponent(id)+"/chats?"+new URLSearchParams({before,...contextKey?{contextKey}:{}}),{bypassCache:true});
