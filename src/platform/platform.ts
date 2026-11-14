/** Platform composition root: shared services plus the multi-session manager. */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "../app.js";
import { assetCapabilities } from "../capabilities/assets.js";
import { codeCapabilities } from "../capabilities/code.js";
import { dataCapabilities } from "../capabilities/data.js";
import { missionCapabilities } from "../capabilities/mission.js";
import { nasaCapabilities } from "../capabilities/nasa.js";
import { scienceCapabilities } from "../capabilities/science.js";
import { KnowledgeBase } from "../knowledge/knowledge.js";
import { AnthropicLlm, type LlmService } from "../llm/llm.js";
import { McpBridge } from "../mcp/bridge.js";
import { ResearchMemory } from "../memory/memory.js";
import { CapabilityRegistry } from "../registry/registry.js";
import { AuditLog } from "./audit.js";
import { AuthService } from "./auth.js";
import { SessionManager } from "./sessions.js";

export interface PlatformOptions {
  /** Persistent data directory. Omit for an ephemeral platform (tests). */
  dataDir?: string;
  llm?: LlmService;
  /** Directory of reference documents to index for the knowledge base. */
  documentsDir?: string;
}

export interface Platform {
  registry: CapabilityRegistry;
  memory: ResearchMemory;
  knowledge: KnowledgeBase;
  llm: LlmService;
  mcp: McpBridge;
  auth: AuthService;
  audit: AuditLog;
  sessions: SessionManager;
  assetsDir: string;
  documentsDir: string;
  close(): Promise<void>;
}

export function createPlatform(options: PlatformOptions = {}): Platform {
  const ephemeral = options.dataDir === undefined;
  const workDir = options.dataDir ?? mkdtempSync(path.join(os.tmpdir(), "mission-platform-"));
  const assetsDir = path.join(workDir, "assets");
  const documentsDir = options.documentsDir ?? path.join(PROJECT_ROOT, "Data");
  const llm = options.llm ?? new AnthropicLlm();

  const audit = new AuditLog(ephemeral ? null : path.join(workDir, "audit"));
  const auth = new AuthService(ephemeral ? null : path.join(workDir, "auth"));
  const memory = new ResearchMemory(ephemeral ? null : path.join(workDir, "memory"));
  const knowledge = new KnowledgeBase(memory, ephemeral ? null : path.join(workDir, "knowledge"));

  const registry = new CapabilityRegistry();
  for (const capability of [
    ...missionCapabilities({ memory }),
    ...scienceCapabilities(),
    ...assetCapabilities(),
    ...codeCapabilities({ llm }),
    ...dataCapabilities(),
    ...nasaCapabilities({ knowledge }),
  ]) {
    registry.register(capability);
  }

  const sessions = new SessionManager({ registry, memory, llm, audit, assetsDir, dataDir: ephemeral ? null : workDir, scratchDir: path.join(workDir, "staging") });
  const mcp = new McpBridge(registry);

  return {
    registry,
    memory,
    knowledge,
    llm,
    mcp,
    auth,
    audit,
    sessions,
    assetsDir,
    documentsDir,
    async close() {
      await mcp.close();
      if (ephemeral) rmSync(workDir, { recursive: true, force: true });
    },
  };
}
