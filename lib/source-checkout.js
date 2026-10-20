import { spawnSync } from 'node:child_process';

// Retained solely for the existing source-upgrade consumer. create never clones.
export function checkoutSource(source, ref, checkout) {
    const run = (args) => {
        const result = spawnSync('git', args, { encoding: 'utf8', shell: false });
        if (result.error || result.status !== 0) throw new Error(`PEANUT_SOURCE_CHECKOUT_FAILED: ${result.error?.message ?? result.stderr}`);
        return result.stdout.trim();
    };
    run(['clone', '--quiet', '--no-checkout', source, checkout]);
    run(['-C', checkout, 'fetch', '--quiet', 'origin', ref]);
    run(['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    return { commit: run(['-C', checkout, 'rev-parse', 'HEAD']), tree: run(['-C', checkout, 'rev-parse', 'HEAD^{tree}']) };
}
