import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('jwt-decoder');
export const mount = tool.mount;
export const unmount = tool.unmount;
