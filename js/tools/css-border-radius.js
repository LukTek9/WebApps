import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('css-border-radius');
export const mount = tool.mount;
export const unmount = tool.unmount;
