import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('text-to-slug');
export const mount = tool.mount;
export const unmount = tool.unmount;
