import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('svg-to-raster');
export const mount = tool.mount;
export const unmount = tool.unmount;
