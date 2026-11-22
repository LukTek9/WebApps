import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('password-strength');
export const mount = tool.mount;
export const unmount = tool.unmount;
