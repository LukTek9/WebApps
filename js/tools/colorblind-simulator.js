import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('colorblind-simulator');
export const mount = tool.mount;
export const unmount = tool.unmount;
