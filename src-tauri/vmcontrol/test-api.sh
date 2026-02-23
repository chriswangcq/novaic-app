#!/bin/bash

# vmcontrol API Test Script
# 测试所有 API 端点

set -e

API_URL="http://127.0.0.1:8080"
VM_ID="${1:-550e8400-e29b-41d4-a716-446655440000}"

echo "Testing vmcontrol API..."
echo "Base URL: $API_URL"
echo "VM ID: $VM_ID"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"
    
    echo -e "${BLUE}Testing: $name${NC}"
    echo "  $method $endpoint"
    
    if [ -z "$data" ]; then
        curl -s -X "$method" "$API_URL$endpoint" | jq . || echo "  [FAILED]"
    else
        curl -s -X "$method" "$API_URL$endpoint" \
            -H "Content-Type: application/json" \
            -d "$data" | jq . || echo "  [FAILED]"
    fi
    
    echo ""
}

# 1. Health Check
test_endpoint "Health Check" "GET" "/health"

# 2. List VMs
test_endpoint "List VMs" "GET" "/api/vms"

# 3. Get VM Info
test_endpoint "Get VM Info" "GET" "/api/vms/$VM_ID"

# 4. VM Control - Pause
echo -e "${BLUE}Testing: Pause VM${NC}"
curl -s -X POST "$API_URL/api/vms/$VM_ID/pause"
echo -e "${GREEN}  [OK]${NC}\n"

sleep 1

# 5. VM Control - Resume
echo -e "${BLUE}Testing: Resume VM${NC}"
curl -s -X POST "$API_URL/api/vms/$VM_ID/resume"
echo -e "${GREEN}  [OK]${NC}\n"

# 6. Screenshot
echo -e "${BLUE}Testing: Screenshot${NC}"
SCREENSHOT=$(curl -s -X POST "$API_URL/api/vms/$VM_ID/screenshot")
echo "$SCREENSHOT" | jq '{format, width, height, data_length: (.data | length)}'
echo ""

# 7. Keyboard Input - Type Text
test_endpoint "Keyboard - Type Text" "POST" "/api/vms/$VM_ID/input/keyboard" \
    '{"action":"type","text":"hello"}'

sleep 0.5

# 8. Keyboard Input - Single Key
test_endpoint "Keyboard - Press Enter" "POST" "/api/vms/$VM_ID/input/keyboard" \
    '{"action":"key","key":"enter"}'

sleep 0.5

# 9. Keyboard Input - Combo
test_endpoint "Keyboard - Ctrl+C" "POST" "/api/vms/$VM_ID/input/keyboard" \
    '{"action":"combo","keys":["ctrl","c"]}'

sleep 0.5

# 10. Mouse Input - Move
test_endpoint "Mouse - Move to (500, 300)" "POST" "/api/vms/$VM_ID/input/mouse" \
    '{"action":"move","x":500,"y":300}'

sleep 0.5

# 11. Mouse Input - Click at Position
test_endpoint "Mouse - Click at (500, 300)" "POST" "/api/vms/$VM_ID/input/mouse" \
    '{"action":"click","x":500,"y":300,"button":"left"}'

sleep 0.5

# 12. Mouse Input - Click at Current Position
test_endpoint "Mouse - Click at current position" "POST" "/api/vms/$VM_ID/input/mouse" \
    '{"action":"click","button":"left"}'

sleep 0.5

# 13. Mouse Input - Right Click
test_endpoint "Mouse - Right Click" "POST" "/api/vms/$VM_ID/input/mouse" \
    '{"action":"click","x":600,"y":400,"button":"right"}'

sleep 0.5

# 14. Mouse Input - Scroll
test_endpoint "Mouse - Scroll Down" "POST" "/api/vms/$VM_ID/input/mouse" \
    '{"action":"scroll","delta":-3}'

sleep 0.5

# 15. Mouse Input - Scroll Up
test_endpoint "Mouse - Scroll Up" "POST" "/api/vms/$VM_ID/input/mouse" \
    '{"action":"scroll","delta":3}'

echo -e "${GREEN}All tests completed!${NC}"
echo ""
echo "To save a screenshot:"
echo "  curl -X POST $API_URL/api/vms/$VM_ID/screenshot | jq -r '.data' | base64 -d > screenshot.png"
