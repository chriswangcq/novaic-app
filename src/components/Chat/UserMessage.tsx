import { useState } from 'react';
import { Message, MessageStatus } from '../../types';
import { Check, CheckCheck, Clock, AlertCircle, ChevronDown } from 'lucide-react';
import { Markdown } from './Markdown';
import { useMessages } from '../hooks/useMessages';
import { FileAttachmentList } from './FileAttachment';

interface UserMessageProps {
  message: Message;
  showHeader?: boolean; // 是否显示头像/标签（连续消息合并时为 false）
  showStatus?: boolean; // 是否显示状态（同状态组的最后一条才显示）
}

// Status display configuration
const statusConfig: Record<MessageStatus, { icon: typeof Check; text: string; className: string }> = {
  sending: { icon: Clock, text: '发送中...', className: 'text-nb-text-secondary' },
  delivered: { icon: Check, text: '已送达', className: 'text-nb-text-secondary' },
  read: { icon: CheckCheck, text: '已读', className: 'text-nb-text-muted' },
  error: { icon: AlertCircle, text: '发送失败', className: 'text-nb-error' },
};

export function UserMessage({ message, showHeader = true, showStatus = true }: UserMessageProps) {
  const [isHovered, setIsHovered] = useState(false);
  const status = message.status || 'delivered';
  const statusInfo = statusConfig[status];
  const StatusIcon = statusInfo.icon;
  const { expand } = useMessages();
  
  const handleExpand = () => {
    expand(message.id);
  };

  // 是否强制显示状态（发送中、错误、或者是组内最后一条）
  const forceShowStatus = status === 'sending' || status === 'error' || showStatus;
  
  return (
    <div 
      className="group py-1"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Header: label - right aligned (只在需要时显示) */}
      {showHeader && (
        <div className="flex items-center gap-1.5 mb-1 justify-end">
          <span className="text-[11px] font-medium text-nb-text-secondary uppercase tracking-wide">You</span>
        </div>
      )}
      
      {/* Message content - 柔和的蓝紫色调 */}
      <div className="bg-violet-500/10 border border-violet-500/10 rounded-2xl rounded-tr-md px-3.5 py-2.5">
        <Markdown content={message.content} />
        
        {/* Expand button for truncated messages */}
        {message.isTruncated && (
          <button
            onClick={handleExpand}
            className="flex items-center gap-1 mt-2 text-[11px] text-nb-text-muted hover:text-nb-text transition-colors"
          >
            <ChevronDown size={14} />
            <span>查看更多</span>
          </button>
        )}
      </div>

      {/* Message status - 组内最后一条常显，其他 hover 显示 */}
      <div className={`
        flex items-center gap-1 mt-1 justify-end text-[10px] transition-opacity duration-200
        ${statusInfo.className}
        ${forceShowStatus || isHovered ? 'opacity-100' : 'opacity-0'}
      `}>
        <StatusIcon size={11} className={status === 'sending' ? 'animate-pulse' : ''} />
        <span>{statusInfo.text}</span>
      </div>

      {/* Attachments - 微信风格文件卡片 */}
      {message.attachments && message.attachments.length > 0 && (
        <div className="mt-1.5 flex justify-end">
          <FileAttachmentList attachments={message.attachments} />
        </div>
      )}
    </div>
  );
}
