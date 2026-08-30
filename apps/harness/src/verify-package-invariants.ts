/**
 * 命令列入口：把 {@link ./package-invariants.ts | 結構規則} 跑一遍。
 *
 * 規則全部在那個模組裡，這裡只負責印與 exit code——同一組規則另外由
 * `package-invariants.test.ts` 在 CI 的 `pnpm -r run test` 裡跑，所以 CI **不需要**
 * 多一個 step。這支存在是為了本機一句話問「現在合不合格」。
 *
 * @module
 */

import {
  collectPackageInvariantViolations,
  formatPackageInvariantViolation,
  packageInvariantOwners,
  repositoryRoot,
} from './package-invariants.js';

const root = repositoryRoot();
const violations = collectPackageInvariantViolations(root);

if (violations.length > 0) {
  console.error('verify-package-invariants：發現違規');
  for (const violation of violations) {
    console.error(`  ${formatPackageInvariantViolation(violation)}`);
  }
  process.exit(1);
}

console.log(
  `verify-package-invariants：${packageInvariantOwners(root).length} 個配套入口全部合格。`,
);
