import {activationService} from './handler.ts';
import {startOwner} from '../shared/runtime.ts';
await startOwner('activation',d=>activationService(d));
