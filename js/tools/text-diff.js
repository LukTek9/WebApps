import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('text-diff');
export const mount = tool.mount;
export const unmount = tool.unmount;
