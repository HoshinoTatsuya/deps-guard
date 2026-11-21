// The same as the CLI, from code: check, render, exit code; and refreshing the
// committed registry metadata cache.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DepsGuard, EXIT_CODE, type PackageMetadata } from '@hoshinotatsuya/deps-guard';

export function runGate(root: string): number {
  const report = DepsGuard.check({ root, baseRef: 'origin/main' });
  process.stdout.write(DepsGuard.render('text', report));
  writeFileSync(join(root, 'deps-guard.sarif'), DepsGuard.render('sarif', report));
  const code = DepsGuard.exitCode(report);
  if (code === EXIT_CODE.unverified) {
    // Nothing is violated, but something could not be checked: this is not green.
    const unverified = report.findings.filter((finding) => finding.verdict === 'unverified');
    console.error(`not verified: ${unverified.map((finding) => finding.subject).join(', ')}`);
  }
  return code; // 0 clean, 1 findings, 2 not verified
}

export async function refreshMetadata(root: string): Promise<Record<string, PackageMetadata>> {
  const lockfile = DepsGuard.readLockfile(root);
  const { metadata, errors } = await DepsGuard.fetchMetadata({
    registry: 'https://registry.npmjs.org/',
    packages: lockfile.packages,
    timeoutMs: 15_000,
  });
  if (errors.length > 0) {
    throw new Error(`metadata not fetched for ${errors.length} packages: ${errors.join('; ')}`);
  }
  return metadata;
}
