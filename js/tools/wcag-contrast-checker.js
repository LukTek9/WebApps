import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('wcag-contrast-checker');
export const mount = tool.mount;
export const unmount = tool.unmount;
