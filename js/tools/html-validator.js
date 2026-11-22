import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('html-validator');
export const mount = tool.mount;
export const unmount = tool.unmount;
