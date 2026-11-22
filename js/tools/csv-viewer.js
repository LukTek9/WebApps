import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('csv-viewer');
export const mount = tool.mount;
export const unmount = tool.unmount;
