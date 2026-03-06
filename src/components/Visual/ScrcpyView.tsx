/**
 * Scrcpy View 组件
 * 
 * 使用共享流管理器实现多组件共享同一个视频流
 * 解决缩略图和全屏视图之间的连接冲突问题
 */

import { useEffect, useRef, useState, memo, useCallback } from 'react';
import { Play, Loader2, Smartphone } from 'lucide-react';
import {
  subscribeToStream,
  sendControlMessage,
  reconnectStream,
  getStreamCanvas,
  StreamStatus,
  DeviceInfo,
} from '../../services/scrcpyStream';

interface ScrcpyViewProps {
  /** 设备序列号，如 "emulator-5554" */
  deviceSerial?: string;
  /** 是否为缩略图模式 */
  isThumbnail?: boolean;
  /** 是否自动连接 */
  autoConnect?: boolean;
  /** 自定义 className */
  className?: string;
  /** 连接成功回调 */
  onConnected?: () => void;
  /** 断开连接回调 */
  onDisconnected?: () => void;
  /** 错误回调 */
  onError?: (error: string) => void;
}

// 检查 WebCodecs 是否支持
const isWebCodecsSupported = typeof VideoDecoder !== 'undefined';

function ScrcpyViewComponent({ 
  deviceSerial, 
  isThumbnail = false,
  autoConnect = false,
  className,
  onConnected,
  onDisconnected,
  onError,
}: ScrcpyViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<StreamStatus>('disconnected');
  const [errorMsg, setErrorMsg] = useState('');
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const frameCountRef = useRef(0);
  const lastFpsUpdateRef = useRef(Date.now());
  const retryCountRef = useRef(0);
  
  // 用于触控检测
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  
  // 从共享 canvas 复制帧到本地 canvas
  const copyFrame = useCallback((sourceCanvas: HTMLCanvasElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // 更新 canvas 尺寸
    if (canvas.width !== sourceCanvas.width || canvas.height !== sourceCanvas.height) {
      canvas.width = sourceCanvas.width;
      canvas.height = sourceCanvas.height;
    }
    
    // 复制帧
    ctx.drawImage(sourceCanvas, 0, 0);
    
    frameCountRef.current++;
    const now = Date.now();
    if (now - lastFpsUpdateRef.current >= 1000) {
      frameCountRef.current = 0;
      lastFpsUpdateRef.current = now;
    }
  }, [isThumbnail]);
  
  // 订阅流
  useEffect(() => {
    if (!deviceSerial || !autoConnect) return;
    
    console.log(`[ScrcpyView] Subscribing to stream for ${deviceSerial}, thumbnail=${isThumbnail}`);
    
    const unsubscribe = subscribeToStream(deviceSerial, {
      onFrame: copyFrame,
      onDeviceInfo: (info) => {
        setDeviceInfo(info);
        onConnected?.();
      },
      onStatusChange: (newStatus) => {
        setStatus(newStatus);
        if (newStatus === 'connected') {
          retryCountRef.current = 0;
          setErrorMsg('');
        } else if (newStatus === 'disconnected') {
          onDisconnected?.();
        }
      },
      onError: (error) => {
        setErrorMsg(error);
        onError?.(error);
      },
    });
    
    return () => {
      console.log(`[ScrcpyView] Unsubscribing from stream for ${deviceSerial}`);
      unsubscribe();
    };
  }, [deviceSerial, autoConnect, copyFrame, onConnected, onDisconnected, onError, isThumbnail]);
  
  // 当状态变为 connected 时，主动从共享 canvas 复制一帧
  // 解决订阅时 canvasRef 还没准备好导致初始帧丢失的问题
  useEffect(() => {
    if (status !== 'connected' || !deviceSerial || !canvasRef.current) return;
    
    const sourceCanvas = getStreamCanvas(deviceSerial);
    if (sourceCanvas && sourceCanvas.width > 0 && sourceCanvas.height > 0) {
      copyFrame(sourceCanvas);
      console.log(`[ScrcpyView] Copied initial frame from shared canvas for ${deviceSerial}`);
    }
  }, [status, deviceSerial, copyFrame]);
  
  // 手动连接
  const connect = useCallback(() => {
    if (!deviceSerial) return;
    reconnectStream(deviceSerial);
  }, [deviceSerial]);
  
  // 发送控制消息
  const sendControl = useCallback((event: object) => {
    if (deviceSerial) {
      sendControlMessage(deviceSerial, event);
    }
  }, [deviceSerial]);
  
  // 计算实际坐标（考虑缩放）
  const getScaledCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !deviceInfo) return null;
    
    const rect = canvas.getBoundingClientRect();
    const scaleX = deviceInfo.width / rect.width;
    const scaleY = deviceInfo.height / rect.height;
    
    const x = Math.round((clientX - rect.left) * scaleX);
    const y = Math.round((clientY - rect.top) * scaleY);
    
    return { x, y };
  }, [deviceInfo]);
  
  // 处理鼠标按下
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isThumbnail) return; // 缩略图模式不处理交互
    
    const coords = getScaledCoords(e.clientX, e.clientY);
    if (coords && deviceInfo) {
      touchStartRef.current = { ...coords, time: Date.now() };
      
      sendControl({
        type: 'inject_touch',
        action: 0, // ACTION_DOWN
        pointerId: 0,
        x: coords.x,
        y: coords.y,
        screenWidth: deviceInfo.width,
        screenHeight: deviceInfo.height,
      });
    }
  }, [isThumbnail, getScaledCoords, deviceInfo, sendControl]);
  
  // 处理鼠标移动
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isThumbnail || !touchStartRef.current) return;
    
    const coords = getScaledCoords(e.clientX, e.clientY);
    if (coords && deviceInfo) {
      sendControl({
        type: 'inject_touch',
        action: 2, // ACTION_MOVE
        pointerId: 0,
        x: coords.x,
        y: coords.y,
        screenWidth: deviceInfo.width,
        screenHeight: deviceInfo.height,
      });
    }
  }, [isThumbnail, getScaledCoords, deviceInfo, sendControl]);
  
  // 处理鼠标抬起
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (isThumbnail) return;
    
    const coords = getScaledCoords(e.clientX, e.clientY);
    if (coords && deviceInfo) {
      sendControl({
        type: 'inject_touch',
        action: 1, // ACTION_UP
        pointerId: 0,
        x: coords.x,
        y: coords.y,
        screenWidth: deviceInfo.width,
        screenHeight: deviceInfo.height,
      });
    }
    touchStartRef.current = null;
  }, [isThumbnail, getScaledCoords, deviceInfo, sendControl]);
  
  // 处理键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isThumbnail) return;
    
    const keyMap: Record<string, number> = {
      'Backspace': 67,
      'Enter': 66,
      'Escape': 111,
      'ArrowUp': 19,
      'ArrowDown': 20,
      'ArrowLeft': 21,
      'ArrowRight': 22,
      'Home': 3,
      'Tab': 61,
    };
    
    const keycode = keyMap[e.key];
    if (keycode) {
      e.preventDefault();
      sendControl({
        type: 'inject_keycode',
        action: 0,
        keycode,
        repeat: 0,
        metastate: 0,
      });
    }
  }, [isThumbnail, sendControl]);
  
  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (isThumbnail) return;
    
    const keyMap: Record<string, number> = {
      'Backspace': 67,
      'Enter': 66,
      'Escape': 111,
      'ArrowUp': 19,
      'ArrowDown': 20,
      'ArrowLeft': 21,
      'ArrowRight': 22,
      'Home': 3,
      'Tab': 61,
    };
    
    const keycode = keyMap[e.key];
    if (keycode) {
      e.preventDefault();
      sendControl({
        type: 'inject_keycode',
        action: 1,
        keycode,
        repeat: 0,
        metastate: 0,
      });
    }
  }, [isThumbnail, sendControl]);
  
  // 渲染内容
  const renderContent = () => {
    if (status === 'connected') {
      return (
        <div 
          ref={containerRef}
          className="w-full h-full flex items-center justify-center"
          tabIndex={isThumbnail ? undefined : 0}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
        >
          <canvas
            ref={canvasRef}
            className={`max-w-full max-h-full object-contain ${isThumbnail ? '' : 'cursor-pointer'} select-none`}
            style={{ imageRendering: 'auto' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />
        </div>
      );
    }
    
    if (status === 'connecting') {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-nb-text-muted">
          <Loader2 size={isThumbnail ? 16 : 48} className={`${isThumbnail ? 'mb-1' : 'mb-4'} opacity-50 animate-spin`} />
          {!isThumbnail && (
            <>
              <p className="text-sm">正在连接 Android 设备...</p>
              <p className="text-xs text-gray-500 mt-2">启动 scrcpy-server 中</p>
            </>
          )}
        </div>
      );
    }
    
    // 未连接
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-nb-text-muted">
        <Smartphone size={isThumbnail ? 16 : 48} className={`${isThumbnail ? 'mb-1' : 'mb-4'} opacity-50`} />
        {!isThumbnail && (
          <>
            <p className="text-sm mb-2">
              {status === 'error' ? '连接失败' : 'Android 设备未连接'}
            </p>
            {!isWebCodecsSupported && (
              <p className="text-xs text-yellow-500 mb-2">WebCodecs API 不支持</p>
            )}
            {errorMsg && <p className="text-xs text-red-500 mb-4 max-w-xs text-center">{errorMsg}</p>}
            <button
              onClick={connect}
              disabled={!isWebCodecsSupported}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play size={16} />
              连接设备
            </button>
          </>
        )}
      </div>
    );
  };
  
  if (isThumbnail) {
    return (
      <div className={`h-full w-full bg-black relative ${className || ''}`}>
        <canvas ref={canvasRef} className="w-full h-full object-contain" />
        {status !== 'connected' && renderContent()}
      </div>
    );
  }
  
  return (
    <div className={`flex flex-col h-full bg-black ${className || ''}`}>
      {/* 视频区域 */}
      <div className="flex-1 relative overflow-hidden bg-black">
        {renderContent()}
      </div>
    </div>
  );
}

export const ScrcpyView = memo(ScrcpyViewComponent);
