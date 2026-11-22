import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('totp-generator');
export const mount = tool.mount;
export const unmount = tool.unmount;
