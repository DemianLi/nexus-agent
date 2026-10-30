import { pack } from '/w/scripts/release/pack.ts';
console.log(pack({ out: '/out', commit: '<commit>', spawner: '/w/.spawner-bundle' }));
