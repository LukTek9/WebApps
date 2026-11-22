import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('loan-calculator');
export const mount = tool.mount;
export const unmount = tool.unmount;
