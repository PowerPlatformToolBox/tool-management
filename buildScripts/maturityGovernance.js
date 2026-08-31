#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).sort().join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function cspEntrySet(value, path = "") {
    const entries = new Set();
    if (value == null) return entries;
    if (Array.isArray(value)) {
        for (const item of value) entries.add(`${path}[]:${stableStringify(item)}`);
    } else if (typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            const childPath = path ? `${path}.${key}` : key;
            if (Array.isArray(child)) {
                for (const item of child) entries.add(`${childPath}[]:${stableStringify(item)}`);
            } else if (child && typeof child === "object") {
                for (const entry of cspEntrySet(child, childPath)) entries.add(entry);
            } else {
                entries.add(childPath);
            }
        }
    } else {
        entries.add(`${path}:${stableStringify(value)}`);
    }
    return entries;
}

function hasNewCspException(current, approvedSnapshot) {
    const approved = cspEntrySet(approvedSnapshot);
    return [...cspEntrySet(current)].some((entry) => !approved.has(entry));
}

function parseGitHubRepository(repository) {
    if (!repository) return null;
    const normalized = repository
        .replace(/^git\+ssh:\/\/git@github\.com\//, "https://github.com/")
        .replace(/^git\+/, "")
        .replace(/^git@github\.com:/, "https://github.com/")
        .replace(/\.git(?:#.*)?$/, "");
    const match = normalized.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:[/#?].*)?$/i);
    return match ? { owner: match[1], repo: match[2] } : null;
}

function evaluateBugHealth(issues, now = new Date()) {
    let longestResponseDays = 0;
    let blocker = false;
    for (const issue of issues) {
        const createdAt = new Date(issue.created_at);
        const responseAt = issue.first_maintainer_response_at
            ? new Date(issue.first_maintainer_response_at)
            : now;
        const responseDays = (responseAt - createdAt) / DAY_MS;
        longestResponseDays = Math.max(longestResponseDays, responseDays);
        blocker ||= responseDays > 30;
    }
    const flagged = issues.length >= 5 || longestResponseDays > 10;
    return {
        status: blocker ? "blocker" : flagged ? "flag" : "pass",
        openBugCount: issues.length,
        longestResponseDays: Math.floor(longestResponseDays),
    };
}

function auditHasHighOrCritical(audit) {
    const totals = audit?.metadata?.vulnerabilities;
    if (totals) return (totals.high || 0) > 0 || (totals.critical || 0) > 0;
    return Object.values(audit?.vulnerabilities || {}).some(
        (item) => item.severity === "high" || item.severity === "critical",
    );
}

function runNpmAudit(tool, fixture) {
    if (fixture) return fixture;
    const directory = mkdtempSync(join(tmpdir(), "pptb-governance-"));
    try {
        execFileSync("npm", ["init", "--yes"], { cwd: directory, stdio: "ignore" });
        execFileSync("npm", [
            "install", "--package-lock-only", "--ignore-scripts", "--omit=dev",
            `${tool.packagename}@${tool.version}`,
        ], { cwd: directory, stdio: "ignore" });
        try {
            return JSON.parse(execFileSync("npm", ["audit", "--json", "--omit=dev"], {
                cwd: directory,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            }));
        } catch (error) {
            if (error.stdout) return JSON.parse(error.stdout.toString());
            throw error;
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

async function fetchOpenBugIssues(client, repository, fixture) {
    if (fixture) return fixture;
    const parsed = parseGitHubRepository(repository);
    if (!parsed) throw new Error(`Unsupported or missing GitHub repository URL: ${repository || "(empty)"}`);
    const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
    const issues = [];
    for (let page = 1; ; page += 1) {
        const batch = await client.github(`${base}/issues?state=open&labels=bug&per_page=100&page=${page}`);
        for (const issue of batch.filter((item) => !item.pull_request)) {
            let firstResponse = MAINTAINER_ASSOCIATIONS.has(issue.author_association) ? issue.created_at : null;
            for (let commentPage = 1; !firstResponse; commentPage += 1) {
                const comments = await client.github(`${base}/issues/${issue.number}/comments?per_page=100&page=${commentPage}`);
                const response = comments.find((comment) => MAINTAINER_ASSOCIATIONS.has(comment.author_association));
                if (response) firstResponse = response.created_at;
                if (comments.length < 100) break;
            }
            issues.push({ created_at: issue.created_at, first_maintainer_response_at: firstResponse });
        }
        if (batch.length < 100) break;
    }
    return issues;
}

class GovernanceClient {
    constructor(config) {
        this.config = config;
    }

    async request(url, options = {}) {
        const response = await fetch(url, options);
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`${options.method || "GET"} ${url} failed (${response.status}): ${text}`);
        }
        if (!text) return null;
        return response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
    }

    async supabase(path, options = {}) {
        return this.request(`${this.config.supabaseUrl}/rest/v1/${path}`, {
            ...options,
            headers: {
                apikey: this.config.supabaseKey,
                Authorization: `Bearer ${this.config.supabaseKey}`,
                "Content-Type": "application/json",
                ...options.headers,
            },
        });
    }

    async github(path) {
        return this.request(`https://api.github.com${path}`, {
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${this.config.githubToken}`,
                "X-GitHub-Api-Version": "2022-11-28",
            },
        });
    }

    async notify(tool, event, details = {}) {
        if (this.config.dryRun) {
            console.log(`[dry-run] Would request ${event} email for ${tool.name}`);
            return;
        }
        await this.request(this.config.notificationUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                event,
                developerId: tool.user_id,
                toolId: tool.id,
                toolName: tool.name,
                details,
            }),
        });
    }
}

async function patchMaturity(client, toolId, reason, now) {
    if (client.config.dryRun) return;
    await client.supabase(`tool_maturity?tool_id=eq.${encodeURIComponent(toolId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
            status: "unverified",
            last_change_reason: reason,
            last_changed_at: now.toISOString(),
            updated_at: now.toISOString(),
        }),
    });
}

async function patchGrace(client, graceId, values) {
    if (client.config.dryRun) return;
    await client.supabase(`tool_grace_periods?id=eq.${encodeURIComponent(graceId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(values),
    });
}

async function revokeImmediately(client, tool, reason, now) {
    await client.notify(tool, reason);
    await patchMaturity(client, tool.id, reason, now);
}

async function expireGrace(client, tool, grace, reason, now) {
    await client.notify(tool, reason, { deadlineAt: grace.deadline_at });
    await patchGrace(client, grace.id, { status: "expired_badge_removed" });
    await patchMaturity(client, tool.id, reason, now);
}

async function createBugGrace(client, tool, health, now) {
    const deadlineAt = new Date(now.getTime() + 14 * DAY_MS).toISOString();
    const row = {
        tool_id: tool.id,
        trigger_type: "bug_health",
        started_at: now.toISOString(),
        deadline_at: deadlineAt,
        related_detail: {
            threshold: health.status,
            open_bug_count: health.openBugCount,
            longest_response_days: health.longestResponseDays,
        },
    };
    let insertedGrace;
    if (!client.config.dryRun) {
        const inserted = await client.supabase("tool_grace_periods?select=id,related_detail", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify(row),
        });
        insertedGrace = inserted?.[0];
    }
    await client.notify(tool, "bug_health_grace_started", {
        deadlineAt,
        threshold: health.status,
        openBugCount: health.openBugCount,
        longestResponseDays: health.longestResponseDays,
    });
    if (insertedGrace) {
            await patchGrace(client, insertedGrace.id, {
                related_detail: { ...insertedGrace.related_detail, governance_notified_at: now.toISOString() },
            });
    }
}

async function loadVerifiedTools(client, toolId) {
    const filter = toolId ? `&tool_id=eq.${encodeURIComponent(toolId)}` : "";
    const maturities = await client.supabase(
        `tool_maturity?status=eq.verified${filter}&select=tool_id,verified_csp_exceptions_snapshot`,
    );
    const tools = [];
    for (const maturity of maturities) {
        const rows = await client.supabase(
            `tools?id=eq.${encodeURIComponent(maturity.tool_id)}&select=id,name,packagename,version,repository,csp_exceptions,user_id`,
        );
        if (!rows[0]) throw new Error(`Verified tool ${maturity.tool_id} was not found`);
        tools.push({ ...rows[0], maturity });
    }
    return tools;
}

async function loadActiveGracePeriods(client, toolId) {
    const filter = toolId ? `&tool_id=eq.${encodeURIComponent(toolId)}` : "";
    return client.supabase(
        `tool_grace_periods?status=eq.active${filter}&select=id,tool_id,trigger_type,deadline_at,related_detail`,
    );
}

async function processApiBreakingGrace(client, tool, grace, now) {
    if (!grace) return false;
    if (new Date(grace.deadline_at) <= now) {
        await expireGrace(client, tool, grace, "revoked_grace_expired_api_breaking", now);
        console.log(`${tool.name}: revoked after API breaking-change grace period`);
        return true;
    }
    if (!grace.related_detail?.governance_notified_at) {
        await client.notify(tool, "api_breaking_change_grace_started", { deadlineAt: grace.deadline_at });
        await patchGrace(client, grace.id, {
            related_detail: { ...grace.related_detail, governance_notified_at: now.toISOString() },
        });
    }
    return false;
}

async function processTool(client, tool, graceByTrigger, now, fixture = {}) {
    if (await processApiBreakingGrace(client, tool, graceByTrigger.get("api_breaking_change"), now)) return;

    if (auditHasHighOrCritical(runNpmAudit(tool, fixture.audit))) {
        await revokeImmediately(client, tool, "revoked_cve", now);
        console.log(`${tool.name}: revoked for high/critical CVE`);
        return;
    }

    if (hasNewCspException(tool.csp_exceptions, tool.maturity.verified_csp_exceptions_snapshot)) {
        await revokeImmediately(client, tool, "revoked_csp_exception", now);
        console.log(`${tool.name}: revoked for new CSP exception`);
        return;
    }

    const issues = await fetchOpenBugIssues(client, tool.repository, fixture.issues);
    const health = evaluateBugHealth(issues, now);
    const bugGrace = graceByTrigger.get("bug_health");
    if (health.status === "pass" && bugGrace) {
        await patchGrace(client, bugGrace.id, { status: "resolved", resolved_at: now.toISOString() });
        console.log(`${tool.name}: bug-health grace period resolved`);
    } else if (health.status !== "pass" && !bugGrace) {
        await createBugGrace(client, tool, health, now);
        console.log(`${tool.name}: bug-health grace period started`);
    } else if (health.status !== "pass" && new Date(bugGrace.deadline_at) <= now) {
        await expireGrace(client, tool, bugGrace, "revoked_grace_expired_bug_health", now);
        console.log(`${tool.name}: revoked after bug-health grace period`);
    } else if (health.status !== "pass" && !bugGrace.related_detail?.governance_notified_at) {
        await client.notify(tool, "bug_health_grace_started", {
            deadlineAt: bugGrace.deadline_at,
            threshold: health.status,
            openBugCount: health.openBugCount,
            longestResponseDays: health.longestResponseDays,
        });
        await patchGrace(client, bugGrace.id, {
            related_detail: { ...bugGrace.related_detail, governance_notified_at: now.toISOString() },
        });
    } else {
        console.log(`${tool.name}: governance checks passed`);
    }
}

async function runGovernance(config, dependencies = {}) {
    const client = dependencies.client || new GovernanceClient(config);
    const now = dependencies.now || new Date();
    const fixtures = dependencies.fixtures || {};
    const tools = await loadVerifiedTools(client, config.toolId);
    if (config.toolId && tools.length === 0) {
        throw new Error(`TOOL_ID ${config.toolId} does not identify a verified tool`);
    }
    const gracePeriods = await loadActiveGracePeriods(client, config.toolId);
    const graceByTool = new Map();
    for (const grace of gracePeriods) {
        if (!graceByTool.has(grace.tool_id)) graceByTool.set(grace.tool_id, new Map());
        graceByTool.get(grace.tool_id).set(grace.trigger_type, grace);
    }

    const failures = [];
    for (const tool of tools) {
        try {
            await processTool(client, tool, graceByTool.get(tool.id) || new Map(), now, fixtures[tool.id]);
        } catch (error) {
            failures.push(`${tool.name}: ${error.message}`);
            console.error(`Governance check failed for ${tool.name}:`, error);
        }
    }
    if (failures.length) throw new Error(`Governance checks failed:\n${failures.join("\n")}`);
}

function loadConfig(environment = process.env) {
    const dryRun = environment.DRY_RUN === "true";
    const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GITHUB_TOKEN"];
    if (!dryRun) required.push("NOTIFICATION_API_URL");
    const missing = required.filter((name) => !environment[name]);
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    return {
        supabaseUrl: environment.SUPABASE_URL.replace(/\/$/, ""),
        supabaseKey: environment.SUPABASE_SERVICE_ROLE_KEY,
        githubToken: environment.GITHUB_TOKEN,
        notificationUrl: environment.NOTIFICATION_API_URL,
        toolId: environment.TOOL_ID || "",
        dryRun,
    };
}

if (require.main === module) {
    let fixtures = {};
    const fixtureIndex = process.argv.indexOf("--fixtures");
    if (fixtureIndex >= 0) fixtures = JSON.parse(readFileSync(process.argv[fixtureIndex + 1], "utf8"));
    runGovernance(loadConfig(), { fixtures }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    auditHasHighOrCritical,
    evaluateBugHealth,
    fetchOpenBugIssues,
    hasNewCspException,
    loadConfig,
    parseGitHubRepository,
    processTool,
    runGovernance,
    runNpmAudit,
};