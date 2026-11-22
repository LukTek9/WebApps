import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('secure-notepad');
export const mount = tool.mount;
export const unmount = tool.unmount;
