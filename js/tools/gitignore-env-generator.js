import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('gitignore-env-generator');
export const mount = tool.mount;
export const unmount = tool.unmount;
