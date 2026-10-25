import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { relativePath, sha256 } from './protocol.js';

/** Validate the canonical local source proof shared by packaging and source collection. */
export function validateLocalSourceProof(proof, sourceIdentity, inventorySha256, editionProfileSha256, templateVersion, fail) {
    const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (proof.protocol !== 'peanut.local-source-snapshot.v1' || !isDeepStrictEqual(proof.source_identity, sourceIdentity)
        || sourceIdentity.kind !== 'local' || !Array.isArray(proof.files) || proof.files.length > 100000
        || !Array.isArray(proof.payload_files)) fail('SOURCE_SNAPSHOT_INVALID');
    let previous = null;
    const rows = new Map();
    const hash = createHash('sha256');
    for (const row of proof.files) {
        relativePath(row.path);
        if (Buffer.byteLength(row.path) > 4096 || /[\x00-\x1f\x7f]/.test(row.path) || ![0o644, 0o755].includes(row.mode)
            || !digest(row.sha256) || (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(row.path)) >= 0)) {
            fail('SOURCE_SNAPSHOT_INVALID');
        }
        previous = row.path;
        rows.set(row.path, row);
        hash.update(row.path + '\0' + row.mode.toString(8) + '\0' + row.sha256 + '\n');
    }
    if (hash.digest('hex') !== sourceIdentity.snapshot_sha256) fail('SOURCE_SNAPSHOT_CHANGED');
    const input = (key, relative, expectedDigest) => {
        if (typeof proof[key] !== 'string' || proof[key].length > 16 * 1024 * 1024) fail('SOURCE_SNAPSHOT_INVALID');
        const bytes = Buffer.from(proof[key], 'base64');
        if (bytes.toString('base64') !== proof[key] || sha256(bytes) !== rows.get(relative)?.sha256
            || sha256(bytes) !== expectedDigest) fail('SOURCE_SNAPSHOT_INPUT_CHANGED');
        try { return JSON.parse(bytes.toString('utf8')); } catch { return fail('SOURCE_SNAPSHOT_INVALID'); }
    };
    const inventory = input('inventory_base64', 'scaffold/application-template-inventory.json', inventorySha256);
    const editionProfiles = input('edition_profile_base64', 'scaffold/edition-profiles.json', editionProfileSha256);
    if (inventory.protocol !== 'peanut.create-app-inventory.v2' || inventory.template_version !== templateVersion
        || !Array.isArray(inventory.files)) fail('SOURCE_SNAPSHOT_INVENTORY_INVALID');
    const seen = new Set();
    for (const entry of inventory.files) {
        relativePath(entry.path);
        relativePath(entry.target);
        if (seen.has(entry.path)) fail('SOURCE_SNAPSHOT_INVENTORY_INVALID');
        seen.add(entry.path);
        if (entry.classification === 'excluded') continue;
        const row = rows.get(entry.path);
        const semantic = !entry.path.startsWith('server/resources/scaffold-application/')
            && ['changelog', 'release-metadata', 'resources', 'readme', 'docs-page', 'version-contract'].includes(entry.transform);
        const expected = semantic ? sha256('peanut.create-app-semantic-source.v1\0' + entry.path + '\0' + entry.transform) : row?.sha256;
        if (!row || row.mode !== entry.mode || expected !== entry.source_sha256) fail('SOURCE_SNAPSHOT_INVENTORY_CHANGED');
    }
    return { inventory, editionProfiles, payloadFiles: proof.payload_files };
}
