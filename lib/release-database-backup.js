import path from 'node:path';

// Private host configuration; it never belongs to a source snapshot or template.
export function releaseDatabaseBackup(root, configured, options = {}) {
    const supplied = ['releaseDatabaseRegistry', 'releaseDatabaseResource', 'releaseDatabaseSql']
        .some(key => options[key] !== undefined);
    if (options.noReleaseDatabaseBackup) {
        if (supplied) throw new Error('PEANUT_CONFIG_RELEASE_DATABASE_BACKUP_CONFLICT');
        return null;
    }
    if (!configured && !supplied) return null;
    if (configured !== undefined && configured !== null
        && (typeof configured !== 'object' || Array.isArray(configured)
            || Object.keys(configured).some(key => !['registry', 'resource_id', 'output'].includes(key)))) {
        throw new Error('PEANUT_CONFIG_RELEASE_DATABASE_BACKUP_INVALID');
    }
    const result = {
        registry: options.releaseDatabaseRegistry ?? configured?.registry,
        resource_id: options.releaseDatabaseResource ?? configured?.resource_id,
        output: options.releaseDatabaseSql ?? configured?.output,
    };
    if (Object.values(result).some(value => typeof value !== 'string' || !value)
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result.resource_id)) {
        throw new Error('PEANUT_CONFIG_RELEASE_DATABASE_BACKUP_INVALID');
    }
    for (const key of ['registry', 'output']) {
        const value = result[key];
        if (!path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)
            || value === root || value.startsWith(root + path.sep)) {
            throw new Error('PEANUT_CONFIG_RELEASE_DATABASE_BACKUP_PATH_INVALID');
        }
    }
    if (!result.output.endsWith('.sql') || [result.output, result.output + '.json'].includes(result.registry)) {
        throw new Error('PEANUT_CONFIG_RELEASE_DATABASE_BACKUP_PATH_INVALID');
    }
    return result;
}
