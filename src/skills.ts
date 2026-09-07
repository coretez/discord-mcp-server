/**
 * Skill catalog.
 *
 * Skills are versioned operational playbooks delivered through MCP rather than
 * baked into tool descriptions — that is the point of the convention: routing
 * text stays short, and the depth is fetched only when a task needs it.
 *
 * Files live in `skills/` beside the package, not inside `dist/`, and are read
 * at call time so editing a playbook does not require a rebuild.
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Overridable so an operator can point at their own playbook directory. */
const SKILLS_DIR =
  process.env.DISCORD_SKILLS_DIR?.trim() ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

export interface Skill {
  skill_id: string;
  skill_version: string;
  title: string;
  description: string;
  content: string;
}

/** Minimal YAML-ish frontmatter reader: flat `key: value` pairs only. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { meta, body: raw.slice(match[0].length) };
}

export async function listSkills(): Promise<Skill[]> {
  const files = (await readdir(SKILLS_DIR)).filter((f) => f.endsWith(".md")).sort();
  const skills: Skill[] = [];
  for (const file of files) {
    const raw = await readFile(join(SKILLS_DIR, file), "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const id = meta.skill_id ?? file.replace(/\.md$/, "");
    skills.push({
      skill_id: id,
      skill_version: meta.skill_version ?? "0.0.0",
      title: meta.title ?? id,
      description: meta.description ?? "",
      content: body.trim(),
    });
  }
  return skills;
}

export async function loadSkill(skillId: string): Promise<Skill | null> {
  const skills = await listSkills();
  return skills.find((s) => s.skill_id === skillId) ?? null;
}

/** Stable fingerprint of the catalog, so a client can detect drift cheaply. */
export function catalogVersion(skills: Skill[]): string {
  return skills.map((s) => `${s.skill_id}@${s.skill_version}`).join(",");
}
