import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('rsa-key-generator');
export const mount = tool.mount;
export const unmount = tool.unmount;
