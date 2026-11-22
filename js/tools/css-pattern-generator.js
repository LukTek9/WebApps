import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('css-pattern-generator');
export const mount = tool.mount;
export const unmount = tool.unmount;
