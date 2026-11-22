import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('word-counter');
export const mount = tool.mount;
export const unmount = tool.unmount;
