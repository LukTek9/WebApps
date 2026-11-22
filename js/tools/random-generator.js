import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('random-generator');
export const mount = tool.mount;
export const unmount = tool.unmount;
