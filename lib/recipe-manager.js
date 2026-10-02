import fs from 'node:fs';
import path from 'node:path';
import {
    ensureDirectory, existingFileWithin, fail, projectPath, readJsonObject,
    relativePath, sameJson, sha256, sha256File, validateApplicationManifest, validateSemver,
} from './protocol.js';

export class RecipeManager {
    constructor(toolRoot) { this.toolRoot = toolRoot; }

    catalog() {
        const catalog = readJsonObject(path.join(this.toolRoot, 'recipes/catalog.json'));
        if (catalog.protocol !== 'peanut.recipe-catalog.v1' || catalog.schema_version !== 1
            || catalog.recipes === null || typeof catalog.recipes !== 'object' || Array.isArray(catalog.recipes)) {
            fail('RECIPE_CATALOG_INVALID');
        }
        return catalog.recipes;
    }

    application(root) { return validateApplicationManifest(root); }

    id(id) {
        if (typeof id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) fail('RECIPE_ID_INVALID');
    }

    validateManifest(manifest, id) {
        if (manifest.protocol !== 'peanut.recipe.v1' || manifest.schema_version !== 1
            || manifest.recipe !== id || typeof manifest.version !== 'string'
            || !Array.isArray(manifest.files) || manifest.files.length === 0) {
            fail('RECIPE_MANIFEST_INVALID');
        }
        validateSemver(manifest.version);
        const seen = new Set();
        for (const entry of manifest.files) {
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.path !== 'string') {
                fail('RECIPE_FILE_INVALID');
            }
            relativePath(entry.path);
            if (!entry.path.startsWith('.github/workflows/') || !entry.path.endsWith('.yml')
                || entry.owner !== `recipe:${id}` || entry.classification !== 'managed'
                || entry.mode !== 0o644 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
                || seen.has(entry.path)) {
                fail('RECIPE_FILE_INVALID');
            }
            seen.add(entry.path);
        }
    }

    status(root, id) {
        this.id(id);
        const base = `.peanut/recipes/${id}`;
        const pending = projectPath(root, `.peanut/recipes/.${id}.installing`);
        if (fs.existsSync(pending)) return { recipe: id, status: 'recovery_required' };

        const directory = projectPath(root, base);
        if (!fs.existsSync(directory)) return { recipe: id, status: 'not_installed' };

        const manifestPath = projectPath(root, `${base}/manifest.json`);
        existingFileWithin(root, manifestPath, 'RECIPE_STATE_INVALID');
        const state = readJsonObject(manifestPath);
        if (state.protocol !== 'peanut.recipe-installation.v1' || state.schema_version !== 1
            || state.recipe !== id || state.manifest === null || typeof state.manifest !== 'object'
            || Array.isArray(state.manifest)) {
            fail('RECIPE_STATE_INVALID');
        }
        const manifest = state.manifest;
        this.validateManifest(manifest, id);

        const sourceManifest = projectPath(root, `${base}/source-manifest.json`);
        existingFileWithin(root, sourceManifest, 'RECIPE_STATE_INVALID');
        if (typeof state.manifest_sha256 !== 'string'
            || state.manifest_sha256 !== sha256File(sourceManifest)
            || !sameJson(readJsonObject(sourceManifest), manifest)) {
            fail('RECIPE_MANIFEST_DIGEST_MISMATCH');
        }

        const files = [];
        for (const entry of manifest.files) {
            const baseline = projectPath(root, `${base}/baseline/files/${entry.path}`);
            existingFileWithin(root, baseline, 'RECIPE_BASELINE_INVALID');
            if (entry.sha256 !== sha256File(baseline)) {
                fail(`RECIPE_BASELINE_DIGEST_MISMATCH: ${entry.path}`);
            }
            const target = projectPath(root, entry.path);
            let status = fs.existsSync(target) ? 'modified' : 'missing';
            if (fs.existsSync(target)) {
                existingFileWithin(root, target, 'RECIPE_TARGET_INVALID');
                if (entry.sha256 === sha256File(target) && (fs.statSync(target).mode & 0o777) === entry.mode) {
                    status = 'unchanged';
                }
            }
            files.push({ path: entry.path, owner: entry.owner, status });
        }
        return {
            recipe: id, version: manifest.version, status: 'installed',
            manifest_sha256: state.manifest_sha256 ?? null, files,
        };
    }

    preflight(root, app, manifest) {
        for (const entry of manifest.files) {
            for (const owned of app.files) {
                if (owned?.path === entry.path) fail(`RECIPE_OWNERSHIP_CONFLICT: ${entry.path}`);
            }
            if (fs.existsSync(projectPath(root, entry.path))) fail(`RECIPE_PATH_CONFLICT: ${entry.path}`);
        }
    }

    write(root, relative, content, mode) {
        const target = projectPath(root, relative);
        ensureDirectory(path.dirname(target));
        const checked = projectPath(root, relative);
        let fd = null;
        let created = false;
        try {
            fd = fs.openSync(checked, 'wx', mode);
            created = true;
            fs.writeFileSync(fd, content);
            fs.fsyncSync(fd);
            fs.fchmodSync(fd, mode);
        } catch (error) {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch {}
                fd = null;
            }
            if (created) {
                try {
                    const stat = fs.lstatSync(checked);
                    if (!stat.isFile() || stat.isSymbolicLink()) fail('RECIPE_RECOVERY_REQUIRED');
                    fs.unlinkSync(checked);
                } catch (cleanupError) {
                    if (cleanupError?.message === 'RECIPE_RECOVERY_REQUIRED') throw cleanupError;
                    fail('RECIPE_RECOVERY_REQUIRED');
                }
            }
            if (error?.code === 'EEXIST') fail(`RECIPE_EXCLUSIVE_WRITE_FAILED: ${relative}`);
            throw error;
        } finally {
            if (fd !== null) fs.closeSync(fd);
        }
    }

    removeStage(stage) {
        if (!fs.existsSync(stage)) return;
        for (const name of fs.readdirSync(stage)) {
            const child = projectPath(stage, name);
            const stat = fs.lstatSync(child);
            if (stat.isDirectory()) this.removeStage(child);
            else if (stat.isSymbolicLink()) fail('RECIPE_RECOVERY_REQUIRED');
            else fs.unlinkSync(child);
        }
        fs.rmdirSync(stage);
    }

    add(root, id) {
        this.id(id);
        const app = this.application(root);
        const existing = this.status(root, id);
        if (existing.status === 'installed') return existing;
        if (existing.status !== 'not_installed') fail('RECIPE_RECOVERY_REQUIRED');

        const catalog = this.catalog();
        const version = catalog[id];
        if (typeof version !== 'string') fail(`RECIPE_UNKNOWN: ${id}`);
        validateSemver(version);

        const bundle = projectPath(this.toolRoot, `recipes/${id}/${version}`);
        const sourceManifest = projectPath(bundle, 'manifest.json');
        existingFileWithin(bundle, sourceManifest, 'RECIPE_MANIFEST_INVALID');
        const manifest = readJsonObject(sourceManifest);
        this.validateManifest(manifest, id);
        if (manifest.version !== version) fail('RECIPE_VERSION_MISMATCH');

        const contents = new Map();
        for (const entry of manifest.files) {
            const source = projectPath(bundle, `files/${entry.path}`);
            existingFileWithin(bundle, source, 'RECIPE_SOURCE_INVALID');
            const raw = fs.readFileSync(source);
            if (entry.sha256 !== sha256(raw)) fail(`RECIPE_SOURCE_DIGEST_MISMATCH: ${entry.path}`);
            contents.set(entry.path, raw);
        }

        this.preflight(root, app, manifest);
        ensureDirectory(projectPath(root, '.peanut/recipes'));
        const stage = projectPath(root, `.peanut/recipes/.${id}.installing`);
        const destination = projectPath(root, `.peanut/recipes/${id}`);
        try {
            fs.mkdirSync(stage, { mode: 0o775 });
        } catch {
            fail('RECIPE_INSTALL_LOCKED');
        }

        const created = [];
        try {
            this.preflight(root, app, manifest);
            const state = {
                schema_version: 1, protocol: 'peanut.recipe-installation.v1', recipe: id,
                manifest_sha256: sha256File(sourceManifest), manifest,
            };
            this.write(stage, 'manifest.json', JSON.stringify(state, null, 4) + '\n', 0o644);
            this.write(stage, 'source-manifest.json', fs.readFileSync(sourceManifest), 0o644);
            for (const entry of manifest.files) {
                this.write(stage, `baseline/files/${entry.path}`, contents.get(entry.path), entry.mode);
            }
            for (const entry of manifest.files) {
                this.write(root, entry.path, contents.get(entry.path), entry.mode);
                created.push(entry);
            }
            if (fs.existsSync(destination)) fail('RECIPE_STATE_COMMIT_FAILED');
            fs.renameSync(stage, destination);
        } catch (error) {
            for (const entry of created) {
                try {
                    const target = projectPath(root, entry.path);
                    if (!fs.existsSync(target) || !fs.statSync(target).isFile()
                        || entry.sha256 !== sha256File(target)) {
                        fail('RECIPE_RECOVERY_REQUIRED');
                    }
                    fs.unlinkSync(target);
                } catch {
                    fail('RECIPE_RECOVERY_REQUIRED');
                }
            }
            if (error?.message !== 'RECIPE_RECOVERY_REQUIRED') {
                try { this.removeStage(stage); } catch { fail('RECIPE_RECOVERY_REQUIRED'); }
            }
            throw error;
        }
        return this.status(root, id);
    }
}
