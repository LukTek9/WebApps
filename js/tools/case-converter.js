import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('case-converter');
export const mount = tool.mount;
export const unmount = tool.unmount;
