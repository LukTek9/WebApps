import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('aes-encryptor');
export const mount = tool.mount;
export const unmount = tool.unmount;
