import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('lorem-ipsum');
export const mount = tool.mount;
export const unmount = tool.unmount;
