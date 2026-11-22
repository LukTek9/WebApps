import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('bmi-calculator');
export const mount = tool.mount;
export const unmount = tool.unmount;
