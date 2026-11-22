import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('line-numberer');
export const mount = tool.mount;
export const unmount = tool.unmount;
