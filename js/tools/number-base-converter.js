import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('number-base-converter');
export const mount = tool.mount;
export const unmount = tool.unmount;
