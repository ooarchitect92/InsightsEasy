import {identityService} from './handler.ts';
import {startOwner} from '../shared/runtime.ts';
await startOwner('identity',d=>({handler:identityService(d)}));
