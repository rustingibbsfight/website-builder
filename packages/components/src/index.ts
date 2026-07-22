import { chromeDefs } from './defs/chrome.js';
import { compositeDefs } from './defs/composite.js';
import { layoutDefs } from './defs/layout.js';
import { primitiveDefs } from './defs/primitives.js';
import { widgetDefs } from './defs/widgets.js';
import { register } from './registry.js';

for (const def of [...layoutDefs, ...primitiveDefs, ...chromeDefs, ...compositeDefs, ...widgetDefs]) {
  register(def);
}

export * from './registry.js';
export * from './html.js';
export { renderMarkdown } from './markdown.js';
export { BASE_CSS, VIDEO_FACADE_JS } from './css/base.js';
