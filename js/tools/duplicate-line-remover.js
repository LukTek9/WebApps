import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('duplicate-line-remover');
export const mount = tool.mount;
export const unmount = tool.unmount;
