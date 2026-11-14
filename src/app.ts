/**
 * Single-mission composition root: registry, one mission store, memory and the request
 * pipeline. Used by the stdio MCP server and the pipeline tests; the multi-session
 * platform (accounts, sessions, collaboration, game) is assembled in platform/platform.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetCapabilities } from "./capabilities/assets.js";
import { codeCapabilities } from "./capabilities/code.js";
import { dataCapabilities } from "./capabilities/data.js";
import { text3dCapabilities } from "./capabilities/text3d.js";
import { TerrainService } from "./nasa/terrain.js";
import { missionCapabilities } from "./capabilities/mission.js";
import { nasaCapabilities } from "./capabilities/nasa.js";
import { KnowledgeBase } from "./knowledge/knowledge.js";
import { scienceCapabilities } from "./capabilities/science.js";
import { createLlm, type LlmService } from "./llm/llm.js";
import { McpBridge } from "./mcp/bridge.js";
import { ResearchMemory } from "./memory/memory.js";
import { ProposalService } from "./pipeline/proposals.js";
import { RequestService } from "./pipeline/service.js";
import { CapabilityRegistry } from "./registry/registry.js";
import { loadSeedMission, MissionStore } from "./state/store.js";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Downloaded NASA products (DEMs, map tiles). A cache, not state: safe to delete, shared by all data directories. */
export const cacheDir = (): string => process.env.MISSION_CACHE_DIR ?? path.join(PROJECT_ROOT, ".data", "cache");

export interface AppOptions {
  /** Persistent data directory. Omit for an ephemeral app (tests): state lives in memory and a temp dir. */
  dataDir?: string;
  seedFile?: string;
  llm?: LlmService;
}

export interface App {
  registry: CapabilityRegistry;
  store: MissionStore;
  memory: ResearchMemory;
  llm: LlmService;
  proposals: ProposalService;
  requests: RequestService;
  mcp: McpBridge;
  assetsDir: string;
  close(): Promise<void>;
}

export function createApp(options: AppOptions = {}): App {
  const ephemeral = options.dataDir === undefined;
  const workDir = options.dataDir ?? mkdtempSync(path.join(os.tmpdir(), "mission-ai-"));
  const assetsDir = path.join(workDir, "assets");
  const llm = options.llm ?? createLlm();

  const store = new MissionStore(ephemeral ? null : path.join(workDir, "mission"));
  if (store.isEmpty) {
    store.publish(loadSeedMission(options.seedFile ?? path.join(PROJECT_ROOT, "config", "seed-mission.json")), { by: "system", note: "Initial mission configuration" });
  }
  const memory = new ResearchMemory(ephemeral ? null : path.join(workDir, "memory"));

  const registry = new CapabilityRegistry();
  for (const capability of [
    ...missionCapabilities({ memory }),
    ...scienceCapabilities(),
    ...assetCapabilities(),
    ...codeCapabilities({ llm }),
    ...text3dCapabilities({ llm }),
    ...dataCapabilities({ terrain: new TerrainService(path.join(cacheDir(), "dem")) }),
    ...nasaCapabilities({ knowledge: new KnowledgeBase(memory, null) }),
  ]) {
    registry.register(capability);
  }

  const proposals = new ProposalService(store, assetsDir);
  const requests = new RequestService({ registry, store, memory, llm, proposals, dataDir: ephemeral ? null : workDir, stagingDir: path.join(workDir, "staging") });
  const mcp = new McpBridge(registry);

  return {
    registry,
    store,
    memory,
    llm,
    proposals,
    requests,
    mcp,
    assetsDir,
    async close() {
      await mcp.close();
      if (ephemeral) rmSync(workDir, { recursive: true, force: true });
    },
  };
}
