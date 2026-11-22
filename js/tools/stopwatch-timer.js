import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('stopwatch-timer');
export const mount = tool.mount;
export const unmount = tool.unmount;
