/**
 * Log Formatters - 日志格式化工具模块
 * 
 * 从 ExecutionLog.tsx 提取的格式化函数，用于处理日志数据的提取和格式化
 */

import type { LogEntry } from '../types';

/**
 * 格式化后的日志信息
 */
export interface FormattedLog {
  main: string;
  detail?: string;
  toolName?: string;
  status?: string;
  isRunning?: boolean;
}

/**
 * 格式化 JSON 数据用于显示
 * 
 * @param data - 要格式化的数据
 * @param indent - JSON 缩进空格数，默认 2
 * @returns 格式化后的 JSON 字符串
 */
export function formatJsonForDisplay(data: unknown, indent = 2): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, indent);
  } catch {
    return String(data);
  }
}

/**
 * 截断字符串
 * 
 * @param str - 要截断的字符串
 * @param maxLength - 最大长度
 * @returns 截断后的字符串（如果超过长度会添加 "..."）
 */
export function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

/**
 * 提取 input 数据
 * 
 * 从日志条目中提取输入参数，支持多种数据格式
 * 
 * @param log - 日志条目
 * @returns 输入数据，如果不存在则返回 null
 */
export function getInputData(log: LogEntry): unknown {
  if (log.input) return log.input;
  if (log.data?.input) return log.data.input;
  if (log.data?.args) return log.data.args;
  return null;
}

/**
 * 提取 result 数据
 * 
 * 从日志条目中提取执行结果，支持多种数据格式
 * 
 * @param log - 日志条目
 * @returns 结果数据，如果不存在则返回 null
 */
export function getResultData(log: LogEntry): unknown {
  if (log.result) return log.result;
  if (log.data?.result) return log.data.result;
  return null;
}

/**
 * 提取思考内容
 * 
 * 从日志条目中提取思考过程的文本内容
 * 
 * @param log - 日志条目
 * @returns 思考内容字符串，如果不存在则返回空字符串
 */
export function getThinkingContent(log: LogEntry): string {
  if (log.result?.content && typeof log.result.content === 'string') return log.result.content;
  if (log.data?.content && typeof log.data.content === 'string') return log.data.content;
  if (typeof log.data === 'string') return log.data;
  return '';
}

/**
 * 提取错误信息
 * 
 * 从日志条目中提取错误信息，支持多种错误数据格式
 * 
 * @param log - 日志条目
 * @returns 错误信息字符串，如果不存在则返回 null
 */
export function getErrorInfo(log: LogEntry): string | null {
  if (log.result?.error && typeof log.result.error === 'string') return log.result.error;
  if (log.data?.error && typeof log.data.error === 'string') return log.data.error;
  if (log.data?.result && typeof log.data.result === 'object' && log.data.result !== null) {
    const resultObj = log.data.result as Record<string, unknown>;
    if (resultObj.error && typeof resultObj.error === 'string') {
      return resultObj.error;
    }
  }
  return null;
}

/**
 * 获取参数摘要（用于默认显示）
 * 
 * 从输入对象中提取前两个参数的摘要信息
 * 
 * @param input - 输入参数对象
 * @returns 参数摘要字符串
 */
function getParamsSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const inputObj = input as Record<string, unknown>;
  const keys = Object.keys(inputObj);
  if (keys.length === 0) return '';
  
  const params = keys.slice(0, 2).map(k => {
    const v = inputObj[k];
    let val: string;
    if (typeof v === 'string') {
      val = v.length > 30 ? v.substring(0, 30) + '...' : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      val = String(v);
    } else {
      val = JSON.stringify(v).substring(0, 30);
    }
    return `${k}=${val}`;
  }).join(', ');
  
  return params + (keys.length > 2 ? ` (+${keys.length - 2})` : '');
}

/**
 * 获取结果摘要
 * 
 * 从结果对象中提取摘要信息用于显示
 * 
 * @param result - 结果数据
 * @param success - 是否成功，可选
 * @returns 结果摘要字符串
 */
function getResultSummary(result: unknown, success?: boolean): string {
  if (!result) return success !== false ? '完成' : '失败';
  
  if (typeof result === 'object') {
    const resultObj = result as Record<string, unknown>;
    if (resultObj.error) {
      return `错误: ${truncateString(String(resultObj.error), 50)}`;
    }
    if (resultObj.message) {
      return truncateString(String(resultObj.message), 50);
    }
    if (resultObj.url) {
      return `🔗 ${resultObj.url}`;
    }
    if (resultObj.output) {
      return truncateString(String(resultObj.output), 50);
    }
    if (resultObj.content) {
      return truncateString(String(resultObj.content), 50);
    }
    // 显示主要字段
    const keys = Object.keys(resultObj).filter(k => k !== 'success' && k !== 'done');
    if (keys.length > 0) {
      const firstKey = keys[0];
      const val = resultObj[firstKey];
      return `${firstKey}: ${truncateString(JSON.stringify(val), 40)}`;
    }
  }
  
  return success !== false ? '完成' : '失败';
}

/**
 * 格式化 thinking 类型的日志
 * 
 * @param log - 日志条目
 * @returns 格式化后的日志信息
 */
function formatThinkingLog(log: LogEntry): FormattedLog {
  const content = log.result?.content || log.data?.content || (typeof log.data === 'string' ? log.data : '');
  if (log.status === 'running') {
    return { 
      main: '🧠 思考中...', 
      detail: content ? truncateString(content, 80) : undefined,
      isRunning: true 
    };
  }
  // complete 状态
  return { 
    main: '🧠 思考完成',
    detail: content ? truncateString(content, 80) : undefined
  };
}

/**
 * 格式化 tool 类型的日志
 * 
 * @param log - 日志条目
 * @returns 格式化后的日志信息
 */
function formatToolLog(log: LogEntry): FormattedLog {
  const toolName = log.data?.tool || log.event_key || 'unknown';
  const input = log.input || log.data?.input;
  const result = log.result || log.data?.result;
  const success = log.data?.success ?? (result && !(result as Record<string, unknown>).error);
  
  if (log.status === 'running') {
    const paramsSummary = getParamsSummary(input);
    return { 
      main: `⚡ ${toolName}`, 
      toolName,
      status: '执行中',
      detail: paramsSummary || undefined,
      isRunning: true 
    };
  }
  
  // complete 状态
  const resultSummary = getResultSummary(result, success);
  const icon = success !== false ? '✓' : '✗';
  return { 
    main: `${icon} ${toolName}`, 
    toolName,
    status: success !== false ? '完成' : '失败',
    detail: resultSummary
  };
}

/**
 * 格式化旧事件模型的日志（兼容性处理）
 * 
 * @param log - 日志条目
 * @returns 格式化后的日志信息
 */
function formatLegacyLog(log: LogEntry): FormattedLog {
  switch (log.type) {
    case 'tool_start': {
      const toolName = log.data?.tool || 'unknown';
      const args = log.data?.args || log.data?.input;
      const paramsSummary = getParamsSummary(args);
      return { 
        main: `⚡ ${toolName}`, 
        toolName,
        status: '开始',
        detail: paramsSummary || undefined
      };
    }
    case 'tool_end': {
      const toolName = log.data?.tool || 'unknown';
      const success = log.data?.success;
      const result = log.data?.result;
      const resultSummary = getResultSummary(result, success);
      const icon = success !== false ? '✓' : '✗';
      return { 
        main: `${icon} ${toolName}`, 
        toolName,
        status: success !== false ? '完成' : '失败',
        detail: resultSummary
      };
    }
    case 'thinking': {
      const content = typeof log.data === 'string' ? log.data : (log.data?.content || '');
      return { 
        main: '🧠 思考',
        detail: content ? truncateString(content, 80) : undefined
      };
    }
    case 'status':
      return { main: log.data?.message || (typeof log.data === 'string' ? log.data : JSON.stringify(log.data)) };
    case 'stdout':
    case 'stderr':
      return { main: log.data?.output || (typeof log.data === 'string' ? log.data : '') };
    case 'progress':
      return { main: `Progress: ${log.data?.progress || 0}%` };
    case 'text':
      return { main: log.data?.content || (typeof log.data === 'string' ? log.data : JSON.stringify(log.data)) };
    case 'final':
      return { main: typeof log.data === 'string' ? log.data : (log.data?.content || JSON.stringify(log.data || '')) };
    case 'error':
      return { main: `❌ ${log.data?.error || log.data?.tool || ''}: ${typeof log.data === 'string' ? log.data : (log.data?.error || 'Unknown error')}` };
    case 'warning':
      return { main: typeof log.data === 'string' ? log.data : JSON.stringify(log.data) };
    default:
      return { main: typeof log.data === 'string' ? log.data : JSON.stringify(log.data).substring(0, 100) };
  }
}

/**
 * 格式化日志条目
 * 
 * 根据日志的类型（kind/type）和状态，格式化日志为可显示的信息
 * 
 * @param log - 日志条目
 * @returns 格式化后的日志信息
 */
export function formatLog(log: LogEntry): FormattedLog {
  // TODO: 旧事件模型兼容，待数据迁移完成后可移除
  const kind = log.kind || log.type;
  
  // 新事件模型：根据 kind 和 status 显示
  if (kind === 'think' || kind === 'thinking') {
    return formatThinkingLog(log);
  } else if (kind === 'tool') {
    return formatToolLog(log);
  }
  
  // 兼容旧的 type 字段
  return formatLegacyLog(log);
}
