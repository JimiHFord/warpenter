import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const presetsDir = path.resolve("public", "presets");
const indexPath = path.join(presetsDir, "index.json");

const files = (await fs.readdir(presetsDir))
  .filter((file) => file.endsWith(".json") && file !== "index.json")
  .sort((left, right) => left.localeCompare(right));

const presets = [];
for (const file of files) {
  const fullPath = path.join(presetsDir, file);
  const raw = await fs.readFile(fullPath, "utf8");
  const preset = JSON.parse(raw);
  validatePreset(preset, file);

  const git = await gitMetadata(toGitPath(fullPath));
  const stat = await fs.stat(fullPath);
  const author = authorMetadata(preset, git);

  presets.push({
    id: preset.id,
    name: preset.name,
    path: file,
    description: typeof preset.description === "string" ? preset.description : "",
    modified: git.modified || stat.mtime.toISOString(),
    author: author.name,
    authorUrl: author.url,
  });
}

presets.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

await fs.writeFile(indexPath, `${JSON.stringify({ presets }, null, 2)}\n`);

function validatePreset(preset, file) {
  if (!preset || typeof preset !== "object") {
    throw new Error(`${file} must contain a JSON object.`);
  }
  if (typeof preset.id !== "string" || preset.id.length === 0) {
    throw new Error(`${file} must include a non-empty string id.`);
  }
  if (typeof preset.name !== "string" || preset.name.length === 0) {
    throw new Error(`${file} must include a non-empty string name.`);
  }
  if (!preset.state || typeof preset.state !== "object") {
    throw new Error(`${file} must include a state object.`);
  }
}

async function gitMetadata(gitPath) {
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%aI%x00%an%x00%ae", "--", gitPath]);
    const [modified = "", author = "", email = ""] = stdout.trim().split("\0");
    return { modified, author, email };
  } catch {
    return { modified: "", author: "", email: "" };
  }
}

function authorMetadata(preset, git) {
  const author = preset.author && typeof preset.author === "object" ? preset.author : {};
  const github = typeof author.github === "string" ? author.github.replace(/^@/, "").trim() : "";
  const explicitUrl = typeof author.url === "string" ? author.url.trim() : "";
  return {
    name: typeof author.name === "string" && author.name.trim() ? author.name.trim() : git.author,
    url: github ? `https://github.com/${github}` : explicitUrl,
  };
}

function toGitPath(fullPath) {
  return path.relative(process.cwd(), fullPath).split(path.sep).join("/");
}
