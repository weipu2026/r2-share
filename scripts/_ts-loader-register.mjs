/**
 * 注册 _ts-loader.mjs 的解析钩子。
 * 用法：node --import ./scripts/_ts-loader-register.mjs scripts/test-routes.mjs
 */
import { register } from 'node:module';

register('./_ts-loader.mjs', import.meta.url);
