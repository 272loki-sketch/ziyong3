/** Shared wire settings only. Credentials and disk-only fields never cross this boundary. */
export interface NovelAiSettings {
	enabled: boolean;
	baseUrl: string;
	model: string;
	sampler: string;
	scheduler: string;
	steps: number;
	scale: number;
	cfgRescale: number;
	width: number;
	height: number;
	positivePrefix: string;
	positiveSuffix: string;
	negativePrompt: string;
}
export const DEFAULT_NOVELAI_SETTINGS: NovelAiSettings = {
	enabled: false, baseUrl: "https://image.novelai.net", model: "nai-diffusion-4-5-full",
	sampler: "k_dpmpp_2m", scheduler: "karras", steps: 28, scale: 10, cfgRescale: 0.18,
	width: 1024, height: 1024, positivePrefix: "", positiveSuffix: "", negativePrompt: "",
};
export interface NovelAiBinding { scopeKey: string }
export interface NovelAiStatus {
	config: NovelAiSettings;
	revision: string;
	apiKeyConfigured: boolean;
	legacySettings: boolean;
	binding: NovelAiBinding;
}
export interface NovelAiImage { src: string; bytes: number }
