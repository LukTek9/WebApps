import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('rule-of-three');
export const mount = tool.mount;
export const unmount = tool.unmount;
