export const MODELS: readonly string[];
export const MAX_TEXT_LENGTH: number;
export const MAX_SPEAKERS: number;
export function buildTtsRequest(input: unknown): { model: string; body: Record<string, unknown> };
