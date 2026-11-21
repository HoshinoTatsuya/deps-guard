// The gate inside the project's Jest suite: one test per rule; findings are in
// the failure message, "not verified" is a red test too.
import { join } from 'node:path';

import { depsGuardGate } from '@hoshinotatsuya/deps-guard/jest';

depsGuardGate({ root: join(__dirname, '..') });
