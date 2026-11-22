import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('base64-codec');
export const mount = tool.mount;
export const unmount = tool.unmount;
