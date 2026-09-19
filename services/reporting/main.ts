import {reportingService,dispatchReports,recoverReports} from './handler.ts';
import {startOwner} from '../shared/runtime.ts';
await startOwner('reporting',d=>({...reportingService(d),dispatch:enqueue=>dispatchReports(d,enqueue),recover:()=>recoverReports(d)}));
