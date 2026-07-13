#!/usr/bin/env node

const { spawnSync } = require("child_process");

const REQUIRED_CHECKS = ["pr-policy", "pr-evidence", "source-validation", "artifact-preview"];
const GITHUB_ACTIONS_APP_ID = 15368;
const BOT_BRANCH = "automation/canonical-repo-state";

function parseArgs(argv) {
  const options = { pollSeconds: 10, maxAttempts: 180 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--repo", "--pr", "--head", "--poll-seconds", "--max-attempts"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      const key = argument.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
      options[key] = ["pollSeconds", "maxAttempts"].includes(key) ? Number(value) : value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!/^[^/]+\/[^/]+$/u.test(String(options.repo || ""))) throw new Error("--repo must be owner/name.");
  if (!/^\d+$/u.test(String(options.pr || ""))) throw new Error("--pr must be a positive integer.");
  if (!/^[0-9a-f]{40}$/u.test(String(options.head || ""))) throw new Error("--head must be a full SHA-1.");
  if (!Number.isInteger(options.pollSeconds) || options.pollSeconds <= 0) throw new Error("--poll-seconds must be positive.");
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0) throw new Error("--max-attempts must be positive.");
  return options;
}

function runGh(args, options = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: options.input,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh ${args.join(" ")} failed.`);
  return result.stdout.trim();
}

function latestRequiredChecks(checkRuns) {
  const result = new Map();
  for (const run of checkRuns || []) {
    if (Number(run?.app?.id) !== GITHUB_ACTIONS_APP_ID || !REQUIRED_CHECKS.includes(String(run?.name || ""))) {
      continue;
    }
    const prior = result.get(run.name);
    const currentKey = run.completed_at || run.started_at || run.created_at || "";
    const priorKey = prior?.completed_at || prior?.started_at || prior?.created_at || "";
    if (!prior || currentKey > priorKey || (currentKey === priorKey && Number(run.id) > Number(prior.id))) {
      result.set(run.name, run);
    }
  }
  return result;
}

function summarizeChecks(checkRuns) {
  const latest = latestRequiredChecks(checkRuns);
  return REQUIRED_CHECKS.map((name) => {
    const run = latest.get(name);
    if (!run) return { name, state: "pending", conclusion: "missing" };
    if (String(run.status).toLowerCase() !== "completed") return { name, state: "pending", conclusion: "in_progress" };
    const conclusion = String(run.conclusion || "").toLowerCase();
    return { name, state: conclusion === "success" ? "success" : "failed", conclusion };
  });
}

function validatePullRequest(pr, options, expectedBaseSha) {
  if (
    Number(pr?.number) !== Number(options.pr) ||
    pr?.state !== "open" ||
    pr?.base?.ref !== "main" ||
    pr?.base?.sha !== expectedBaseSha ||
    pr?.head?.ref !== BOT_BRANCH ||
    pr?.head?.repo?.full_name !== options.repo ||
    pr?.head?.sha !== options.head ||
    pr?.auto_merge
  ) {
    throw new Error("Canonical-sync PR identity, head, base, state, or merge mode changed.");
  }
  return true;
}

function validateProtectedMain(branch) {
  if (branch?.name !== "main" || branch?.protected !== true) {
    throw new Error("Canonical-sync merge requires GitHub to report main as protected.");
  }
  return true;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForChecks(options, dependencies = {}) {
  const load = dependencies.loadCheckRuns || (() => {
    const payload = JSON.parse(runGh([
      "api",
      `repos/${options.repo}/commits/${options.head}/check-runs?per_page=100`,
    ]) || "{}");
    return payload.check_runs || [];
  });
  const pause = dependencies.wait || wait;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const summaries = summarizeChecks(load());
    process.stdout.write(`[canonical-sync] ${summaries.map((item) => `${item.name}:${item.conclusion}`).join(" ")}\n`);
    const failed = summaries.filter((item) => item.state === "failed");
    if (failed.length) throw new Error(`Canonical-sync required checks failed: ${failed.map((item) => item.name).join(", ")}`);
    if (summaries.every((item) => item.state === "success")) return summaries;
    await pause(options.pollSeconds * 1000);
  }
  throw new Error("Timed out waiting for canonical-sync required checks.");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const initialBranch = JSON.parse(runGh(["api", `repos/${options.repo}/branches/main`]));
  validateProtectedMain(initialBranch);
  const initialBaseSha = String(initialBranch?.commit?.sha || "");
  if (!/^[0-9a-f]{40}$/u.test(initialBaseSha)) throw new Error("Protected main did not expose a full base SHA.");
  const initialPr = JSON.parse(runGh(["api", `repos/${options.repo}/pulls/${options.pr}`]));
  validatePullRequest(initialPr, options, initialBaseSha);
  await waitForChecks(options);
  const pr = JSON.parse(runGh(["api", `repos/${options.repo}/pulls/${options.pr}`]));
  const finalBranch = JSON.parse(runGh(["api", `repos/${options.repo}/branches/main`]));
  validateProtectedMain(finalBranch);
  if (finalBranch?.commit?.sha !== initialBaseSha) {
    throw new Error("Protected main changed while canonical-sync checks were running.");
  }
  validatePullRequest(pr, options, initialBaseSha);
  const payload = JSON.stringify({
    merge_method: "squash",
    sha: options.head,
    commit_title: "chore: synchronize canonical repository state",
    commit_message: "Generated artifacts reproduced and merged through protected required checks.",
  });
  const merged = JSON.parse(runGh(
    ["api", `repos/${options.repo}/pulls/${options.pr}/merge`, "-X", "PUT", "--input", "-"],
    { input: payload },
  ));
  if (merged?.merged !== true) throw new Error(`Canonical-sync merge failed: ${merged?.message || "merged=false"}`);

  for (const workflow of ["ci.yml", "pages.yml", "codeql.yml"]) {
    runGh([
      "api",
      `repos/${options.repo}/actions/workflows/${workflow}/dispatches`,
      "-X",
      "POST",
      "-f",
      "ref=main",
    ]);
  }
  process.stdout.write(`[canonical-sync] merged PR #${options.pr} at ${options.head} and dispatched main verification.\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  latestRequiredChecks,
  parseArgs,
  summarizeChecks,
  validateProtectedMain,
  validatePullRequest,
  waitForChecks,
};
