#!/usr/bin/env node

// Publishes a tool release through the restricted `publish_tool_release` RPC.
//
// Release metadata lives in `tool_releases`/`tool_release_features`; `tools` only
// holds identity fields plus `current_release_id` (legacy per-release columns were
// dropped, see supabase/sql/drop_legacy_tool_columns.sql).
//
// `applyPublishPayload` is a pure, in-memory mirror of the `publish_tool_release`
// SQL function (see supabase/sql/publish_tool_release.sql). It exists purely so the
// idempotency/retention/feature-merge semantics can be unit tested without a live
// database; production writes always go through the RPC so they benefit from the
// advisory-lock based concurrency guard and single-transaction atomicity.

const { appendFileSync } = require("node:fs");

const MAX_RETAINED_RELEASES = 3;

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonEnv(raw, label) {
    if (raw == null) return null;
    const trimmed = String(raw).trim();
    if (trimmed === "" || trimmed === "null") return null;
    try {
        return JSON.parse(trimmed);
    } catch (error) {
        throw new Error(`Failed to parse ${label} as JSON: ${error.message}`);
    }
}

// pptb.config contract: { agents: { headless: true, ... }, ... }
function detectMcpEnabled(pptbConfig) {
    return Boolean(pptbConfig && isPlainObject(pptbConfig.agents) && pptbConfig.agents.headless === true);
}

function removeNullFeatures(features) {
    if (!isPlainObject(features)) return features === undefined ? null : features;
    return Object.fromEntries(Object.entries(features).filter(([, value]) => value !== null));
}

// Adds/updates `mcpEnabled: true` when the package declares headless agent support.
function mergeMcpFeature(features, pptbConfig) {
    const normalized = removeNullFeatures(features);
    if (!detectMcpEnabled(pptbConfig)) return normalized;
    const merged = isPlainObject(normalized) ? { ...normalized } : {};
    merged.mcpEnabled = true;
    return merged;
}

function buildReleasePayload(fields) {
    const required = ["packagename", "version", "download"];
    const missing = required.filter((key) => !fields[key]);
    if (missing.length) throw new Error(`Missing required release fields: ${missing.join(", ")}`);

    return {
        packagename: fields.packagename,
        name: fields.name ?? null,
        description: fields.description ?? null,
        license: fields.license ?? null,
        repository: fields.repository ?? null,
        website: fields.website ?? null,
        min_api: fields.min_api ?? null,
        submitted_by: fields.submitted_by ?? null,
        csp_exceptions: fields.csp_exceptions ?? null,
        version: fields.version,
        download: fields.download,
        icon: fields.icon ?? null,
        checksum: fields.checksum ?? null,
        size: fields.size != null && fields.size !== "" ? Number(fields.size) : null,
        readmeurl: fields.readmeurl ?? null,
        published_at: fields.published_at ?? new Date().toISOString(),
        features: mergeMcpFeature(fields.features ?? null, fields.pptbConfig ?? null),
    };
}

function createState() {
    return { tools: new Map(), toolReleases: [], featureDefinitions: new Map(), releaseFeatures: [] };
}

function cloneState(state) {
    return {
        tools: new Map(state.tools),
        toolReleases: state.toolReleases.map((release) => ({ ...release })),
        featureDefinitions: new Map(state.featureDefinitions),
        releaseFeatures: state.releaseFeatures.map((feature) => ({ ...feature })),
    };
}

function makeIdFactory() {
    const counters = new Map();
    return (prefix) => {
        const next = (counters.get(prefix) || 0) + 1;
        counters.set(prefix, next);
        return `${prefix}-${next}`;
    };
}

// Pure reference implementation of publish_tool_release(). Mirrors:
//   1. Idempotent identity upsert on tools.packagename
//   2. Idempotent release upsert on tool_releases (tool_id, version)
//   3. Full replace of tool_release_features for the release (handles null values)
//   4. current_release_id pointer update
//   5. Retention of at most MAX_RETAINED_RELEASES releases, current always kept
function applyPublishPayload(state, payload, options = {}) {
    const generateId = options.generateId || makeIdFactory();
    const next = cloneState(state);

    let tool = next.tools.get(payload.packagename);
    if (!tool) {
        tool = { id: generateId("tool"), packagename: payload.packagename };
    }
    tool = {
        ...tool,
        name: payload.name,
        description: payload.description,
        license: payload.license ?? tool.license ?? null,
        repository: payload.repository,
        website: payload.website,
        min_api: payload.min_api ?? tool.min_api ?? null,
        user_id: payload.submitted_by ?? tool.user_id ?? null,
        csp_exceptions: payload.csp_exceptions,
    };

    let release = next.toolReleases.find((row) => row.tool_id === tool.id && row.version === payload.version);
    if (!release) {
        release = { id: generateId("release"), tool_id: tool.id, version: payload.version };
        next.toolReleases.push(release);
    }
    release.download = payload.download;
    release.icon = payload.icon;
    release.checksum = payload.checksum;
    release.size = payload.size;
    release.readmeurl = payload.readmeurl;
    release.min_api = payload.min_api;
    release.published_at = payload.published_at;

    // Replace (not merge) feature rows for this release so removed keys don't linger.
    next.releaseFeatures = next.releaseFeatures.filter((feature) => feature.release_id !== release.id);
    if (isPlainObject(payload.features)) {
        for (const [key, value] of Object.entries(payload.features)) {
            let definition = next.featureDefinitions.get(key);
            if (!definition) {
                definition = { id: generateId("feature"), key };
                next.featureDefinitions.set(key, definition);
            }
            next.releaseFeatures.push({ release_id: release.id, feature_definition_id: definition.id, key, value });
        }
    }

    tool.current_release_id = release.id;
    next.tools.set(payload.packagename, tool);

    const releasesForTool = next.toolReleases.filter((row) => row.tool_id === tool.id);
    const ranked = [...releasesForTool].sort((a, b) => {
        if (a.id === release.id) return -1;
        if (b.id === release.id) return 1;
        return new Date(b.published_at || 0) - new Date(a.published_at || 0);
    });
    const retainedIds = new Set(ranked.slice(0, MAX_RETAINED_RELEASES).map((row) => row.id));
    next.toolReleases = next.toolReleases.filter((row) => row.tool_id !== tool.id || retainedIds.has(row.id));
    next.releaseFeatures = next.releaseFeatures.filter(
        (feature) => next.toolReleases.some((row) => row.id === feature.release_id),
    );

    return {
        state: next,
        result: {
            tool_id: tool.id,
            release_id: release.id,
            current_release_id: tool.current_release_id,
            retained_release_count: next.toolReleases.filter((row) => row.tool_id === tool.id).length,
        },
    };
}

class PublishClient {
    constructor(config) {
        this.config = config;
    }

    async request(url, options = {}) {
        const response = await fetch(url, options);
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`${options.method || "GET"} ${url} failed (${response.status}): ${text}`);
        }
        return text ? JSON.parse(text) : null;
    }

    // Calls the restricted RPC so tool identity, release metadata, package features
    // and the current-release pointer are written atomically in one transaction.
    async rpc(name, payload) {
        return this.request(`${this.config.supabaseUrl}/rest/v1/rpc/${name}`, {
            method: "POST",
            headers: {
                apikey: this.config.supabaseKey,
                Authorization: `Bearer ${this.config.supabaseKey}`,
                "Content-Type": "application/json",
                Prefer: "return=representation",
            },
            body: JSON.stringify({ payload }),
        });
    }
}

function loadConfig(environment = process.env) {
    const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TOOL_PACKAGENAME", "TOOL_VERSION", "TOOL_DOWNLOAD"];
    const missing = required.filter((name) => !environment[name]);
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);

    return {
        supabaseUrl: environment.SUPABASE_URL.replace(/\/$/, ""),
        supabaseKey: environment.SUPABASE_SERVICE_ROLE_KEY,
        fields: {
            packagename: environment.TOOL_PACKAGENAME,
            name: environment.TOOL_NAME || null,
            description: environment.TOOL_DESCRIPTION || null,
            license: environment.TOOL_LICENSE || null,
            repository: environment.TOOL_REPOSITORY || null,
            website: environment.TOOL_WEBSITE || null,
            min_api: environment.TOOL_MIN_API || null,
            submitted_by: environment.TOOL_SUBMITTED_BY || null,
            csp_exceptions: parseJsonEnv(environment.TOOL_CSP_EXCEPTIONS, "TOOL_CSP_EXCEPTIONS"),
            version: environment.TOOL_VERSION,
            download: environment.TOOL_DOWNLOAD,
            icon: environment.TOOL_ICON || null,
            checksum: environment.TOOL_CHECKSUM || null,
            size: environment.TOOL_SIZE || null,
            readmeurl: environment.TOOL_READMEURL || null,
            published_at: environment.TOOL_PUBLISHED_AT || null,
            features: parseJsonEnv(environment.TOOL_FEATURES, "TOOL_FEATURES"),
            pptbConfig: parseJsonEnv(environment.TOOL_PPTB_CONFIG, "TOOL_PPTB_CONFIG"),
        },
    };
}

async function main() {
    const config = loadConfig();
    const payload = buildReleasePayload(config.fields);
    const client = new PublishClient(config);
    const response = await client.rpc("publish_tool_release", payload);
    const result = Array.isArray(response) ? response[0] : response;

    console.log(`RESULT_JSON:${JSON.stringify(result || {})}`);

    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `tool_id=${result?.tool_id ?? ""}\n`);
        appendFileSync(process.env.GITHUB_OUTPUT, `release_id=${result?.release_id ?? ""}\n`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    MAX_RETAINED_RELEASES,
    detectMcpEnabled,
    mergeMcpFeature,
    buildReleasePayload,
    createState,
    applyPublishPayload,
    makeIdFactory,
    loadConfig,
    parseJsonEnv,
    PublishClient,
};
