const assert = require("assert");

const canonicalMerge = require("../merge_canonical_sync_pr.cjs");

const HEAD = "a".repeat(40);
const options = canonicalMerge.parseArgs(["--repo", "owner/repo", "--pr", "42", "--head", HEAD]);
assert.strictEqual(options.pollSeconds, 10);
assert.throws(() => canonicalMerge.parseArgs(["--repo", "owner/repo", "--pr", "42", "--head", "short"]), /full SHA-1/);

function run(name, conclusion = "success", id = 1, appId = 15368) {
  return {
    id,
    name,
    status: "completed",
    conclusion,
    completed_at: `2026-07-13T20:00:0${id}Z`,
    app: { id: appId },
  };
}

const passing = ["pr-policy", "pr-evidence", "source-validation", "artifact-preview"].map((name, index) => run(name, "success", index + 1));
assert.ok(canonicalMerge.summarizeChecks(passing).every((item) => item.state === "success"));
assert.strictEqual(canonicalMerge.summarizeChecks([...passing, run("pr-policy", "success", 9, 999)])[0].state, "success");
assert.strictEqual(canonicalMerge.summarizeChecks(passing.filter((item) => item.name !== "pr-evidence"))[1].state, "pending");
assert.strictEqual(canonicalMerge.summarizeChecks([...passing, run("artifact-preview", "failure", 9)])[3].state, "failed");

assert.strictEqual(canonicalMerge.validatePullRequest({
  number: 42,
  state: "open",
  base: { ref: "main", sha: "b".repeat(40) },
  head: { ref: "automation/canonical-repo-state", sha: HEAD, repo: { full_name: "owner/repo" } },
  auto_merge: null,
}, options, "b".repeat(40)), true);
assert.strictEqual(canonicalMerge.validateProtectedMain({ name: "main", protected: true }), true);
assert.throws(() => canonicalMerge.validateProtectedMain({ name: "main", protected: false }), /main as protected/);
assert.throws(() => canonicalMerge.validatePullRequest({
  number: 42,
  state: "open",
  base: { ref: "main", sha: "b".repeat(40) },
  head: { ref: "other", sha: HEAD, repo: { full_name: "owner/repo" } },
}, options, "b".repeat(40)), /identity/);

(async () => {
  let calls = 0;
  await canonicalMerge.waitForChecks({ ...options, pollSeconds: 1, maxAttempts: 2 }, {
    loadCheckRuns() {
      calls += 1;
      return calls === 1 ? passing.slice(0, 3) : passing;
    },
    wait: async () => {},
  });
  assert.strictEqual(calls, 2);
  console.log("Canonical sync merge tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
