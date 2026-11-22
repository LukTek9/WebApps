import { createToolModule } from './tool-runtime.js';
const tool = createToolModule('pomodoro-timer');
export const mount = tool.mount;
export const unmount = tool.unmount;
