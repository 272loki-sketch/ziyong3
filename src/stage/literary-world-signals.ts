import type { LiteraryEcologyState } from "./literary-ecology.ts";
import type { ModularWorldState, WorldDomainRef, WorldVisibility } from "./literary-world-modular.ts";

export interface CrossDomainSignal {
	source: "world" | "ecology";
	sourceRound: number;
	ref: WorldDomainRef;
	kind: string;
	visibility: WorldVisibility;
	summary: string;
}

export function ecologySignalsForWorld(ecology: LiteraryEcologyState): CrossDomainSignal[] {
	return ecology.occurrences.flatMap((item): CrossDomainSignal[] => {
		const surface = item.publicSurface;
		const terminal = item.status === "resolved" || item.status === "expired";
		// Match the author projection's information boundary: an explicit surface
		// replaces internal event fields, and a private surface is never a fallback.
		if (surface?.publicity === "private" || (!surface && item.visibility === "secret")) return [];
		let summary: string;
		if (surface?.publicity === "trace") {
			if (!surface.trace.trim()) return [];
			summary = `公开痕迹：${surface.trace}`;
		} else if (surface?.publicity === "public") {
			if (![surface.summary, surface.trace, surface.result].some(value => value.trim())) return [];
			const detail = (label: string, value: string) => value ? `；${label}：${value}` : "";
			summary = `${surface.headline || "公开消息"}［说法标记：${surface.claimStatus}；${surface.sourceType}］：${surface.summary || surface.trace}${detail("公开结果", surface.result)}${detail("受众", surface.audience.join("、"))}${detail("传播范围", surface.scope)}`;
		} else {
			// Bare discoverable records are ongoing leads, not public aftermath.
			if (terminal && (item.visibility !== "public" || !item.development.trim())) return [];
			summary = `${item.name}@${item.location || "地点未定"}：${item.development}`;
		}
		if (terminal) summary = `已结束事项的后果参考［${item.status}］：${summary}`;
		const visibility = surface ? "public" : item.visibility;
		return [{ source: "ecology", sourceRound: ecology.round, ref: { domain: "ecology", recordId: item.id }, kind: surface?.publicity === "trace" ? "public-trace" : item.kind, visibility, summary }];
	}).slice(0, 20);
}

export function worldSignalsForEcology(world: ModularWorldState): CrossDomainSignal[] {
	return Object.values(world.modules).flatMap((module) => module.records.filter((record) => record.visibility !== "secret").map((record) => {
		const schedule = [record.attributes.date, record.attributes.time, record.attributes.deadline, record.attributes.location].filter((value) => typeof value === "string" && value.trim()).join(" / ");
		return { source: "world" as const, sourceRound: world.round, ref: { domain: "world" as const, moduleId: module.id, recordId: record.id }, kind: record.facet, visibility: record.visibility, summary: `${record.label}（${record.status || "持续中"}）：${record.summary}${schedule ? `［${schedule}］` : ""}` };
	})).slice(0, 30);
}
