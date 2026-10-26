export const MULTI_SPEAKER_MODELS: readonly string[];
export const MUTED: string;
export function parseVoiceInput(input: string): string | null;
export function removeUnspoken(text: string, options?: { skipMarkup?: boolean; extraTags?: string[] }): string;
export function buildSpeakerRequest(segments: { speaker: string | null; text: string }[], resolveVoice: (name: string) => string | null, defaultVoiceId: string): { voices: string[]; text: string; turns: { voiceId: string; speaker: string | null; text: string }[] };
