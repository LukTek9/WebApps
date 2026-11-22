import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('url-html-codec');
export const mount = tool.mount;
export const unmount = tool.unmount;
