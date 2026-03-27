#!/usr/bin/env -S deno run --allow-all --unstable-net

/**
 * DimSim CLI — 3D simulation, eval runner, dev server, and scene manager.
 *
 * Usage:
 *   dimsim setup                                            Download core assets
 *   dimsim scene install <name>                             Download a scene
 *   dimsim scene list                                       List scenes
 *   dimsim scene remove <name>                              Remove a scene
 *   dimsim dev   [--scene <name>] [--port <n>]              Dev server + browser
 *   dimsim eval  [--headless] [--parallel N] [--render gpu] Headless CI evals
 *   dimsim agent [--nav-only]                               dimos Python agent
 */

import { resolve, dirname, fromFileUrl } from "@std/path";
import { startBridgeServer } from "./bridge/server.ts";
import { launchHeadless, launchMultiPage, type RenderMode } from "./headless/launcher.ts";
import { runEvals, runEvalsMultiPage, collectWorkflows, toJunitXml, type EvalResult } from "./eval/runner.ts";
import { getDimsimHome, getDistDir, setup, sceneInstall, sceneList, sceneRemove } from "./setup.ts";
import { loadSceneIndex, findObject, suggestObjects } from "./eval/scene-index.ts";
import { buildEval } from "./eval/builder.ts";

// When installed from JSR, import.meta.url is https:// — local paths don't exist.
const IS_REMOTE = !import.meta.url.startsWith("file:");

const CLI_DIR = IS_REMOTE ? null : dirname(fromFileUrl(import.meta.url));
const PROJECT_DIR = CLI_DIR ? resolve(CLI_DIR, "..") : null;
const LOCAL_DIST_DIR = PROJECT_DIR ? resolve(PROJECT_DIR, "dist") : null;
const EVALS_DIR = PROJECT_DIR ? resolve(PROJECT_DIR, "evals") : `${getDimsimHome()}/evals`;
const DIMOS_VENV = PROJECT_DIR ? resolve(PROJECT_DIR, "../dimos/.venv/bin/python") : null;
const AGENT_PY = CLI_DIR ? resolve(CLI_DIR, "agent.py") : null;

/** Resolve distDir: use local dist/ if it exists (dev), else ~/.dimsim/dist/ (installed). */
async function resolveDistDir(): Promise<string> {
  // Check local dist/ (only in dev mode, running from source)
  if (LOCAL_DIST_DIR) {
    try {
      await Deno.stat(`${LOCAL_DIST_DIR}/index.html`);
      return LOCAL_DIST_DIR;
    } catch { /* not found */ }
  }

  const installed = getDistDir();
  try {
    await Deno.stat(`${installed}/index.html`);
    return installed;
  } catch { /* not found */ }

  console.error(`[dimsim] No dist/ found.`);
  console.error(`[dimsim] Run 'dimsim setup' to download core assets.`);
  if (!IS_REMOTE) {
    console.error(`[dimsim] Or build locally with 'npm run build'.`);
  }
  Deno.exit(1);
}

function printUsage() {
  console.log(`
DimSim CLI — 3D simulation + eval harness for dimos

Commands:
  dimsim setup                   Download core assets (~40MB)
  dimsim scene install <name>    Download a scene
  dimsim scene list              List available + installed scenes
  dimsim scene remove <name>     Remove a local scene
  dimsim dev   [options]         Dev server (open browser, optional eval)
  dimsim eval  [options]         Run eval workflows (headless CI)
  dimsim list objects [options]   List scene objects (eval targets)
  dimsim build eval [options]    Generate eval from validated target
  dimsim agent [options]         Launch dimos Python agent

Setup:
  --local <path>                 Use local archive instead of downloading

Dev:
  --scene <name>                 Scene to load (default: hotel-lobby)
  --port <n>                     Server port (default: 8090)
  --headless                     Launch headless browser (no GUI)
  --render gpu|cpu               Render mode for headless (default: gpu)
  --channels <n>                 Number of parallel browser pages (multi-instance)
  --eval <workflow>              Run eval after browser connects
  --env <name>                   Environment filter

Eval:
  --connect                      Connect to existing bridge (use with dimos)
  --headless                     Headless Chromium (required for CI)
  --parallel <n>                 N parallel browser pages (default: 1)
  --render gpu|cpu               gpu = Metal/ANGLE, cpu = SwiftShader (default: cpu)
  --env <name>                   Filter to environment
  --workflow <name>              Filter to workflow
  --output json|junit            Output format (default: json)
  --port <n>                     Bridge port (default: 8090)
  --timeout <ms>                 Engine init timeout (default: auto)

List Objects:
  --scene <name>                   Scene to inspect (required)
  --search <term>                  Filter objects by name

Build Eval:
  --scene <name>                   Scene name (required)
  --target <object>                Target object name (required, validated)
  --threshold <m>                  Distance threshold (default: 2.0)
  --timeout <s>                    Timeout in seconds (default: 60)
  --task <prompt>                  Agent prompt (default: auto from target)
  --name <id>                      Eval name (default: slugified target)
  --env <name>                     Manifest environment (default: scene name)

Agent:
  --nav-only                     Nav stack only (no LLM agent)
  --venv <path>                  Python venv path (default: ../dimos/.venv/bin/python)

Environment:
  DIMSIM_HOME                    Override data dir (default: ~/.dimsim)
`);
}

function parseArgs(args: string[]) {
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

async function main() {
  const subcommand = Deno.args[0];
  const opts = parseArgs(Deno.args.slice(1));

  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    Deno.exit(0);
  }

  if (subcommand === "--version" || subcommand === "version") {
    // deno.json is importable as JSON both locally and from JSR cache
    const metaUrl = new URL("./deno.json", import.meta.url);
    try {
      const resp = await fetch(metaUrl);
      const meta = await resp.json();
      console.log(meta.version);
    } catch {
      console.log("unknown");
    }
    Deno.exit(0);
  }

  const port = parseInt(opts.port as string) || 8090;

  // ── Setup ───────────────────────────────────────────────────────────
  if (subcommand === "setup") {
    const local = opts.local;
    if (local === true) {
      console.error("[dimsim] --local requires a path: dimsim setup --local ./dimsim-core-v0.1.0.tar.gz");
      Deno.exit(1);
    }
    await setup(local as string | undefined);
    Deno.exit(0);
  }

  // ── Scene management ────────────────────────────────────────────────
  if (subcommand === "scene") {
    const action = Deno.args[1];
    const name = Deno.args[2];
    const sceneOpts = parseArgs(Deno.args.slice(2));

    if (action === "install" && name) {
      const local = sceneOpts.local;
      if (local === true) {
        console.error("[dimsim] --local requires a path: dimsim scene install apt --local ./scene-apt-v0.1.0.tar.gz");
        Deno.exit(1);
      }
      await sceneInstall(name, local as string | undefined);
    } else if (action === "list") {
      await sceneList();
    } else if (action === "remove" && name) {
      await sceneRemove(name);
    } else {
      console.log("Usage:");
      console.log("  dimsim scene install <name> [--local <path>]");
      console.log("  dimsim scene list");
      console.log("  dimsim scene remove <name>");
    }
    Deno.exit(0);
  }

  // ── List objects ────────────────────────────────────────────────────
  if (subcommand === "list") {
    const what = Deno.args[1];
    if (what === "objects") {
      const listOpts = parseArgs(Deno.args.slice(2));
      const sceneName = listOpts.scene as string;
      if (!sceneName) {
        console.error("[dimsim] --scene is required. Example: dimsim list objects --scene apt");
        Deno.exit(1);
      }

      const distDir = await resolveDistDir();
      const scenePath = `${distDir}/sims/${sceneName}.json`;
      try {
        await Deno.stat(scenePath);
      } catch {
        console.error(`[dimsim] Scene "${sceneName}" not found at ${scenePath}`);
        console.error(`[dimsim] Run 'dimsim scene install ${sceneName}' first.`);
        Deno.exit(1);
      }

      const index = loadSceneIndex(scenePath, sceneName);
      const search = listOpts.search as string | undefined;

      let filtered = index.objects;
      if (search) {
        const lower = search.toLowerCase();
        filtered = index.objects.filter(
          (o) => o.title.toLowerCase().includes(lower) || o.id.toLowerCase().includes(lower),
        );
        console.log(`\nObjects matching "${search}" in scene "${sceneName}" (${filtered.length}):\n`);
      } else {
        console.log(`\nObjects in scene "${sceneName}" (${filtered.length} titled assets):\n`);
      }

      if (filtered.length === 0) {
        console.log("  (none)");
      } else {
        const maxTitle = Math.min(45, Math.max(...filtered.map((o) => o.title.length)));
        for (const obj of filtered) {
          const t = obj.title.padEnd(maxTitle);
          console.log(`  ${t}  (${obj.position.x}, ${obj.position.y}, ${obj.position.z})`);
        }
      }
      console.log();
      Deno.exit(0);
    }
    console.log("Usage: dimsim list objects --scene <name> [--search <term>]");
    Deno.exit(1);
  }

  // ── Build eval ─────────────────────────────────────────────────────
  if (subcommand === "build") {
    const what = Deno.args[1];
    if (what === "eval") {
      const buildOpts = parseArgs(Deno.args.slice(2));
      const sceneName = buildOpts.scene as string;
      const target = buildOpts.target as string;

      if (!sceneName || !target) {
        console.error("[dimsim] --scene and --target are required.");
        console.error("Example: dimsim build eval --scene apt --target television");
        Deno.exit(1);
      }

      const distDir = await resolveDistDir();
      const scenePath = `${distDir}/sims/${sceneName}.json`;
      try {
        await Deno.stat(scenePath);
      } catch {
        console.error(`[dimsim] Scene "${sceneName}" not found at ${scenePath}`);
        console.error(`[dimsim] Run 'dimsim scene install ${sceneName}' first.`);
        Deno.exit(1);
      }

      try {
        const result = buildEval({
          scenePath,
          sceneName,
          target,
          threshold: buildOpts.threshold ? parseFloat(buildOpts.threshold as string) : undefined,
          timeout: buildOpts.timeout ? parseInt(buildOpts.timeout as string) : undefined,
          task: buildOpts.task as string | undefined,
          name: buildOpts.name as string | undefined,
          env: buildOpts.env as string | undefined,
          evalsDir: EVALS_DIR,
        });

        console.log(`\nCreated eval: ${result.filePath}`);
        console.log(`  Task:      "${result.task}"`);
        console.log(`  Target:    ${result.targetTitle} (${result.targetPosition.x}, ${result.targetPosition.y}, ${result.targetPosition.z})`);
        console.log(`  Threshold: ${result.threshold}m`);
        console.log(`  Timeout:   ${result.timeout}s`);
        console.log(`\nRun: dimsim eval --connect --env ${result.env} --workflow ${result.workflowName}\n`);
      } catch (err: any) {
        console.error(`[dimsim] ${err.message}`);
        Deno.exit(1);
      }
      Deno.exit(0);
    }
    console.log("Usage: dimsim build eval --scene <name> --target <object> [options]");
    Deno.exit(1);
  }

  // ── Dev ─────────────────────────────────────────────────────────────
  if (subcommand === "dev") {
    const distDir = await resolveDistDir();
    const scene = (opts.scene as string) || "hotel-lobby";
    const headless = opts.headless === true;
    const render = ((opts.render as string) === "cpu" ? "cpu" : "gpu") as RenderMode;
    const numChannels = Math.max(1, parseInt(opts.channels as string) || 1);
    const evalWorkflow = opts.eval as string | undefined;

    // Build channel list for multi-instance mode
    const channels = numChannels > 1
      ? Array.from({ length: numChannels }, (_, i) => `page-${i}`)
      : undefined;

    console.log(`[dimsim] Dev mode — scene: ${scene}, port: ${port}${headless ? " (headless)" : ""}${channels ? ` (${numChannels} channels)` : ""}`);
    console.log(`[dimsim] Serving from: ${distDir}`);

    // LCM bridge is always active in dev mode (unlike eval --headless which disables it)
    startBridgeServer({ port, distDir, scene, headless, channels });

    if (headless) {
      if (channels) {
        // Multi-page mode: open N browser pages in one Chromium instance
        console.log(`[dimsim] Launching headless browser with ${numChannels} pages...`);
        const url = `http://localhost:${port}`;
        await launchMultiPage({ url, numPages: numChannels, render, timeout: 120_000 });
        await new Promise((r) => setTimeout(r, 3000));
        console.log(`[dimsim] ${numChannels} headless pages ready. LCM bridge active.`);
      } else {
        console.log("[dimsim] Launching headless browser...");
        const url = `http://localhost:${port}`;
        await launchHeadless({ url, timeout: 30000, render });
        await new Promise((r) => setTimeout(r, 3000));
        console.log("[dimsim] Headless browser ready. LCM bridge active.");
      }
    } else {
      console.log(`[dimsim] Open http://localhost:${port} in your browser`);
    }

    if (evalWorkflow) {
      console.log(`[dimsim] Eval workflow: ${evalWorkflow}`);
      console.log("[dimsim] Waiting for browser to connect and load scene...\n");

      const wsUrl = `ws://localhost:${port}`;
      const manifestPath = resolve(EVALS_DIR, "manifest.json");

      const results = await runEvals({
        wsUrl,
        manifestPath,
        filterEnv: opts.env as string,
        filterWorkflow: evalWorkflow,
        outputFormat: "json",
      });

      const passed = results.filter((r) => r.pass).length;
      const failed = results.length - passed;
      console.log(`\n[dimsim] Eval done: ${passed} passed, ${failed} failed`);

      // Stay alive in dev mode (don't exit like headless eval does)
      console.log("[dimsim] Eval complete. Server still running. Press Ctrl+C to stop.");
    } else {
      console.log("[dimsim] Press Ctrl+C to stop.");
    }

    // Keep alive
    await new Promise(() => {});
  }

  // ── Agent ───────────────────────────────────────────────────────────
  if (subcommand === "agent") {
    if (IS_REMOTE && !opts.venv) {
      console.error(`[dimsim] Agent mode requires a local dimos install.`);
      console.error(`[dimsim] Pass --venv /path/to/python`);
      Deno.exit(1);
    }
    const pythonBin = (opts.venv as string) || DIMOS_VENV!;
    const navOnly = opts["nav-only"] === true;

    if (IS_REMOTE && !AGENT_PY) {
      console.error(`[dimsim] Agent mode is only available when running from source.`);
      Deno.exit(1);
    }

    // Verify python exists
    try {
      await Deno.stat(pythonBin);
    } catch {
      console.error(`[dimsim] dimos venv not found at: ${pythonBin}`);
      console.error(`[dimsim] Install dimos first, or pass --venv /path/to/python`);
      Deno.exit(1);
    }

    const cmd = [pythonBin, AGENT_PY!];
    if (navOnly) cmd.push("--nav-only");

    console.log(`[dimsim] Starting dimos agent${navOnly ? " (nav-only)" : ""}...`);
    console.log(`[dimsim] Python: ${pythonBin}`);

    const proc = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...Deno.env.toObject() },
    }).spawn();

    const status = await proc.status;
    Deno.exit(status.code);
  }

  // ── Eval ────────────────────────────────────────────────────────────
  if (subcommand === "eval") {
    const connectMode = opts.connect === true;
    const outputFormat = (opts.output as string) === "junit" ? "junit" : "json";
    const manifestPath = resolve(EVALS_DIR, "manifest.json");

    // --connect mode: just run the eval runner against an existing bridge
    if (connectMode) {
      const wsUrl = `ws://localhost:${port}`;
      console.log(`[dimsim] Connecting to existing bridge at ${wsUrl}...`);

      const results = await runEvals({
        wsUrl,
        manifestPath,
        filterEnv: opts.env as string,
        filterWorkflow: opts.workflow as string,
        outputFormat: outputFormat as "json" | "junit",
      });

      const passed = results.filter((r) => r.pass).length;
      const failed = results.length - passed;
      console.log(`\n[dimsim] Done: ${passed} passed, ${failed} failed, ${results.length} total`);
      Deno.exit(failed > 0 ? 1 : 0);
    }

    const distDir = await resolveDistDir();
    const headless = opts.headless === true;
    const scene = (opts.scene as string) || (opts.env as string) || "hotel-lobby";
    const parallel = Math.max(1, parseInt(opts.parallel as string) || 1);
    const render = ((opts.render as string) === "gpu" ? "gpu" : "cpu") as RenderMode;
    const defaultTimeout = render === "cpu" ? 120000 : 30000;
    const timeout = parseInt(opts.timeout as string) || defaultTimeout;

    if (headless && parallel > 1) {
      const allWorkflows = collectWorkflows(
        manifestPath,
        opts.env as string,
        opts.workflow as string,
      );

      if (allWorkflows.length === 0) {
        console.log("[dimsim] No workflows match filter criteria.");
        Deno.exit(0);
      }

      const numPages = Math.min(parallel, allWorkflows.length);
      console.log(`[dimsim] Multi-page eval — ${allWorkflows.length} workflows across ${numPages} page(s)`);

      startBridgeServer({ port, distDir, scene, evalOnly: true });
      await new Promise((r) => setTimeout(r, 500));

      const url = `http://localhost:${port}`;
      const instance = await launchMultiPage({ url, numPages, timeout, render });
      await new Promise((r) => setTimeout(r, 2000));

      const allResults = await runEvalsMultiPage({
        wsUrl: `ws://localhost:${port}`,
        manifestPath,
        channels: instance.channels,
        filterEnv: opts.env as string,
        filterWorkflow: opts.workflow as string,
      });

      await instance.close();

      if (outputFormat === "junit") {
        console.log(toJunitXml(allResults));
      } else {
        console.log(JSON.stringify(allResults, null, 2));
      }

      const passed = allResults.filter((r) => r.pass).length;
      const failed = allResults.length - passed;
      console.log(`\n[dimsim] Done: ${passed} passed, ${failed} failed, ${allResults.length} total`);
      Deno.exit(failed > 0 ? 1 : 0);
    }

    // -- Single worker eval (sequential) -----------------------------------
    console.log(`[dimsim] Eval mode — headless: ${headless}, port: ${port}`);

    startBridgeServer({ port, distDir, scene, evalOnly: headless });
    await new Promise((r) => setTimeout(r, 500));

    const url = `http://localhost:${port}`;

    if (headless) {
      console.log("[dimsim] Launching headless browser...");
      const instance = await launchHeadless({ url, timeout, render });
      await new Promise((r) => setTimeout(r, 3000));

      const results = await runEvals({
        wsUrl: `ws://localhost:${port}`,
        manifestPath,
        filterEnv: opts.env as string,
        filterWorkflow: opts.workflow as string,
        outputFormat: outputFormat as "json" | "junit",
      });

      await instance.close();

      const failed = results.filter((r) => !r.pass).length;
      Deno.exit(failed > 0 ? 1 : 0);
    } else {
      console.log(`[dimsim] Open ${url} in your browser to start evals`);
      console.log("[dimsim] Press Ctrl+C to stop.");
      await new Promise(() => {});
    }
  }

  printUsage();
  Deno.exit(1);
}

main();
