import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('html-to-markdown');
export const mount = tool.mount;
export const unmount = tool.unmount;
