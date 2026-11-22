import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('text-reverser');
export const mount = tool.mount;
export const unmount = tool.unmount;
