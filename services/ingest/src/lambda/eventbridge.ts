import { createRuntimeLoader } from './runtime.js';
import { makeEventBridgeEntry } from './eventbridgeEntry.js';

export const handler = makeEventBridgeEntry(createRuntimeLoader());
