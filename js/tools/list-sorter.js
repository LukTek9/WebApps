import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('list-sorter');
export const mount = tool.mount;
export const unmount = tool.unmount;
