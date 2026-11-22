import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('base-ascii-converter');
export const mount = tool.mount;
export const unmount = tool.unmount;
