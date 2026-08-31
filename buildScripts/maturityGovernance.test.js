const assert = require("node:assert/strict");
const test = require("node:test");

const {
    evaluateBugHealth,
    hasNewCspException,
    parseGitHubRepository,
    processTool,
} = require("./maturityGovernance");

const NOW = new Date("2026-08-29T00:00:00.000Z");
const cleanAudit = { metadata: { vulnerabilities: { high: 0, critical: 0 } } };
const vulnerableAudit = { metadata: { vulnerabilities: { high: 1, critical: 0 } } };

function makeTool(overrides = {}) {
    return {
        id: "tool-1",
        user_id: "developer-1",
        name: "Test Tool",
        packagename: "test-tool",
        version: "1.0.0",
        repository: "https://github.com/example/test-tool",
        csp_exceptions: { "api.example.com": "API calls" },
        maturity: { verified_csp_exceptions_snapshot: { "api.example.com": "API calls" } },
        ...overrides,
    };
}

function makeClient() {
    const calls = [];
    return {
        config: { dryRun: false },
        calls,
        async supabase(path, options) {
            calls.push({ type: "supabase", path, method: options.method, body: JSON.parse(options.body) });
        },
        async notify(tool, event, details) {
            calls.push({ type: "notify", toolId: tool.id, event, details });
        },
    };
}

function maturityUpdate(client) {
    return client.calls.find((call) => call.path?.startsWith("tool_maturity?"));
}

test("new CSP entries are detected without treating changed descriptions as entries", () => {
    assert.equal(hasNewCspException(
        { "api.example.com": "Updated explanation" },
        { "api.example.com": "Original explanation" },
    ), false);
    assert.equal(hasNewCspException(
        { "api.example.com": "API", "new.example.com": "New API" },
        { "api.example.com": "API" },
    ), true);
    assert.equal(hasNewCspException(
        { connectSrc: ["api.example.com", "new.example.com"] },
        { connectSrc: ["api.example.com"] },
    ), true);
});

test("bug health applies PASS, FLAG, and BLOCKER response thresholds", () => {
    const issue = (ageDays, responseDays = null) => ({
        created_at: new Date(NOW.getTime() - ageDays * 86400000).toISOString(),
        first_maintainer_response_at: responseDays == null
            ? null
            : new Date(NOW.getTime() - (ageDays - responseDays) * 86400000).toISOString(),
    });
    assert.equal(evaluateBugHealth([issue(9)], NOW).status, "pass");
    assert.equal(evaluateBugHealth([issue(10)], NOW).status, "pass");
    assert.equal(evaluateBugHealth(Array.from({ length: 5 }, () => issue(1, 1)), NOW).status, "flag");
    assert.equal(evaluateBugHealth([issue(11)], NOW).status, "flag");
    assert.equal(evaluateBugHealth([issue(30)], NOW).status, "flag");
    assert.equal(evaluateBugHealth([issue(31)], NOW).status, "blocker");
});

test("common GitHub repository URLs are parsed", () => {
    assert.deepEqual(parseGitHubRepository("git@github.com:owner/repo.git"), { owner: "owner", repo: "repo" });
    assert.deepEqual(parseGitHubRepository("git+ssh://git@github.com/owner/repo.git"), { owner: "owner", repo: "repo" });
    assert.deepEqual(parseGitHubRepository("https://github.com/owner/repo/tree/main/tools/my-tool"), { owner: "owner", repo: "repo" });
});

test("high CVE immediately revokes and requests an email", async () => {
    const client = makeClient();
    await processTool(client, makeTool(), new Map(), NOW, { audit: vulnerableAudit, issues: [] });
    assert.equal(maturityUpdate(client).body.status, "unverified");
    assert.equal(maturityUpdate(client).body.last_change_reason, "revoked_cve");
    assert.equal(client.calls[0].event, "revoked_cve");
});

test("new CSP exception immediately revokes and requests an email", async () => {
    const client = makeClient();
    const tool = makeTool({ csp_exceptions: { "api.example.com": "API", "new.example.com": "New" } });
    await processTool(client, tool, new Map(), NOW, { audit: cleanAudit, issues: [] });
    assert.equal(maturityUpdate(client).body.last_change_reason, "revoked_csp_exception");
    assert.equal(client.calls[0].event, "revoked_csp_exception");
});

test("bug-health breach starts one two-week grace period and requests an email", async () => {
    const client = makeClient();
    const issue = { created_at: "2026-08-01T00:00:00.000Z", first_maintainer_response_at: null };
    await processTool(client, makeTool(), new Map(), NOW, { audit: cleanAudit, issues: [issue] });
    const insert = client.calls.find((call) => call.path === "tool_grace_periods?select=id,related_detail");
    assert.equal(insert.body.trigger_type, "bug_health");
    assert.equal(insert.body.deadline_at, "2026-09-12T00:00:00.000Z");
    assert.equal(client.calls.at(-1).event, "bug_health_grace_started");
    assert.equal(maturityUpdate(client), undefined);
});

test("healthy bugs resolve an active grace period", async () => {
    const client = makeClient();
    const grace = new Map([["bug_health", { id: "grace-1", deadline_at: "2026-09-01T00:00:00.000Z" }]]);
    await processTool(client, makeTool(), grace, NOW, { audit: cleanAudit, issues: [] });
    const update = client.calls.find((call) => call.path === "tool_grace_periods?id=eq.grace-1");
    assert.deepEqual(update.body, { status: "resolved", resolved_at: NOW.toISOString() });
});

test("expired bug-health grace revokes and closes the grace period", async () => {
    const client = makeClient();
    const grace = new Map([["bug_health", { id: "grace-1", deadline_at: "2026-08-28T00:00:00.000Z" }]]);
    const issue = { created_at: "2026-07-01T00:00:00.000Z", first_maintainer_response_at: null };
    await processTool(client, makeTool(), grace, NOW, { audit: cleanAudit, issues: [issue] });
    assert.equal(client.calls[0].event, "revoked_grace_expired_bug_health");
    assert.equal(client.calls[1].body.status, "expired_badge_removed");
    assert.equal(maturityUpdate(client).body.last_change_reason, "revoked_grace_expired_bug_health");
});

test("expired API breaking-change grace revokes before other checks", async () => {
    const client = makeClient();
    const grace = new Map([["api_breaking_change", {
        id: "grace-2",
        deadline_at: "2026-08-28T00:00:00.000Z",
        related_detail: {},
    }]]);
    await processTool(client, makeTool(), grace, NOW, { audit: cleanAudit, issues: [] });
    assert.equal(client.calls[0].event, "revoked_grace_expired_api_breaking");
    assert.equal(client.calls[1].body.status, "expired_badge_removed");
    assert.equal(maturityUpdate(client).body.last_change_reason, "revoked_grace_expired_api_breaking");
});

test("active API breaking-change grace notifies once and records the marker", async () => {
    const client = makeClient();
    const grace = new Map([["api_breaking_change", {
        id: "grace-2",
        deadline_at: "2026-09-12T00:00:00.000Z",
        related_detail: { release: "v2" },
    }]]);
    await processTool(client, makeTool(), grace, NOW, { audit: cleanAudit, issues: [] });
    assert.equal(client.calls[0].event, "api_breaking_change_grace_started");
    assert.equal(client.calls[1].body.related_detail.release, "v2");
    assert.equal(client.calls[1].body.related_detail.governance_notified_at, NOW.toISOString());
});