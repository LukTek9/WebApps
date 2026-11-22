import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('code-formatter');
export const mount = tool.mount;
export const unmount = tool.unmount;
