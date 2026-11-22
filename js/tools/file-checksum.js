import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('file-checksum');
export const mount = tool.mount;
export const unmount = tool.unmount;
