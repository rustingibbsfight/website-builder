import { defineAgent } from 'eve';

// Model must be one the Vercel AI Gateway knows (eve needs context-window
// metadata to compile compaction). Sonnet 5 is the current default here.
export default defineAgent({
  model: 'anthropic/claude-sonnet-5',
});
