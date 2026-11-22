import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('css-js-minifier');
export const mount = tool.mount;
export const unmount = tool.unmount;
