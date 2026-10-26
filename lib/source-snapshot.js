import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateLocalSourceProof } from './local-source-proof.js';

// Keep this source-relative grammar aligned with ScaffoldSourceIdentity::files/local.
const excludedNames = new Set(['.git', '.local', '.ops', 'vendor', 'node_modules', '.nuxt', '.cache', 'coverage']);
const excludedPaths = ['backups', 'release', 'releases', 'output', 'evidence', 'updates', '.peanut',
    'scaffold/releases', 'server/runtime', 'server/private/installation', 'server/private/resources',
    'server/private/storage', 'server/private/collaboration', 'server/public/uploads', 'server/public/storage',
    'server/public/admin', 'server/public/platform', 'server/public/pc', 'server/public/mobile',
    'server/docker/mysql', 'server/docker/secrets', 'server/docker/tls'];

function physicalPath(candidate) {
    let current = path.resolve(candidate);
    const suffix = [];
    while (true) {
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) fs.realpathSync(current);
        if (fs.existsSync(current)) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        suffix.unshift(path.basename(current));
        current = parent;
    }
    return path.resolve(fs.realpathSync(current), ...suffix);
}

function sourceRelative(root, candidate) {
    const resolved = physicalPath(path.resolve(root, candidate));
    if (resolved === root) throw new Error('SCAFFOLD_SOURCE_OUTPUT_ROOT_CONFLICT');
    return resolved.startsWith(root + path.sep) ? path.relative(root, resolved).split(path.sep).join('/') : null;
}

function configuredExclusions(root, additional = []) {
    const configPath = path.join(root, '.local/toolchain/host.json');
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const result = [];
    for (const key of ['release', 'backups']) {
        const configured = config?.paths?.[key];
        if (typeof configured !== 'string' || configured === '') continue;
        const relative = sourceRelative(root, configured);
        if (relative !== null) result.push(relative);
    }
    for (const value of additional) {
        const relative = sourceRelative(root, value);
        if (relative !== null) result.push(relative);
    }
    return result;
}

function excluded(relative, directory, configured) {
    const name = path.posix.basename(relative);
    if (excludedNames.has(name) || [...excludedPaths, ...configured].some((entry) => relative === entry || relative.startsWith(entry + '/'))) return true;
    if (directory) return name === 'dist';
    const envTemplate = name === '.env.example' || /^\.env\.[A-Za-z0-9_-]+\.example$/.test(name);
    return (!envTemplate && (name === '.env' || name.startsWith('.env.')))
        || /(?:^|\.)secret(?:\.|$)/i.test(name) || ['.DS_Store', 'Thumbs.db'].includes(name)
        || /\.(?:sqlite3?|db|log)$/i.test(name) || relative === 'server/docker/collaboration.env';
}

const releaseVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const sourceSnapshotLimit = 1024 * 1024 * 1024;

function digestFile(file) {
    const bytes = fs.readFileSync(file);
    return createHash('sha256').update(bytes).digest('hex');
}

function ordinaryFile(file, maximumBytes = sourceSnapshotLimit) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.size <= maximumBytes);
}

function ordinaryDirectory(directory) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function safeSourceIdentity(identity) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
    const keys = Object.keys(identity).sort().join(',');
    if (identity.kind === 'local') return keys === 'kind,snapshot_sha256' && sha256Pattern.test(identity.snapshot_sha256 ?? '');
    return identity.kind === 'git' && keys === 'commit,kind,tree'
        && /^[a-f0-9]{40}$/.test(identity.commit ?? '') && /^[a-f0-9]{40}$/.test(identity.tree ?? '');
}

function sameSourceIdentity(left, right) {
    return safeSourceIdentity(left) && safeSourceIdentity(right) && left.kind === right.kind
        && (left.kind === 'local'
            ? left.snapshot_sha256 === right.snapshot_sha256
            : left.commit === right.commit && left.tree === right.tree);
}

function safeManifestPath(value) {
    return typeof value === 'string' && value !== '' && !value.startsWith('/')
        && !/[\x00-\x1f\x7f\\]/.test(value)
        && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function scanPackageFiles(directory, relative = '', files = new Set(), directories = new Set()) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = relative ? relative + '/' + entry.name : entry.name;
        const absolute = path.join(directory, entry.name);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return false;
        if (stat.isDirectory()) {
            directories.add(child);
            if (!scanPackageFiles(absolute, child, files, directories)) return false;
        } else {
            files.add(child);
        }
    }
    return true;
}

function validScaffoldEdition(directory, version, edition) {
    try {
        const packageName = `peanut-scaffold-${edition}`;
        const packagePath = path.join(directory, packageName + '.json');
        const archivePath = path.join(directory, packageName + '.tgz');
        const scaffoldPath = path.join(directory, 'scaffold-manifest.json');
        const buildInputsPath = path.join(directory, 'scaffold-build-inputs.json');
        if (!ordinaryFile(packagePath, 4 * 1024 * 1024) || !ordinaryFile(archivePath)
            || !ordinaryFile(scaffoldPath, 32 * 1024 * 1024)
            || !ordinaryFile(buildInputsPath, 16 * 1024 * 1024)) return false;
        if (!ordinaryDirectory(path.join(directory, 'files'))) return false;

        const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        if (metadata.schema_version !== 1 || metadata.protocol !== 'peanut.template-package.v1'
            || metadata.kind !== 'scaffold-template' || metadata.version !== version || metadata.edition !== edition
            || !['minimal', 'standard', 'full'].includes(metadata.profile)
            || !['none', 'runtime', 'full'].includes(metadata.workflow)
            || metadata.archive?.name !== packageName + '.tgz'
            || !Number.isSafeInteger(metadata.archive?.bytes) || metadata.archive.bytes <= 0
            || !sha256Pattern.test(metadata.archive?.sha256 ?? '')
            || !sha256Pattern.test(metadata.create_manifest_sha256 ?? '')
            || !sha256Pattern.test(metadata.upgrade_tooling_sha256 ?? '')
            || !sha256Pattern.test(metadata.scaffold_manifest_sha256 ?? '')
            || !safeSourceIdentity(metadata.source?.source_identity)
            || !sha256Pattern.test(metadata.source?.inventory_sha256 ?? '')
            || !sha256Pattern.test(metadata.source?.edition_profile_sha256 ?? '')) return false;

        const identity = metadata.source.source_identity;
        const hasSnapshot = fs.existsSync(path.join(directory, 'source-snapshot.json'));
        if (identity.kind === 'local') {
            if (!hasSnapshot || !sha256Pattern.test(metadata.source_snapshot_sha256 ?? '')) return false;
            const snapshotPath = path.join(directory, 'source-snapshot.json');
            if (!ordinaryFile(snapshotPath, 64 * 1024 * 1024) || digestFile(snapshotPath) !== metadata.source_snapshot_sha256) return false;
            const proof = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
            try {
                validateLocalSourceProof(proof, identity, metadata.source.inventory_sha256,
                    metadata.source.edition_profile_sha256, version, () => { throw new Error('invalid source proof'); });
            } catch {
                return false;
            }
        } else if (hasSnapshot || (metadata.source_snapshot_sha256 !== null && metadata.source_snapshot_sha256 !== undefined)) {
            return false;
        }

        const manifestBytes = fs.readFileSync(scaffoldPath);
        if (digestFile(scaffoldPath) !== metadata.scaffold_manifest_sha256) return false;
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        if (!([['peanut.scaffold-release.v3', 3], ['peanut.scaffold-release.v4', 4]]
            .some(([protocol, schema]) => manifest.protocol === protocol && manifest.schema_version === schema))
            || manifest.release?.version !== version || manifest.edition?.name !== edition
            || !sameSourceIdentity(manifest.release?.source_identity, identity)
            || manifest.release?.inventory_sha256 !== metadata.source.inventory_sha256
            || manifest.edition?.source_sha256 !== metadata.source.edition_profile_sha256
            || !Array.isArray(manifest.files) || manifest.files.length > 100000) return false;

        if (fs.statSync(archivePath).size !== metadata.archive.bytes || digestFile(archivePath) !== metadata.archive.sha256) return false;

        const buildInputs = JSON.parse(fs.readFileSync(buildInputsPath, 'utf8'));
        if (buildInputs.protocol !== 'peanut.scaffold-build-inputs.v1'
            || !sha256Pattern.test(buildInputs.payload_sha256 ?? '')
            || !sameSourceIdentity(buildInputs.source?.source_identity, identity)
            || buildInputs.source?.inventory_sha256 !== metadata.source.inventory_sha256
            || buildInputs.source?.edition_profile_sha256 !== metadata.source.edition_profile_sha256
            || !buildInputs.artifacts || Object.keys(buildInputs.artifacts).sort().join(',')
                !== [packageName + '.json', packageName + '.tgz', 'scaffold-manifest.json'].sort().join(',')) return false;
        for (const [name, file] of [[packageName + '.json', packagePath], [packageName + '.tgz', archivePath], ['scaffold-manifest.json', scaffoldPath]]) {
            const artifact = buildInputs.artifacts[name];
            const stat = fs.statSync(file);
            if (artifact?.bytes !== stat.size || artifact.sha256 !== digestFile(file)) return false;
        }

        const expectedFiles = new Set();
        const expectedDirectories = new Set();
        let totalBytes = 0;
        for (const row of manifest.files) {
            if (!row || !safeManifestPath(row.path) || row.source !== 'files/' + row.path
                || !sha256Pattern.test(row.template_sha256 ?? '') || ![0o644, 0o755].includes(row.mode)
                || expectedFiles.has(row.path)) return false;
            expectedFiles.add(row.path);
            const parts = row.path.split('/');
            for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'));
            const file = path.join(directory, 'files', ...parts);
            let parent = path.join(directory, 'files');
            for (const part of parts) {
                parent = path.join(parent, part);
                const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
                if (!stat || stat.isSymbolicLink()) return false;
                if (parent !== file && !stat.isDirectory()) return false;
            }
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || (stat.mode & 0o777) !== row.mode) return false;
            totalBytes += stat.size;
            if (totalBytes > sourceSnapshotLimit || digestFile(file) !== row.template_sha256) return false;
        }
        const actualFiles = new Set();
        const actualDirectories = new Set();
        if (!scanPackageFiles(path.join(directory, 'files'), '', actualFiles, actualDirectories)
            || actualFiles.size !== expectedFiles.size || actualDirectories.size !== expectedDirectories.size
            || [...expectedFiles].some(file => !actualFiles.has(file))
            || [...expectedDirectories].some(item => !actualDirectories.has(item))) return false;

        const expectedTopLevel = [packageName + '.json', packageName + '.tgz', 'scaffold-build-inputs.json',
            'scaffold-manifest.json', 'files', ...(identity.kind === 'local' ? ['source-snapshot.json'] : [])].sort();
        return fs.readdirSync(directory).sort().join('\0') === expectedTopLevel.join('\0');
    } catch {
        return false;
    }
}

function validScaffoldReleaseRoot(directory) {
    try {
        if (!ordinaryDirectory(directory)) return false;
        const versions = fs.readdirSync(directory, { withFileTypes: true });
        if (versions.length === 0) return false;
        for (const versionEntry of versions) {
            if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink() || !releaseVersionPattern.test(versionEntry.name)) return false;
            const versionDirectory = path.join(directory, versionEntry.name);
            const editions = fs.readdirSync(versionDirectory, { withFileTypes: true });
            if (editions.length === 0) return false;
            for (const editionEntry of editions) {
                if (!editionEntry.isDirectory() || editionEntry.isSymbolicLink()
                    || !['standalone', 'multi-tenant'].includes(editionEntry.name)
                    || !validScaffoldEdition(path.join(versionDirectory, editionEntry.name), versionEntry.name, editionEntry.name)) return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

function collect(root, destination, additionalExclusions = []) {
    const rootReal = fs.realpathSync(root);
    if (!fs.statSync(rootReal).isDirectory()) throw new Error('SCAFFOLD_SOURCE_SNAPSHOT_INVALID');
    const rows = [];
    const configured = configuredExclusions(rootReal, additionalExclusions);
    const visit = (source, relative = '') => {
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            const child = relative ? relative + '/' + entry.name : entry.name;
            if (/[\x00-\x1f\x7f\\]/.test(child)) throw new Error('SCAFFOLD_SOURCE_SNAPSHOT_PATH_INVALID');
            const sourcePath = path.join(source, entry.name);
            const stat = fs.lstatSync(sourcePath);
            if (stat.isDirectory() && !stat.isSymbolicLink() && validScaffoldReleaseRoot(sourcePath)) continue;
            if (excluded(child, stat.isDirectory(), configured)) continue;
            if (stat.isSymbolicLink()) throw new Error('SCAFFOLD_SOURCE_SNAPSHOT_SYMLINK: ' + child);
            if (stat.isDirectory()) { visit(sourcePath, child); continue; }
            if (!stat.isFile()) throw new Error('SCAFFOLD_SOURCE_SNAPSHOT_TYPE_INVALID: ' + child);
            const bytes = fs.readFileSync(sourcePath);
            const mode = (stat.mode & 0o111) !== 0 ? 0o755 : 0o644;
            if (destination) {
                const target = path.join(destination, child);
                fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
                fs.writeFileSync(target, bytes, { flag: 'wx', mode });
                fs.chmodSync(target, mode);
            }
            rows.push(child + '\0' + mode.toString(8) + '\0' + createHash('sha256').update(bytes).digest('hex') + '\n');
        }
    };
    visit(rootReal);
    rows.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return createHash('sha256').update(rows.join('')).digest('hex');
}

export function snapshotSource(root, destination, options = {}) {
    const resolved = path.resolve(destination);
    const source = fs.realpathSync(root);
    if (resolved === source || resolved.startsWith(source + path.sep)) throw new Error('SCAFFOLD_SOURCE_SNAPSHOT_TARGET_INSIDE_SOURCE');
    fs.mkdirSync(resolved, { recursive: false, mode: 0o700 });
    const excludedPaths = options?.excludedPaths ?? [];
    if (!Array.isArray(excludedPaths) || excludedPaths.some(value => typeof value !== 'string')) {
        throw new Error('SCAFFOLD_SOURCE_EXCLUSIONS_INVALID');
    }
    return collect(source, resolved, excludedPaths);
}

export function sourceSnapshotDigest(root) { return collect(root); }
