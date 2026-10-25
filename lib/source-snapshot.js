import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
