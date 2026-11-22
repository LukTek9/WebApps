import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('typing-speed-test');
export const mount = tool.mount;
export const unmount = tool.unmount;
