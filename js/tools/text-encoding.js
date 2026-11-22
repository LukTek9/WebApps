import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('text-encoding');
export const mount = tool.mount;
export const unmount = tool.unmount;
