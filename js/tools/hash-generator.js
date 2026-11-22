import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('hash-generator');
export const mount = tool.mount;
export const unmount = tool.unmount;
