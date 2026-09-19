import {crmService} from './handler.ts';
import {startOwner} from '../shared/runtime.ts';
await startOwner('crm',d=>crmService(d));
