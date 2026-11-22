import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('system-inspector');
export const mount = tool.mount;
export const unmount = tool.unmount;
