import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: readonly string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscovery {
  agents: readonly AgentDefinition[];
  projectDirectory?: string;
}

export async function discoverAgents(cwd: string, scope: AgentScope): Promise<AgentDiscovery> {
  const projectDirectory = await findNearestProjectDirectory(cwd);
  const user = scope === "project" ? [] : await loadDirectory(join(getAgentDir(), "agents"), "user");
  const project = scope === "user" || !projectDirectory ? [] : await loadDirectory(projectDirectory, "project");
  const merged = new Map<string, AgentDefinition>();
  for (const agent of user) merged.set(agent.name, agent);
  for (const agent of project) merged.set(agent.name, agent);
  return { agents: [...merged.values()], ...(projectDirectory ? { projectDirectory } : {}) };
}

async function loadDirectory(directory: string, source: "user" | "project"): Promise<AgentDefinition[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const agents: AgentDefinition[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    const filePath = join(directory, name);
    const content = await readFile(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;
    const tools = frontmatter.tools?.split(",").map((tool) => tool.trim()).filter(Boolean);
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      systemPrompt: body,
      source,
      filePath,
      ...(tools?.length ? { tools } : {}),
      ...(frontmatter.model ? { model: frontmatter.model } : {}),
    });
  }
  return agents;
}

async function findNearestProjectDirectory(cwd: string): Promise<string | undefined> {
  let current = cwd;
  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME, "agents");
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
