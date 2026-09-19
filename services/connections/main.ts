import {connectionsService} from './handler.ts';
import {startOwner} from '../shared/runtime.ts';
await startOwner('connections',d=>({handler:connectionsService(d)}));
