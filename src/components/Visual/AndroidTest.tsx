/**
 * Android 测试页面
 * 
 * 用于测试 ScrcpyView 组件
 */

import { ScrcpyView } from './ScrcpyView';

export function AndroidTest() {
  return (
    <div className="w-full h-screen bg-gray-950">
      <ScrcpyView 
        deviceSerial="emulator-5554"
        autoConnect={true}
      />
    </div>
  );
}
