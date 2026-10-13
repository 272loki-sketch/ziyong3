// Authorized bounded synthetic calls only. Credentials remain in memory; production config untouched.
import { readFileSync } from "node:fs";
import { loadAgentConfig } from "../src/agent-config.ts";
import { AuthStorage, ModelRegistry } from "@liyuan/agent-runtime";
import { streamSimple } from "@liyuan/ai/compat";
const testConfigDir = process.env.LIYUAN_RESEARCH_TEST_CONFIG_DIR;
if (!testConfigDir || !process.argv.includes("--allow-model-calls"))
  throw new Error(
    "Set explicit test model configuration and --allow-model-calls (may incur API costs)",
  );
const cfg = loadAgentConfig(testConfigDir).config;
const stage = JSON.parse(
  readFileSync(testConfigDir + "/liyuan.config.json", "utf8"),
);
const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
for (const [name, p] of Object.entries(cfg.providers)) {
  if (typeof p.apiKey === "string" && p.apiKey.trim().startsWith("!"))
    throw new Error(
      "Command-based credential resolution is not enabled by this test runner",
    );
  registry.registerProvider(name, {
    ...p,
    models: p.models?.map((m) => ({
      name: m.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 12000,
      ...m,
      compat: {
        ...((p.compat as object) ?? {}),
        ...((m.compat as object) ?? {}),
      },
    })),
  } as never);
}
export const modelFor = (step: string) => {
  const ref = stage.stepModels?.[step] ?? {
    provider: cfg.defaultProvider,
    id: cfg.defaultModel,
  };
  const model = registry.find(ref.provider, ref.id);
  if (!model) throw new Error("configured test role unavailable");
  return model;
};
export async function realStream(model: any, context: any, options: any = {}) {
  const auth = await registry.getApiKeyAndHeaders(model);
  return streamSimple(model, context, {
    ...auth,
    maxTokens: 2048,
    reasoning: "off",
    maxRetries: 0,
    timeoutMs: 180000,
    ...options,
  });
}
export const stream = streamSimple;
export const authFor = (model: any) => registry.getApiKeyAndHeaders(model);

export const sideRefs = stage.stepModels ?? {};
export const findTestModel = (provider: string, id: string) =>
  registry.find(provider, id);

/** Known credentials never enter diagnostic output, including echoed provider errors. */
export function redactEvaluation<T>(value: T): T {
  const secrets = Object.values(cfg.providers)
    .flatMap((provider) => [
      provider.apiKey,
      ...Object.values((provider.headers as Record<string, unknown>) ?? {}),
    ])
    .filter((v): v is string => typeof v === "string" && v.length >= 8);
  return JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (
        (item && typeof item === "object" && item.type === "thinking") ||
        key === "thinking"
      )
        return undefined;
      if (
        /^(apiKey|authorization|accessToken|refreshToken|password|secret)$/i.test(
          key,
        )
      )
        return "[redacted]";
      if (typeof item === "string")
        for (const secret of secrets)
          item = item.split(secret).join("[redacted]");
      return item;
    }),
  );
}
