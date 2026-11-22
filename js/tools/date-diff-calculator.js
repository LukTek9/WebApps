import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('date-diff-calculator');
export const mount = tool.mount;
export const unmount = tool.unmount;
