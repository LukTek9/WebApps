import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('file-splitter');
export const mount = tool.mount;
export const unmount = tool.unmount;
