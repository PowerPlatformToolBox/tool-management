#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function parseJson(input, label) {
	try {
		return JSON.parse(input);
	} catch (error) {
		fail(`Failed to parse ${label} as JSON: ${error.message}`);
	}
}

const [toolId, toolVersion, metadataJsonArg] = process.argv.slice(2);
if (!toolId || !toolVersion) {
	fail('Usage: node buildScripts/updateRegistry.js <toolId> <toolVersion> <toolMetadataJson>');
}

const registryPath = path.resolve(process.cwd(), 'registry.json');

let registry;
if (fs.existsSync(registryPath)) {
	registry = parseJson(fs.readFileSync(registryPath, 'utf8'), 'registry.json');
} else {
	registry = { version: '1.0', tools: [] };
}

if (!registry || typeof registry !== 'object') {
	registry = { version: '1.0', tools: [] };
}
if (!Array.isArray(registry.tools)) {
	registry.tools = [];
}
if (typeof registry.version !== 'string' || registry.version.trim() === '') {
	registry.version = '1.0';
}

const toolMetadata = metadataJsonArg
	? parseJson(metadataJsonArg, 'tool metadata argument')
	: (process.env.TOOL_METADATA_JSON ? parseJson(process.env.TOOL_METADATA_JSON, 'TOOL_METADATA_JSON env var') : null);

const now = new Date().toISOString();
const entry = {
	id: toolId,
	version: toolVersion,
	updated_at: now,
	...(toolMetadata && typeof toolMetadata === 'object' ? toolMetadata : {}),
};

// De-duplicate by (id, version). If existing, replace; otherwise append.
const existingIndex = registry.tools.findIndex(
	(t) => t && typeof t === 'object' && t.id === toolId && t.version === toolVersion,
);

if (existingIndex >= 0) {
	registry.tools[existingIndex] = entry;
} else {
	registry.tools.push(entry);
}

fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
