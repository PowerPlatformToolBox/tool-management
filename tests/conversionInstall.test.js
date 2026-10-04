const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

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