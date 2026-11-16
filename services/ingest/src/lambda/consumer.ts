import { createRuntimeLoader } from './runtime.js';
import { makeConsumerEntry } from './consumerEntry.js';

export const handler = makeConsumerEntry(createRuntimeLoader());
