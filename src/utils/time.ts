/**
 * 时间工具模块 - 统一的时间处理
 * 
 * 原则：
 * 1. 后端存储 UTC，前端显示时转换为用户时区
 * 2. 如果未配置用户时区，使用浏览器时区
 */

/**
 * 解析 ISO 时间戳
 * 支持带 Z 后缀和不带时区的格式
 */
export function parseISO(timestamp: string): Date {
  if (!timestamp) {
    throw new Error('Empty timestamp');
  }
  
  // 如果没有时区信息，假设是 UTC
  let ts = timestamp.trim();
  if (!ts.endsWith('Z') && !ts.includes('+') && !ts.includes('-', 10)) {
    ts += 'Z';
  }
  
  return new Date(ts);
}

/**
 * 格式化时间用于显示
 * 
 * @param timestamp - ISO 格式时间戳或 Date 对象
 * @param userTimezone - 用户时区，如 'Asia/Shanghai'。如果不提供，使用浏览器时区
 * @param options - Intl.DateTimeFormat 选项
 */
export function formatTime(
  timestamp: string | Date,
  userTimezone?: string,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false }
): string {
  const date = typeof timestamp === 'string' ? parseISO(timestamp) : timestamp;
  
  const formatOptions: Intl.DateTimeFormatOptions = {
    ...options,
    timeZone: userTimezone,
  };
  
  return date.toLocaleTimeString('zh-CN', formatOptions);
}

/**
 * 格式化日期时间用于显示
 */
export function formatDateTime(
  timestamp: string | Date,
  userTimezone?: string,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }
): string {
  const date = typeof timestamp === 'string' ? parseISO(timestamp) : timestamp;
  
  const formatOptions: Intl.DateTimeFormatOptions = {
    ...options,
    timeZone: userTimezone,
  };
  
  return date.toLocaleString('zh-CN', formatOptions);
}

/**
 * 格式化为相对时间（如 "5分钟前"）
 */
export function formatRelative(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? parseISO(timestamp) : timestamp;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.abs(Math.floor(diffMs / 1000));
  
  if (diffSeconds < 60) {
    return diffMs >= 0 ? `${diffSeconds}秒前` : `${diffSeconds}秒后`;
  }
  
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return diffMs >= 0 ? `${diffMinutes}分钟前` : `${diffMinutes}分钟后`;
  }
  
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return diffMs >= 0 ? `${diffHours}小时前` : `${diffHours}小时后`;
  }
  
  const diffDays = Math.floor(diffHours / 24);
  return diffMs >= 0 ? `${diffDays}天前` : `${diffDays}天后`;
}

/**
 * 获取当前 UTC 时间的 ISO 字符串（带 Z 后缀）
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * 常用时区列表
 */
export const COMMON_TIMEZONES = [
  { value: 'Asia/Shanghai', label: '中国标准时间 (UTC+8)' },
  { value: 'Asia/Tokyo', label: '日本标准时间 (UTC+9)' },
  { value: 'Asia/Singapore', label: '新加坡时间 (UTC+8)' },
  { value: 'America/New_York', label: '美国东部时间' },
  { value: 'America/Los_Angeles', label: '美国太平洋时间' },
  { value: 'Europe/London', label: '英国时间' },
  { value: 'Europe/Paris', label: '中欧时间' },
  { value: 'UTC', label: 'UTC' },
];

/**
 * 获取浏览器时区
 */
export function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
