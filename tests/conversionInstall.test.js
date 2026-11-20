const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

test("convert-tool.yml extracts quoted and multiline inputs without shell interpolation", () => {
    const source = readFileSync(path.join(__dirname, "../.github/workflows/convert-tool.yml"), "utf8");
    const step = source.split("- name: Extract tool info\n")[1].split("- name: Check approved intake\n")[0];
    const script = step.split("run: |\n")[1].replace(/^ {18}/gm, "").trim();
    assert.equal(script.includes("${{"), false);
    const inputs = {
        npm_package_name: "@power-maverick/tool-root-cause-analyzer",
        display_name: "Root Cause Analyzer",
        description: "Find a tool's cause with \"quotes\", `commands`, and $(commands).\nSecond line\nname=injected",
        authors: "O'Brien",
        readme_url: "https://example.com/readme",
        icon: "",
        repository: "https://example.com/repository",
        website: "https://example.com/website",
        minAPI: "1.0.0",
    };
    const environment = { ...process.env };
    for (const [, variable, input] of step.matchAll(/(TOOL_\w+): \$\{\{ inputs\.(\w+) \}\}/g)) {
        environment[variable] = inputs[input];
    }
    const directory = mkdtempSync(path.join(tmpdir(), "tool-inputs-"));
    try {
        environment.GITHUB_OUTPUT = path.join(directory, "outputs");
        execFileSync("bash", ["-e", "-c", script], { env: environment, stdio: "pipe" });
        const output = readFileSync(environment.GITHUB_OUTPUT, "utf8");
        const values = Object.fromEntries(Array.from(
            output.matchAll(/^(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/gm),
            ([, name, , value]) => [name, value],
        ));
        assert.deepEqual(values, {
            package: inputs.npm_package_name,
            name: inputs.display_name,
            description: inputs.description,
            authors: inputs.authors,
            readme_url: inputs.readme_url,
            icon: inputs.icon,
            repository: inputs.repository,
            website: inputs.website,
            minAPI: inputs.minAPI,
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("convert-tool.yml keeps metadata values out of downstream shell source", () => {
    const source = readFileSync(path.join(__dirname, "../.github/workflows/convert-tool.yml"), "utf8");
    const metadataStep = source.split("- name: Build tool metadata JSON\n")[1]
        .split("- name: Detect pptb.config\n")[0];
    const publishStep = source.split("- name: Update Supabase database\n")[1]
        .split("- name: Regenerate Azure Blob registry.json\n")[0];
    for (const step of [metadataStep, publishStep]) {
        assert.doesNotMatch(step.split("run: |\n")[1], /\$\{\{\s*(steps\.tool\.outputs|inputs)\./);
    }
    const values = {
        package: "@power-maverick/tool-root-cause-analyzer",
        name: "Analyzer's \"tool\"",
        description: "Tool's \"description\" with `exit 23` and $(exit 24)\nSecond line",
        authors: "O'Brien",
        readme_url: "https://example.com/readme",
        repository: "https://example.com/repository",
        website: "https://example.com/website",
        minAPI: "1.0.0",
    };
    const environment = { ...process.env, TOOL_ID: "analyzer", TOOL_VERSION: "1.0.0" };
    for (const [, variable, output] of metadataStep.matchAll(/(INPUT_\w+): \$\{\{ steps\.tool\.outputs\.(\w+) \}\}/g)) {
        environment[variable] = values[output];
    }
    const script = metadataStep.split("run: |\n")[1].replace(/^ {18}/gm, "")
        .replace(/\$\{\{ steps\.checksum\.outputs\.size \}\}/g, "123")
        .replace(/\$\{\{[^}]+\}\}/g, "test");
    const directory = mkdtempSync(path.join(tmpdir(), "tool-metadata-"));
    try {
        environment.GITHUB_ENV = path.join(directory, "environment");
        execFileSync("bash", ["-e", "-c", script], { env: environment, stdio: "pipe" });
        const output = readFileSync(environment.GITHUB_ENV, "utf8");
        const metadata = JSON.parse(output.trim().slice("TOOL_METADATA_JSON=".length));
        for (const field of ["name", "description", "authors", "repository", "website"]) {
            assert.equal(metadata[field], values[field]);
        }
        assert.equal(metadata.packagename, values.package);
        assert.equal(metadata.readmeurl, values.readme_url);
        assert.equal(metadata.min_api, values.minAPI);
        assert.match(publishStep, /TOOL_DESCRIPTION: \$\{\{ steps\.tool\.outputs\.description \}\}/);
        assert.match(publishStep, /TOOL_LICENSE: \$\{\{ inputs\.license \}\}/);
        assert.match(publishStep, /TOOL_SUBMITTED_BY: \$\{\{ inputs\.submitted_by \}\}/);
        assert.match(publishStep, /TOOL_INTAKE_ID: \$\{\{ inputs\.intake_id \}\}/);
        assert.match(publishStep, /TOOL_INTAKE_REVISION: \$\{\{ inputs\.intake_revision \}\}/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("intake conversion packs the approved version and rejects a different manifest before install", () => {
    const source = readFileSync(path.join(__dirname, "../.github/workflows/convert-tool.yml"), "utf8");
    const step = source.split("- name: Download approved npm version and verify manifest\n")[1].split("- name: Set tool environment\n")[0];
    const script = step.split("run: |\n")[1].replace(/^ {18}/gm, "").trim();
    assert.ok(source.indexOf("- name: Update Supabase database") < source.indexOf("- name: Regenerate Azure Blob registry.json"));
    const directory = mkdtempSync(path.join(tmpdir(), "tool-approved-version-"));
    try {
        mkdirSync(path.join(directory, "fixture", "package"), { recursive: true });
        writeFileSync(path.join(directory, "npm"), `#!/bin/bash
set -e
if [[ "$1" == "pack" ]]; then
    [[ "$#" == 4 && "$2" == "--ignore-scripts" && "$3" == "--" && "$4" == "@scope/tool@1.1.0" ]]
    tar -czf tool.tgz -C fixture package
elif [[ "$1" == "install" ]]; then
    touch "$INSTALL_MARKER"
fi
`, { mode: 0o755 });
        const environment = {
            ...process.env, PATH: `${directory}:${process.env.PATH}`, TOOL_PACKAGE: "@scope/tool", APPROVED_VERSION: "1.1.0",
            GITHUB_OUTPUT: path.join(directory, "outputs"), INSTALL_MARKER: path.join(directory, "installed"),
        };
        const manifest = path.join(directory, "fixture", "package", "package.json");
        writeFileSync(manifest, JSON.stringify({ name: "@scope/tool", version: "1.2.0" }));
        const run = () => execFileSync("bash", ["-c", script], { cwd: directory, env: environment, stdio: "pipe" });
        assert.throws(run, /manifest does not match the approved npm package and version/);
        assert.equal(existsSync(environment.INSTALL_MARKER), false);
        writeFileSync(manifest, JSON.stringify({ name: "@scope/tool", version: "1.1.0" }));
        run();
        assert.match(readFileSync(environment.GITHUB_OUTPUT, "utf8"), /^version=1\.1\.0$/m);
        assert.equal(existsSync(environment.INSTALL_MARKER), true);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

for (const workflow of ["convert-tool.yml", "update-convert-tool.yml"]) {
    test(`${workflow} installs legacy packages without resolving peers or running lifecycle scripts`, () => {
        const source = readFileSync(path.join(__dirname, "../.github/workflows", workflow), "utf8");
        const command = source.match(/^\s*(npm install[^\r\n]*)$/m)?.[1];
        assert.ok(command, "The conversion workflow must install production dependencies");
        const args = command.split(/\s+/).slice(1);
        for (const flag of ["--omit=dev", "--omit=optional", "--ignore-scripts", "--legacy-peer-deps"]) {
            assert.ok(args.includes(flag), `Missing install flag: ${flag}`);
        }

        const directory = mkdtempSync(path.join(tmpdir(), "tool-conversion-"));
        try {
            const dependencyDirectory = path.join(directory, "legacy-dependency");
            mkdirSync(dependencyDirectory);
            writeFileSync(path.join(dependencyDirectory, "package.json"), JSON.stringify({
                name: "legacy-dependency",
                version: "1.0.0",
                peerDependencies: { "missing-legacy-peer": "1.0.0" },
                scripts: { postinstall: "node -e \"process.exit(1)\"" },
            }));
            for (const name of ["development-dependency", "optional-dependency"]) {
                const dependencyPath = path.join(directory, name);
                mkdirSync(dependencyPath);
                writeFileSync(path.join(dependencyPath, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
            }
            writeFileSync(path.join(directory, "package.json"), JSON.stringify({
                name: "legacy-tool",
                version: "1.0.0",
                configurations: { minAPI: "1.0.0" },
                dependencies: { "legacy-dependency": "file:./legacy-dependency" },
                devDependencies: { "development-dependency": "file:./development-dependency" },
                optionalDependencies: { "optional-dependency": "file:./optional-dependency" },
                scripts: { postinstall: "node -e \"process.exit(1)\"" },
            }));

            execFileSync("npm", [...args, "--offline", "--no-audit", "--no-fund"], {
                cwd: directory,
                stdio: "pipe",
                timeout: 30000,
            });

            const installed = JSON.parse(readFileSync(
                path.join(directory, "node_modules/legacy-dependency/package.json"), "utf8",
            ));
            assert.equal(installed.version, "1.0.0");
            for (const name of ["development-dependency", "optional-dependency", "missing-legacy-peer"]) {
                assert.equal(existsSync(path.join(directory, "node_modules", name)), false);
            }
            const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
            assert.deepEqual(manifest.configurations, { minAPI: "1.0.0" });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
}