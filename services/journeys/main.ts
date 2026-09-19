import {journeyService} from './handler.ts';
import {startOwner} from '../shared/runtime.ts';
await startOwner('journeys',d=>journeyService(d));
