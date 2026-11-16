import { createRuntimeLoader } from './runtime.js';
import { makeWebhookEntry } from './webhookEntry.js';

export const handler = makeWebhookEntry(createRuntimeLoader());
