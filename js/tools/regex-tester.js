import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('regex-tester');
export const mount = tool.mount;
export const unmount = tool.unmount;
