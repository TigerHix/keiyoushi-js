#!/usr/bin/env bun
/**
 * Post-process built extension manifests - adds author attribution.
 * 
 * Usage:
 *   bun scripts/postprocess-manifests.ts en/mangapill
 *   bun scripts/postprocess-manifests.ts --all
 * 
 * Environment:
 *   TACHIYOMI_OUTPUT - path to built extensions (default: dist/extensions)
 *   EXTENSIONS_SOURCE - path to extensions source for git log
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const SCRIPTS_DIR = import.meta.dirname;
const ROOT_DIR = path.join(SCRIPTS_DIR, "..");

const EXTENSIONS_DIR = process.env.TACHIYOMI_OUTPUT 
  ?? path.join(ROOT_DIR, "dist/extensions");

const EXTENSIONS_SOURCE = process.env.EXTENSIONS_SOURCE 
  ?? path.join(ROOT_DIR, "extensions-source");

const HISTORICAL_COMMITS_PATH = path.join(ROOT_DIR, "data/historical-commits.json");
const KEIYOUSHI_CUTOFF = "2024-01-09";

// Types
interface ContributorData {
  email: string;
  name: string;
  commits: number;
  firstCommit: string;
}

interface AuthorOutput {
  github: string | null;
  name: string;
  commits: number;
  firstCommit: string;
}

// Cache historical commits data
let historicalCommitsCache: { extensions: Record<string, ContributorData[]> } | null = null;

function loadHistoricalCommits(): { extensions: Record<string, ContributorData[]> } {
  if (historicalCommitsCache) return historicalCommitsCache;
  
  const data = fs.existsSync(HISTORICAL_COMMITS_PATH)
    ? JSON.parse(fs.readFileSync(HISTORICAL_COMMITS_PATH, "utf-8"))
    : { extensions: {} };
  
  historicalCommitsCache = data;
  return data;
}

function extractGithubFromNoreply(email: string): string | null {
  const match = email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/);
  return match ? match[1] : null;
}

function getKeiyoushiCommits(extensionPath: string): ContributorData[] {
  const fullPath = `src/${extensionPath}`;
  const srcPath = path.join(EXTENSIONS_SOURCE, fullPath);
  
  if (!fs.existsSync(srcPath)) {
    return [];
  }

  try {
    const output = execSync(
      `git log --format="%ae|%an|%aI" --after="${KEIYOUSHI_CUTOFF}" -- "${fullPath}"`,
      { cwd: EXTENSIONS_SOURCE, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    const commits = output.trim().split("\n").filter(Boolean);
    const byEmail = new Map<string, { name: string; commits: number; firstCommit: string }>();

    for (const line of commits.reverse()) {
      const [email, name, date] = line.split("|");
      if (!email || !name || !date) continue;

      const dateOnly = date.split("T")[0];
      const existing = byEmail.get(email);
      
      if (existing) {
        existing.commits++;
        if (dateOnly < existing.firstCommit) {
          existing.firstCommit = dateOnly;
        }
      } else {
        byEmail.set(email, { name, commits: 1, firstCommit: dateOnly });
      }
    }

    return Array.from(byEmail.entries())
      .map(([email, data]) => ({ email, ...data }));
  } catch {
    return [];
  }
}

function getAuthors(extensionPath: string): AuthorOutput[] {
  const historicalData = loadHistoricalCommits();
  const historical = historicalData.extensions[extensionPath] ?? [];
  const keiyoushi = getKeiyoushiCommits(extensionPath);

  // Merge by email
  const byEmail = new Map<string, ContributorData>();

  for (const c of historical) {
    byEmail.set(c.email, { ...c });
  }

  for (const c of keiyoushi) {
    const existing = byEmail.get(c.email);
    if (existing) {
      existing.commits += c.commits;
      if (c.firstCommit < existing.firstCommit) {
        existing.firstCommit = c.firstCommit;
      }
    } else {
      byEmail.set(c.email, { ...c });
    }
  }

  // Dedupe by GitHub username or email
  const byIdentity = new Map<string, AuthorOutput>();

  for (const c of byEmail.values()) {
    const github = extractGithubFromNoreply(c.email);
    const key = github?.toLowerCase() ?? c.email.toLowerCase();

    const existing = byIdentity.get(key);
    if (existing) {
      existing.commits += c.commits;
      if (c.firstCommit < existing.firstCommit) {
        existing.firstCommit = c.firstCommit;
        existing.name = c.name;
      }
      if (github && !existing.github) {
        existing.github = github;
      }
    } else {
      byIdentity.set(key, {
        github,
        name: c.name,
        commits: c.commits,
        firstCommit: c.firstCommit,
      });
    }
  }

  return Array.from(byIdentity.values())
    .sort((a, b) => a.firstCommit.localeCompare(b.firstCommit));
}

function processManifest(extDir: string, extensionPath: string): boolean {
  const manifestPath = path.join(extDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    return false;
  }
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  
  const authors = getAuthors(extensionPath);
  manifest.authors = authors;
  
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`✓ ${extensionPath} (${authors.length} authors)`);
  
  return true;
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error("Usage: bun scripts/postprocess-manifests.ts <lang/name> | --all");
    process.exit(1);
  }
  
  if (args[0] === "--all") {
    if (!fs.existsSync(EXTENSIONS_DIR)) {
      console.error(`Extensions directory not found: ${EXTENSIONS_DIR}`);
      process.exit(1);
    }
    
    // Extensions are in lang/name/ structure (e.g., all/ahottie/, en/mangapill/)
    const extensions: Array<{ dir: string; path: string }> = [];
    for (const lang of fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
      if (!lang.isDirectory()) continue;
      const langDir = path.join(EXTENSIONS_DIR, lang.name);
      for (const name of fs.readdirSync(langDir, { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        extensions.push({
          dir: path.join(langDir, name.name),
          path: `${lang.name}/${name.name}`,
        });
      }
    }
    
    console.log(`Post-processing ${extensions.length} manifests...\n`);
    let success = 0;
    
    for (const ext of extensions) {
      if (processManifest(ext.dir, ext.path)) {
        success++;
      }
    }
    
    console.log(`\nDone: ${success}/${extensions.length}`);
  } else {
    const extensionPath = args[0]; // e.g., "en/mangapill"
    const extDir = path.join(EXTENSIONS_DIR, extensionPath);
    
    if (!fs.existsSync(extDir)) {
      console.error(`Extension not found: ${extDir}`);
      process.exit(1);
    }
    
    processManifest(extDir, extensionPath);
  }
}

main();

