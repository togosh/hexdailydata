// Exact R2 entry; imports the maintained owner without launching an old command.
import { runReviewedOperating } from './operating-owner.mjs';
if (process.argv[2] === 'run-reviewed') await runReviewedOperating('r2');
else
  console.log('Offline default: R2 requires reviewed all-slot storage and fresh paired readiness.');
