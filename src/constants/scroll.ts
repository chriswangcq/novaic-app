/**
 * 滚动相关常量
 * 
 * 已迁移到统一配置文件 (@/config)，此文件保留用于向后兼容
 */

import { UI_CONFIG } from '../config';

// 虚拟列表默认估算高度
export const DEFAULT_ITEM_ESTIMATE_SIZE = UI_CONFIG.VIRTUAL_LIST_ITEM_HEIGHT;

// 虚拟列表默认 overscan 数量
export const DEFAULT_OVERSCAN = UI_CONFIG.DEFAULT_OVERSCAN;

// 判断是否在底部的阈值（px）
export const BOTTOM_THRESHOLD = UI_CONFIG.SCROLL_BOTTOM_THRESHOLD;

// 判断是否在顶部的阈值（px）
export const TOP_THRESHOLD = UI_CONFIG.SCROLL_TOP_THRESHOLD;

// 消息列表估算高度
export const MESSAGE_ESTIMATE_SIZE = UI_CONFIG.MESSAGE_ESTIMATE_SIZE;

// 执行日志估算高度
export const LOG_ESTIMATE_SIZE = UI_CONFIG.LOG_ESTIMATE_SIZE;

// 消息列表 overscan
export const MESSAGE_OVERSCAN = UI_CONFIG.MESSAGE_OVERSCAN;

// 执行日志 overscan
export const LOG_OVERSCAN = UI_CONFIG.LOG_OVERSCAN;
