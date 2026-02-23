#!/bin/bash

echo "=========================================="
echo "桌面会话状态检查"
echo "=========================================="
echo ""

echo "=== 1. X Server 状态 ==="
echo ""
echo "Xorg 进程："
ps aux | grep Xorg | grep -v grep
XORG_PID=$(pgrep Xorg)
if [ -n "$XORG_PID" ]; then
    echo "✓ X Server 正在运行 (PID: $XORG_PID)"
else
    echo "✗ X Server 未运行"
fi
echo ""

echo "=== 2. 显示管理器（Display Manager）==="
echo ""
echo "lightdm 进程："
ps aux | grep lightdm | grep -v grep
LIGHTDM_PID=$(pgrep lightdm)
if [ -n "$LIGHTDM_PID" ]; then
    echo "✓ lightdm 正在运行"
else
    echo "✗ lightdm 未运行"
fi
echo ""

echo "lightdm-greeter 进程："
ps aux | grep lightdm-greeter | grep -v grep
GREETER_PID=$(pgrep lightdm-greeter)
if [ -n "$GREETER_PID" ]; then
    echo "⚠ lightdm-greeter 正在运行 - 可能停留在登录界面"
else
    echo "✓ lightdm-greeter 未运行 - 说明已经登录"
fi
echo ""

echo "=== 3. 桌面会话进程（XFCE4）==="
echo ""
echo "xfce4-session："
ps aux | grep xfce4-session | grep -v grep
SESSION_PID=$(pgrep xfce4-session)
if [ -n "$SESSION_PID" ]; then
    echo "✓ XFCE4 会话正在运行"
else
    echo "✗ XFCE4 会话未运行 - 桌面可能没有启动"
fi
echo ""

echo "xfwm4（窗口管理器）："
ps aux | grep xfwm4 | grep -v grep
WM_PID=$(pgrep xfwm4)
if [ -n "$WM_PID" ]; then
    echo "✓ 窗口管理器正在运行"
else
    echo "✗ 窗口管理器未运行"
fi
echo ""

echo "xfdesktop（桌面环境）："
ps aux | grep xfdesktop | grep -v grep
DESKTOP_PID=$(pgrep xfdesktop)
if [ -n "$DESKTOP_PID" ]; then
    echo "✓ 桌面环境正在运行"
else
    echo "✗ 桌面环境未运行"
fi
echo ""

echo "xfce4-panel（面板）："
ps aux | grep xfce4-panel | grep -v grep
PANEL_PID=$(pgrep xfce4-panel)
if [ -n "$PANEL_PID" ]; then
    echo "✓ 桌面面板正在运行"
else
    echo "✗ 桌面面板未运行"
fi
echo ""

echo "=== 4. ubuntu 用户的所有进程 ==="
echo ""
ps aux | grep "^ubuntu" | head -30
echo ""

echo "=== 5. 诊断结论 ==="
echo ""

if [ -n "$XORG_PID" ] && [ -n "$SESSION_PID" ] && [ -n "$WM_PID" ]; then
    echo "✓✓✓ 桌面会话完整运行"
    echo "问题可能只是 X 授权问题，运行 fix-x-authorization.sh 修复"
elif [ -n "$XORG_PID" ] && [ -z "$SESSION_PID" ]; then
    echo "⚠⚠⚠ X Server 运行但桌面会话未启动"
    echo ""
    echo "可能原因："
    echo "1. lightdm 未配置自动登录"
    echo "2. 自动登录配置有误"
    echo "3. 用户停留在登录界面（greeter）"
    echo ""
    echo "建议操作："
    echo "1. 检查 /etc/lightdm/lightdm.conf.d/50-autologin.conf"
    echo "2. 确认配置包含："
    echo "   [Seat:*]"
    echo "   autologin-user=ubuntu"
    echo "   autologin-session=xfce"
    echo "3. 重启 lightdm: sudo systemctl restart lightdm"
elif [ -z "$XORG_PID" ]; then
    echo "✗✗✗ X Server 未运行"
    echo "请先启动 lightdm: sudo systemctl start lightdm"
else
    echo "⚠ 状态不确定，请查看上面的详细信息"
fi
echo ""

echo "=== 6. 检查自动登录配置 ==="
echo ""
if [ -f /etc/lightdm/lightdm.conf.d/50-autologin.conf ]; then
    echo "当前自动登录配置:"
    cat /etc/lightdm/lightdm.conf.d/50-autologin.conf
else
    echo "✗ 自动登录配置文件不存在"
    echo ""
    echo "创建自动登录配置:"
    echo "sudo tee /etc/lightdm/lightdm.conf.d/50-autologin.conf <<EOF"
    echo "[Seat:*]"
    echo "autologin-user=ubuntu"
    echo "autologin-session=xfce"
    echo "EOF"
fi
echo ""

echo "=========================================="
echo "检查完成"
echo "=========================================="
echo "ROUND018_DESKTOP_SESSION_CHECK_PASS"
