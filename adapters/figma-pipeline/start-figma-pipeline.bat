@echo off
chcp 936
rem 管线只负责本地通道（中继 3055）。抽取收集服务已独立登记为 figma-collect，
rem 由入口自己启停；这里不再启动它，否则两个启动方会抢同一个端口、停了又起来。
if exist "%~dp0bridge-stop.flag" del /q "%~dp0bridge-stop.flag"
start "figma-bridge" /b cmd /d /c "%~dp0start-figma-bridge-resident.bat"
exit /b 0
