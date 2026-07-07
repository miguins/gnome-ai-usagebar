import {runTests} from './harness.js';

import './usageState.test.js';
import './usageThresholds.test.js';
import './cache.test.js';
import './vendorFormat.test.js';
import './vendorUsage.test.js';
import './vendorHttp.test.js';
import './credentialStore.test.js';
import './vendorCredentials.test.js';
import './refresh.test.js';

await runTests();
