import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('text-cleaner');
export const mount = tool.mount;
export const unmount = tool.unmount;
