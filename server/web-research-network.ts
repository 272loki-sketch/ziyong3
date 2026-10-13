/** Operator-owned research transport only. Never inferred from a model/tool/page. */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

export function researchNetworkEnvironment(cwd: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const directory = join(cwd, ".liyuan-research"), file = join(directory, "network.json");
    if (!existsSync(file)) return env;
    const parent = lstatSync(directory), stat = lstatSync(file);
    if (parent.isSymbolicLink() || !parent.isDirectory() || stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096
        || !realpathSync(file).startsWith(realpathSync(cwd) + sep)) throw new Error("研究网络配置来源无效");
    const config: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("研究网络配置无效");
    const row = config as Record<string, unknown>;
    if (row.version !== 1 || !["environment", "direct"].includes(String(row.route)) || Object.keys(row).some(key => key !== "version" && key !== "route"))
        throw new Error("研究网络配置无效");
    return row.route === "direct" ? { ...env, LIYUAN_WEB_RESEARCH_PROXY: "direct" } : env;
}
