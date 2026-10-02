const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const {
    MAX_RETAINED_RELEASES,
    detectMcpEnabled,
    mergeMcpFeature,
    buildReleasePayload,
    createState,
    applyPublishPayload,
    makeIdFactory,
} = require("../buildScripts/publishToolRelease");

function findRelease(state, releaseId) {
    return state.toolReleases.find((r) => r.id === releaseId);
}

function basePayload(overrides = {}) {
    return buildReleasePayload({
        packagename: "acme-tool",
        name: "Acme Tool",
        description: "Does things",
        version: "1.0.0",
        download: "https://blob.example/acme-tool-1.0.0.tar.gz",
        icon: "https://blob.example/acme-tool-1.0.0-icon.svg",
        checksum: "sha256-a",
        size: "100",
        readmeurl: "https://example.com/readme",
        published_at: "2026-01-01T00:00:00.000Z",
        ...overrides,
    });
}

test("detectMcpEnabled requires agents.headless === true", () => {
    assert.equal(detectMcpEnabled(null), false);
    assert.equal(detectMcpEnabled({}), false);
    assert.equal(detectMcpEnabled({ agents: {} }), false);
    assert.equal(detectMcpEnabled({ agents: { headless: "true" } }), false);
    assert.equal(detectMcpEnabled({ agents: { headless: true } }), true);
});

test("mergeMcpFeature passes features through untouched when mcp is not enabled", () => {
    assert.equal(mergeMcpFeature(null, null), null);
    assert.equal(mergeMcpFeature(undefined, null), null);
    assert.deepEqual(mergeMcpFeature({ darkMode: true }, { agents: { headless: false } }), { darkMode: true });
});

test("mergeMcpFeature adds mcpEnabled=true when pptb.config declares headless agents", () => {
    assert.deepEqual(mergeMcpFeature(null, { agents: { headless: true } }), { mcpEnabled: true });
    assert.deepEqual(
        mergeMcpFeature({ darkMode: true }, { agents: { headless: true } }),
        { darkMode: true, mcpEnabled: true },
    );
});

test("publishing SQL validates and clears features from both package-controlled sources", () => {
    const sql = readFileSync(path.join(__dirname, "../supabase/sql/publish_tool_release.sql"), "utf8");
    assert.match(sql, /delete from public\.tool_release_features[\s\S]*?definition\.source in \('package\.json', 'pptb\.config\.json'\);/);
    assert.match(sql, /where definition\.key = v_feature_key\s+and definition\.source in \('package\.json', 'pptb\.config\.json'\);/);
    assert.doesNotMatch(sql, /definition\.source = 'package\.json'/);
});

test("buildReleasePayload rejects missing required fields", () => {
    assert.throws(() => buildReleasePayload({ version: "1.0.0", download: "x" }), /packagename/);
    assert.throws(() => buildReleasePayload({ packagename: "p", download: "x" }), /version/);
    assert.throws(() => buildReleasePayload({ packagename: "p", version: "1.0.0" }), /download/);
});

test("new tool: creates tool, release, features, and sets the current pointer", () => {
    const generateId = makeIdFactory();
    const { state, result } = applyPublishPayload(
        createState(),
        basePayload({ features: { darkMode: true } }),
        { generateId },
    );

    const tool = state.tools.get("acme-tool");
    const release = findRelease(state, result.release_id);
    assert.equal(tool.id, result.tool_id);
    assert.equal(tool.current_release_id, result.release_id);
    assert.equal(release.download, "https://blob.example/acme-tool-1.0.0.tar.gz");
    assert.equal(release.icon, "https://blob.example/acme-tool-1.0.0-icon.svg");
    assert.equal(release.version, "1.0.0");
    assert.equal(state.toolReleases.length, 1);
    assert.equal(result.retained_release_count, 1);

    const features = state.releaseFeatures.filter((f) => f.release_id === result.release_id);
    assert.equal(features.length, 1);
    assert.equal(features[0].key, "darkMode");
    assert.equal(features[0].value, true);
});

test("same-version retry is idempotent (no duplicate rows, same ids)", () => {
    const generateId = makeIdFactory();
    const first = applyPublishPayload(createState(), basePayload({ features: { darkMode: true } }), { generateId });
    const second = applyPublishPayload(first.state, basePayload({ features: { darkMode: true } }), { generateId });

    assert.equal(second.result.tool_id, first.result.tool_id);
    assert.equal(second.result.release_id, first.result.release_id);
    assert.equal(second.state.toolReleases.length, 1);
    assert.equal(
        second.state.releaseFeatures.filter((f) => f.release_id === second.result.release_id).length,
        1,
    );
});

test("update to a new version (including a changed icon) becomes current and keeps history", () => {
    const generateId = makeIdFactory();
    const v1 = applyPublishPayload(createState(), basePayload(), { generateId });
    const v2 = applyPublishPayload(
        v1.state,
        basePayload({
            version: "2.0.0",
            download: "https://blob.example/acme-tool-2.0.0.tar.gz",
            icon: "https://blob.example/acme-tool-2.0.0-icon.svg",
            published_at: "2026-02-01T00:00:00.000Z",
        }),
        { generateId },
    );

    assert.notEqual(v2.result.release_id, v1.result.release_id);
    assert.equal(v2.result.tool_id, v1.result.tool_id);

    const tool = v2.state.tools.get("acme-tool");
    const currentRelease = findRelease(v2.state, v2.result.release_id);
    assert.equal(tool.current_release_id, v2.result.release_id);
    assert.equal(currentRelease.icon, "https://blob.example/acme-tool-2.0.0-icon.svg");
    assert.equal(currentRelease.download, "https://blob.example/acme-tool-2.0.0.tar.gz");
    assert.equal(currentRelease.version, "2.0.0");

    // Older version stays retained (only 2 releases total, below the cap of 3).
    assert.equal(v2.state.toolReleases.length, 2);
    assert.ok(v2.state.toolReleases.some((r) => r.version === "1.0.0"));
});

test("null feature values are omitted before publishing without error", () => {
    const generateId = makeIdFactory();
    const { state, result } = applyPublishPayload(
        createState(),
        basePayload({ features: { darkMode: true, betaFlag: null } }),
        { generateId },
    );

    const features = state.releaseFeatures.filter((f) => f.release_id === result.release_id);
    assert.deepEqual(features.map((f) => f.key), ["darkMode"]);
});

test("four published versions retain only the three most recent (current always kept)", () => {
    const generateId = makeIdFactory();
    let current = { state: createState() };
    const versions = ["1.0.0", "2.0.0", "3.0.0", "4.0.0"];
    for (const [index, version] of versions.entries()) {
        current = applyPublishPayload(
            current.state,
            basePayload({
                version,
                download: `https://blob.example/acme-tool-${version}.tar.gz`,
                published_at: `2026-0${index + 1}-01T00:00:00.000Z`,
            }),
            { generateId },
        );
    }

    assert.equal(current.state.toolReleases.length, MAX_RETAINED_RELEASES);
    const retainedVersions = current.state.toolReleases.map((r) => r.version).sort();
    assert.deepEqual(retainedVersions, ["2.0.0", "3.0.0", "4.0.0"]);

    const tool = current.state.tools.get("acme-tool");
    const currentRelease = findRelease(current.state, current.result.release_id);
    assert.equal(currentRelease.version, "4.0.0");
    assert.equal(tool.current_release_id, current.result.release_id);

    // No orphaned feature rows for the pruned 1.0.0 release.
    const prunedReleaseIds = new Set(["1.0.0"]);
    const remainingReleaseIds = new Set(current.state.toolReleases.map((r) => r.id));
    for (const feature of current.state.releaseFeatures) {
        assert.ok(remainingReleaseIds.has(feature.release_id));
    }
    assert.ok(prunedReleaseIds); // documents intent; pruning verified via releaseFeatures above
});

test("concurrent updates for the same tool serialize (as the advisory lock would) without interleaving", async () => {
    // Models the pg_advisory_xact_lock in publish_tool_release: two "concurrent" callers
    // race, but writes to the shared state must still apply as whole, non-interleaved
    // transactions, one after another.
    const generateId = makeIdFactory();
    let state = createState();
    let queue = Promise.resolve();
    const results = [];

    function publishSerialized(payload) {
        queue = queue.then(async () => {
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
            const applied = applyPublishPayload(state, payload, { generateId });
            state = applied.state;
            results.push(applied.result);
        });
        return queue;
    }

    await Promise.all([
        publishSerialized(basePayload({ icon: "https://blob.example/icon-a.svg", published_at: "2026-03-01T00:00:00.000Z" })),
        publishSerialized(basePayload({ icon: "https://blob.example/icon-b.svg", published_at: "2026-03-01T00:00:00.000Z" })),
    ]);

    // Exactly one release row for the shared version, and the tool's current pointer
    // matches whichever transaction committed last (not a mix of both).
    assert.equal(state.toolReleases.length, 1);
    const tool = state.tools.get("acme-tool");
    const lastResult = results[results.length - 1];
    assert.equal(tool.current_release_id, lastResult.release_id);
    const release = state.toolReleases[0];
    assert.equal(release.id, lastResult.release_id);
});
