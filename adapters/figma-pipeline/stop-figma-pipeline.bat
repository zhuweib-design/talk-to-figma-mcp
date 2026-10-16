@echo off
chcp 936
rem 先落停止标记，让看守循环自己退出；只杀进程不写标记会在 5 秒后被重启。
rem 用 echo 造文件而不是 copy nul —— 隐藏窗口启动方式下 NUL 设备读不到。
echo stop>"%~dp0bridge-stop.flag"
rem 再结束监听 3055 的进程；IPv4 与 IPv6 可能各命中一次，第二次失败无害
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:":3055" ^| findstr LISTENING') do taskkill /f /pid %%a
exit /b 0
