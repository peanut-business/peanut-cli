import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const WEB_PACKAGES = [
    '@peanut-admin/client', '@peanut-admin/vue', '@peanut-admin/ui-vue',
    '@peanut-admin/nuxt', '@peanut-admin/uniapp', '@peanut-admin/testing',
];

export function fail(message) { throw new Error(message); }

export function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
    return sha256(fs.readFileSync(file));
}

export function readJsonObject(file) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        fail(`PEANUT_JSON_INVALID: ${error.message}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail('PEANUT_JSON_OBJECT_REQUIRED');
    }
    return value;
}

function numericCompare(left, right) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    return left === right ? 0 : (left < right ? -1 : 1);
}

function parseSemver(version) {
    if (typeof version !== 'string') fail('SEMVER_INVALID');
    const match = SEMVER.exec(version);
    if (!match) fail('SEMVER_INVALID');
    return [match[1], match[2], match[3], match[4] ? match[4].split('.') : null];
}

export function compareSemver(left, right) {
    const a = parseSemver(left);
    const b = parseSemver(right);
    for (let index = 0; index < 3; index += 1) {
        const comparison = numericCompare(a[index], b[index]);
        if (comparison !== 0) return comparison;
    }
    if (a[3] === null || b[3] === null) {
        return a[3] === b[3] ? 0 : (a[3] === null ? 1 : -1);
    }
    const length = Math.max(a[3].length, b[3].length);
    for (let index = 0; index < length; index += 1) {
        if (index >= a[3].length) return -1;
        if (index >= b[3].length) return 1;
        const leftNumeric = /^[0-9]+$/.test(a[3][index]);
        const rightNumeric = /^[0-9]+$/.test(b[3][index]);
        let comparison;
        if (leftNumeric && rightNumeric) comparison = numericCompare(a[3][index], b[3][index]);
        else if (leftNumeric !== rightNumeric) comparison = leftNumeric ? -1 : 1;
        else comparison = a[3][index] === b[3][index] ? 0 : (a[3][index] < b[3][index] ? -1 : 1);
        if (comparison !== 0) return comparison;
    }
    return 0;
}

export function validateSemver(version) {
    compareSemver(version, version);
    return version;
}

export function relativePath(relative) {
    if (typeof relative !== 'string' || relative === '' || relative.includes('\0') || relative.includes('\\')
        || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) {
        fail(`SCAFFOLD_PATH_OUTSIDE_PROJECT: ${relative}`);
    }
    if (relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
        fail(`SCAFFOLD_PATH_OUTSIDE_PROJECT: ${relative}`);
    }
    return relative;
}

export function projectRoot(input) {
    try {
        const root = fs.realpathSync(input);
        if (!fs.statSync(root).isDirectory()) fail(`SCAFFOLD_PROJECT_ROOT_INVALID: ${input}`);
        return root.replace(/[\\/]$/, '');
    } catch (error) {
        if (error?.message?.startsWith('SCAFFOLD_')) throw error;
        fail(`SCAFFOLD_PROJECT_ROOT_INVALID: ${input}`);
    }
}

export function projectPath(root, relative) {
    relativePath(relative);
    let cursor = root;
    for (const segment of relative.split('/')) {
        cursor = path.join(cursor, segment);
        try {
            if (fs.lstatSync(cursor).isSymbolicLink()) {
                fail(`SCAFFOLD_PATH_SYMLINK_REJECTED: ${relative}`);
            }
        } catch (error) {
            if (error?.message?.startsWith('SCAFFOLD_')) throw error;
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    return cursor;
}

export function existingFileWithin(root, candidate, errorCode) {
    const resolvedRoot = fs.realpathSync(root);
    let lstat;
    let resolved;
    try {
        lstat = fs.lstatSync(candidate);
        resolved = fs.realpathSync(candidate);
    } catch {
        fail(`${errorCode}: ${candidate}`);
    }
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
    if (!lstat.isFile() || lstat.isSymbolicLink() || !resolved.startsWith(prefix)) {
        fail(`${errorCode}: ${candidate}`);
    }
    if (fs.statSync(resolved).nlink !== 1) fail(`${errorCode}: ${candidate}`);
    return resolved;
}

export function ensureDirectory(directory) {
    try {
        const stat = fs.lstatSync(directory);
        if (stat.isSymbolicLink()) fail(`SCAFFOLD_PATH_SYMLINK_REJECTED: ${directory}`);
        if (!stat.isDirectory()) fail(`SCAFFOLD_DIRECTORY_CREATE_FAILED: ${directory}`);
        return;
    } catch (error) {
        if (error?.message?.startsWith('SCAFFOLD_')) throw error;
        if (error?.code !== 'ENOENT') throw error;
    }
    try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o775 });
    } catch {
        fail(`SCAFFOLD_DIRECTORY_CREATE_FAILED: ${directory}`);
    }
}

export function validateApplicationManifest(root) {
    const manifestPath = projectPath(root, '.peanut/application-manifest.json');
    existingFileWithin(root, manifestPath, 'APPLICATION_MANIFEST_REQUIRED');
    const app = readJsonObject(manifestPath);
    if (app.protocol !== 'peanut.application-scaffold.v2' || app.schema_version !== 2
        || app.application === null || typeof app.application !== 'object' || Array.isArray(app.application)
        || app.template === null || typeof app.template !== 'object' || Array.isArray(app.template)
        || !Array.isArray(app.files)) {
        fail('APPLICATION_MANIFEST_INVALID');
    }
    for (const key of ['name', 'slug', 'package_identity', 'version', 'edition', 'profile']) {
        if (typeof app.application[key] !== 'string' || app.application[key] === '') {
            fail('APPLICATION_IDENTITY_INVALID');
        }
    }
    validateSemver(app.application.version);
    return app;
}

function exactKeys(object, keys) {
    return object !== null && typeof object === 'object' && !Array.isArray(object)
        && isDeepStrictEqual(Object.keys(object), keys);
}

function httpsUrl(value) {
    if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname !== '' && url.pathname !== ''
            && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
    } catch {
        return false;
    }
}

function fixedVersion(value) {
    return typeof value === 'string' && SEMVER.test(value) && !/(?:^|[.-])dev(?:[.+-]|$)/i.test(value);
}

function integrity(value) {
    if (typeof value !== 'string' || !value.startsWith('sha512-')) return false;
    const encoded = value.slice(7);
    const bytes = Buffer.from(encoded, 'base64');
    return bytes.length === 64 && bytes.toString('base64') === encoded;
}

export function validateReleaseDependencies(php, web) {
    if (!exactKeys(php, ['package', 'constraint', 'resolved_version', 'source_type', 'source_url', 'source_reference'])
        || php.package !== 'peanut-admin/core'
        || typeof php.constraint !== 'string' || typeof php.resolved_version !== 'string'
        || php.source_type !== 'git' || !httpsUrl(php.source_url)
        || typeof php.source_reference !== 'string' || !/^[0-9a-f]{40}$/.test(php.source_reference)) {
        fail('VERSION_CONTRACT_CORE_PHP_INVALID');
    }
    const development = /^dev-[A-Za-z0-9._-]+$/.test(php.constraint) && php.constraint === php.resolved_version;
    const fixed = fixedVersion(php.constraint)
        && php.constraint === (php.resolved_version.startsWith('v') ? php.resolved_version.slice(1) : php.resolved_version);
    if (!development && !fixed) fail('VERSION_CONTRACT_CORE_PHP_INVALID');

    if (!exactKeys(web, ['source_type', 'source_url', 'source_reference', 'packages'])
        || web.source_type !== 'git' || !httpsUrl(web.source_url)
        || typeof web.source_reference !== 'string' || !/^[0-9a-f]{40}$/.test(web.source_reference)
        || !exactKeys(web.packages, WEB_PACKAGES)) {
        fail('VERSION_CONTRACT_CORE_WEB_INVALID');
    }
    let mode = null;
    for (const identity of Object.values(web.packages)) {
        if (identity === null || typeof identity !== 'object' || Array.isArray(identity)
            || typeof identity.version !== 'string' || !SEMVER.test(identity.version)) {
            fail('VERSION_CONTRACT_CORE_WEB_INVALID');
        }
        let current;
        if (isDeepStrictEqual(Object.keys(identity), ['version', 'archive', 'sha256'])) {
            current = 'archive';
            if (typeof identity.archive !== 'string'
                || !/^packages\/core-web\/peanut-admin-[a-z-]+-[0-9A-Za-z.+-]+\.tgz$/.test(identity.archive)
                || typeof identity.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(identity.sha256)) {
                fail('VERSION_CONTRACT_CORE_WEB_INVALID');
            }
        } else if (isDeepStrictEqual(Object.keys(identity), ['version', 'resolved', 'integrity'])) {
            current = 'registry';
            if (!fixedVersion(identity.version) || !httpsUrl(identity.resolved) || !integrity(identity.integrity)) {
                fail('VERSION_CONTRACT_CORE_WEB_INVALID');
            }
        } else {
            fail('VERSION_CONTRACT_CORE_WEB_INVALID');
        }
        if (mode !== null && mode !== current) fail('VERSION_CONTRACT_CORE_WEB_INVALID');
        mode = current;
    }
    if (mode === 'registry' && !fixed) fail('VERSION_CONTRACT_CORE_PHP_INVALID');
    return mode;
}

export function validateReleaseVersions(versions) {
    if (versions.schema_version !== 3 || versions.protocol !== 'peanut.release-versions.v3') {
        fail('VERSION_CONTRACT_INVALID');
    }
    for (const key of ['source_product_version', 'scaffold_template', 'generated_instance_default']) {
        if (typeof versions[key] !== 'string') fail('VERSION_CONTRACT_INVALID');
        validateSemver(versions[key]);
    }
    if (!Object.prototype.hasOwnProperty.call(versions, 'instance_version')) fail('VERSION_CONTRACT_INVALID');
    if (versions.instance_version !== null) {
        if (typeof versions.instance_version !== 'string') fail('VERSION_CONTRACT_INVALID');
        validateSemver(versions.instance_version);
    }
    validateReleaseDependencies(versions.core_php, versions.core_web);
    return versions;
}

export function commandExists(command) {
    return spawnSync(command, ['--version'], { stdio: 'ignore', shell: false }).status === 0;
}

export function phpEnvironmentChecks() {
    const checks = {
        php_8_3: false,
        php_extension_json: false,
        php_extension_mbstring: false,
        php_extension_pdo_mysql: false,
        php_extension_sodium: false,
    };
    const script = 'echo json_encode(["major"=>PHP_MAJOR_VERSION,"minor"=>PHP_MINOR_VERSION,"json"=>extension_loaded("json"),"mbstring"=>extension_loaded("mbstring"),"pdo_mysql"=>extension_loaded("pdo_mysql"),"sodium"=>extension_loaded("sodium")]);';
    const result = spawnSync('php', ['-r', script], { encoding: 'utf8', shell: false });
    if (result.status !== 0) return checks;
    try {
        const data = JSON.parse(result.stdout);
        checks.php_8_3 = data.major === 8 && data.minor === 3;
        for (const extension of ['json', 'mbstring', 'pdo_mysql', 'sodium']) {
            checks[`php_extension_${extension}`] = data[extension] === true;
        }
    } catch {}
    return checks;
}

export function sameJson(left, right) {
    return isDeepStrictEqual(left, right);
}
