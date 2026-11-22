import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('seo-meta-generator');
export const mount = tool.mount;
export const unmount = tool.unmount;
