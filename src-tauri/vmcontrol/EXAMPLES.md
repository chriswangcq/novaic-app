# vmcontrol API 使用示例

本文档提供了 vmcontrol API 的实际使用示例。

## 前置条件

1. 启动 vmcontrol API 服务器（默认端口 8080）
2. 确保有一个正在运行的虚拟机
3. 获取虚拟机的 ID

```bash
# 获取所有 VM 列表
curl http://127.0.0.1:8080/api/vms | jq .

# 设置 VM ID 环境变量
export VM_ID="your-vm-id-here"
```

## 屏幕截图示例

### 1. 获取截图并查看信息

```bash
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/screenshot | jq '{
  format: .format,
  width: .width,
  height: .height,
  data_size: (.data | length)
}'
```

### 2. 保存截图为文件

```bash
# 保存为 PNG 文件
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/screenshot | \
  jq -r '.data' | base64 -d > screenshot.png

# 使用时间戳命名
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/screenshot | \
  jq -r '.data' | base64 -d > "screenshot_${TIMESTAMP}.png"

echo "Screenshot saved to screenshot_${TIMESTAMP}.png"
```

### 3. 定期截图（监控）

```bash
#!/bin/bash
# 每 5 秒截图一次

VM_ID="your-vm-id-here"
COUNT=0

while true; do
    COUNT=$((COUNT + 1))
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    
    echo "[$TIMESTAMP] Taking screenshot #$COUNT..."
    
    curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/screenshot | \
      jq -r '.data' | base64 -d > "screenshots/shot_${TIMESTAMP}.png"
    
    sleep 5
done
```

## 键盘输入示例

### 1. 基本文本输入

```bash
# 输入简单文本
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"type","text":"hello world"}'

# 输入邮箱
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"type","text":"user@example.com"}'
```

### 2. 单个按键

```bash
# 按下 Enter
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"key","key":"enter"}'

# 按下 Tab
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"key","key":"tab"}'

# 按下 Escape
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"key","key":"esc"}'
```

### 3. 组合键

```bash
# Ctrl+C (复制/中断)
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"combo","keys":["ctrl","c"]}'

# Ctrl+V (粘贴)
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"combo","keys":["ctrl","v"]}'

# Ctrl+Alt+Delete
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"combo","keys":["ctrl","alt","delete"]}'

# Alt+Tab (切换窗口)
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"combo","keys":["alt","tab"]}'
```

### 4. 实际场景：登录 Linux

```bash
#!/bin/bash
# 自动登录 Linux 虚拟机

VM_ID="your-vm-id-here"
USERNAME="admin"
PASSWORD="password123"

echo "Typing username..."
curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"type\",\"text\":\"$USERNAME\"}"

sleep 1

echo "Pressing Enter..."
curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"key","key":"enter"}'

sleep 2

echo "Typing password..."
curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"type\",\"text\":\"$PASSWORD\"}"

sleep 1

echo "Pressing Enter..."
curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"key","key":"enter"}'

echo "Login complete!"
```

### 5. 实际场景：执行命令

```bash
#!/bin/bash
# 在虚拟机中执行 shell 命令

execute_command() {
    local VM_ID=$1
    local COMMAND=$2
    
    # 输入命令
    curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
      -H "Content-Type: application/json" \
      -d "{\"action\":\"type\",\"text\":\"$COMMAND\"}"
    
    sleep 0.5
    
    # 按下 Enter 执行
    curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
      -H "Content-Type: application/json" \
      -d '{"action":"key","key":"enter"}'
}

VM_ID="your-vm-id-here"

execute_command $VM_ID "ls -la"
sleep 2

execute_command $VM_ID "pwd"
sleep 2

execute_command $VM_ID "uname -a"
```

## 鼠标输入示例

### 1. 基本鼠标操作

```bash
# 移动鼠标到屏幕中心
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"move","x":640,"y":400}'

# 左键点击当前位置
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"click","button":"left"}'

# 右键点击特定位置
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"click","x":500,"y":300,"button":"right"}'
```

### 2. 滚动操作

```bash
# 向上滚动（正数）
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"scroll","delta":5}'

# 向下滚动（负数）
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"scroll","delta":-5}'
```

### 3. 实际场景：点击按钮

```bash
#!/bin/bash
# 点击屏幕上的特定按钮

VM_ID="your-vm-id-here"
BUTTON_X=500
BUTTON_Y=300

echo "Moving to button position..."
curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"move\",\"x\":$BUTTON_X,\"y\":$BUTTON_Y}"

sleep 0.5

echo "Clicking button..."
curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"click","button":"left"}'

echo "Button clicked!"
```

### 4. 实际场景：拖拽（通过移动实现）

```bash
#!/bin/bash
# 模拟鼠标拖拽

VM_ID="your-vm-id-here"
START_X=100
START_Y=100
END_X=500
END_Y=500

echo "Moving to start position..."
curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"move\",\"x\":$START_X,\"y\":$START_Y}"

sleep 0.5

echo "Smoothly dragging..."
for i in {0..10}; do
    X=$((START_X + (END_X - START_X) * i / 10))
    Y=$((START_Y + (END_Y - START_Y) * i / 10))
    
    curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
      -H "Content-Type: application/json" \
      -d "{\"action\":\"move\",\"x\":$X,\"y\":$Y}"
    
    sleep 0.1
done

echo "Drag complete!"
```

## 综合示例

### 自动化 UI 测试

```bash
#!/bin/bash
# 自动化测试虚拟机中的应用

set -e

VM_ID="your-vm-id-here"
API_URL="http://127.0.0.1:8080"

# 辅助函数
type_text() {
    curl -s -X POST "$API_URL/api/vms/$VM_ID/input/keyboard" \
      -H "Content-Type: application/json" \
      -d "{\"action\":\"type\",\"text\":\"$1\"}"
}

press_key() {
    curl -s -X POST "$API_URL/api/vms/$VM_ID/input/keyboard" \
      -H "Content-Type: application/json" \
      -d "{\"action\":\"key\",\"key\":\"$1\"}"
}

click_at() {
    curl -s -X POST "$API_URL/api/vms/$VM_ID/input/mouse" \
      -H "Content-Type: application/json" \
      -d "{\"action\":\"click\",\"x\":$1,\"y\":$2,\"button\":\"left\"}"
}

take_screenshot() {
    curl -s -X POST "$API_URL/api/vms/$VM_ID/screenshot" | \
      jq -r '.data' | base64 -d > "$1"
}

# 测试流程
echo "Starting UI test..."

# 1. 截取初始状态
take_screenshot "screenshots/01_initial.png"
sleep 1

# 2. 打开应用 (Alt+F2 打开运行对话框)
curl -s -X POST "$API_URL/api/vms/$VM_ID/input/keyboard" \
  -H "Content-Type: application/json" \
  -d '{"action":"combo","keys":["alt","f2"]}'
sleep 1

# 3. 输入应用名称
type_text "gedit"
sleep 0.5

# 4. 按 Enter 启动
press_key "enter"
sleep 2

# 5. 截取应用启动后的状态
take_screenshot "screenshots/02_app_launched.png"

# 6. 输入一些文本
type_text "This is a test document."
sleep 1

# 7. 保存文件 (Ctrl+S)
curl -s -X POST "$API_URL/api/vms/$VM_ID/input/keyboard" \
  -H "Content-Type: application/json" \
  -d '{"action":"combo","keys":["ctrl","s"]}'
sleep 1

# 8. 输入文件名
type_text "test.txt"
sleep 0.5

# 9. 点击保存按钮（假设在坐标 700, 500）
click_at 700 500
sleep 1

# 10. 最终截图
take_screenshot "screenshots/03_final.png"

echo "UI test completed!"
echo "Screenshots saved in screenshots/ directory"
```

### 性能监控

```bash
#!/bin/bash
# 监控虚拟机状态并定期截图

VM_ID="your-vm-id-here"
INTERVAL=10  # 秒
DURATION=300  # 总运行时间（秒）

mkdir -p monitoring
START_TIME=$(date +%s)

echo "Starting monitoring for $DURATION seconds..."

while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))
    
    if [ $ELAPSED -ge $DURATION ]; then
        echo "Monitoring completed!"
        break
    fi
    
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    
    # 获取 VM 信息
    VM_INFO=$(curl -s http://127.0.0.1:8080/api/vms/$VM_ID)
    
    # 截图
    curl -s -X POST http://127.0.0.1:8080/api/vms/$VM_ID/screenshot | \
      jq -r '.data' | base64 -d > "monitoring/${TIMESTAMP}.png"
    
    echo "[$TIMESTAMP] Screenshot captured (Elapsed: ${ELAPSED}s)"
    
    sleep $INTERVAL
done

echo "Total screenshots: $(ls monitoring/*.png | wc -l)"
```

## 错误处理示例

```bash
#!/bin/bash
# 带错误处理的 API 调用

VM_ID="your-vm-id-here"

send_keyboard_input() {
    local ACTION=$1
    local DATA=$2
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
      http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
      -H "Content-Type: application/json" \
      -d "$DATA")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | head -n-1)
    
    if [ "$HTTP_CODE" -eq 200 ]; then
        echo "✓ $ACTION successful"
        return 0
    else
        echo "✗ $ACTION failed (HTTP $HTTP_CODE)"
        echo "Error: $BODY" | jq .
        return 1
    fi
}

# 测试
send_keyboard_input "Type text" '{"action":"type","text":"hello"}'
send_keyboard_input "Press Enter" '{"action":"key","key":"enter"}'
```

## 使用 Python 调用 API

```python
#!/usr/bin/env python3
import requests
import base64
import time

API_URL = "http://127.0.0.1:8080"
VM_ID = "your-vm-id-here"

class VMControl:
    def __init__(self, api_url, vm_id):
        self.api_url = api_url
        self.vm_id = vm_id
    
    def screenshot(self, filename=None):
        """截取屏幕"""
        response = requests.post(
            f"{self.api_url}/api/vms/{self.vm_id}/screenshot"
        )
        data = response.json()
        
        if filename:
            image_data = base64.b64decode(data['data'])
            with open(filename, 'wb') as f:
                f.write(image_data)
        
        return data
    
    def type_text(self, text):
        """输入文本"""
        requests.post(
            f"{self.api_url}/api/vms/{self.vm_id}/input/keyboard",
            json={"action": "type", "text": text}
        )
    
    def press_key(self, key):
        """按键"""
        requests.post(
            f"{self.api_url}/api/vms/{self.vm_id}/input/keyboard",
            json={"action": "key", "key": key}
        )
    
    def press_combo(self, keys):
        """组合键"""
        requests.post(
            f"{self.api_url}/api/vms/{self.vm_id}/input/keyboard",
            json={"action": "combo", "keys": keys}
        )
    
    def mouse_move(self, x, y):
        """移动鼠标"""
        requests.post(
            f"{self.api_url}/api/vms/{self.vm_id}/input/mouse",
            json={"action": "move", "x": x, "y": y}
        )
    
    def mouse_click(self, x=None, y=None, button="left"):
        """点击鼠标"""
        data = {"action": "click", "button": button}
        if x is not None and y is not None:
            data.update({"x": x, "y": y})
        requests.post(
            f"{self.api_url}/api/vms/{self.vm_id}/input/mouse",
            json=data
        )

# 使用示例
if __name__ == "__main__":
    vm = VMControl(API_URL, VM_ID)
    
    # 截图
    vm.screenshot("screenshot.png")
    print("Screenshot saved")
    
    # 输入文本
    vm.type_text("Hello from Python!")
    time.sleep(0.5)
    
    # 按 Enter
    vm.press_key("enter")
    time.sleep(0.5)
    
    # 移动鼠标并点击
    vm.mouse_move(500, 300)
    time.sleep(0.5)
    vm.mouse_click()
    
    print("Operations completed!")
```

## 注意事项

1. **坐标系统**: 鼠标坐标基于虚拟机的显示分辨率
2. **延迟**: 操作之间添加适当延迟，确保虚拟机有时间响应
3. **错误处理**: 始终检查 HTTP 响应状态码
4. **资源清理**: 截图操作会生成临时文件，确保定期清理
5. **并发**: 避免同时发送多个输入命令，可能导致混乱

## 更多信息

查看完整 API 文档：[API.md](./API.md)
