import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('exif-reader');
export const mount = tool.mount;
export const unmount = tool.unmount;
