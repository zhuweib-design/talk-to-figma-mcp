@echo off
chcp 936
title TalkToFigma ����ͨ�� - ��פ
cd /d "%~dp0..\..\tools\figma-bridge"

rem bun ��λ�ð���֪��װ·�������ң����� where��Ҳ�����ض��� nul��
rem ����������ش�������ʱ NUL �豸�������ˣ�>/dev/null ��ˢ��ϵͳ�Ҳ���ָ����·������
rem ���ڹܵ��ϻ���������ű���ϣ�ʵ���˳��� 255����
set BUNEXE=%USERPROFILE%\AppData\Roaming\npm\node_modules\bun\bin\bun.exe
if exist "%BUNEXE%" goto havebun
set BUNEXE=%APPDATA%\npm\node_modules\bun\bin\bun.exe
if exist "%BUNEXE%" goto havebun
set BUNEXE=%LOCALAPPDATA%\bun\bin\bun.exe
if exist "%BUNEXE%" goto havebun
echo �Ҳ��� bun�����Ȱ�װ��npm install -g bun ��ٷ���װ�ű����������������ߡ�
exit /b 1
:havebun

if not exist "node_modules\" (
    echo ȱ���������� tools\figma-bridge Ŀ¼����һ�� bun install
    exit /b 1
)

rem �Ѿ����ܾͲ��ظ����������⿪���������ֹ�˫��ײ����
set RUNNING=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:":3055" ^| findstr LISTENING') do set RUNNING=%%a
if defined RUNNING (
    echo 3055 �Ѿ��н����ڼ�����PID %RUNNING%�������β��ظ�������
    exit /b 0
)

if exist "%~dp0bridge-stop.flag" del /q "%~dp0bridge-stop.flag"

echo �������� TalkToFigma ����ͨ�����˿� 3055��...
echo ����ڵġ�ֹͣ����ť�رգ��ֹ��ص�������ھͻ�Ͽ� AI �� Figma �����ӡ�

:loop
"%BUNEXE%" run src\socket.ts
if exist "%~dp0bridge-stop.flag" (
    echo �Ѱ�ֹͣ����˳������ز����Զ�����
    exit /b 0
)
echo.
echo ͨ�������˳��ˣ�5 ����Զ�����������Ҫ����ͣ������ڵ㡸ֹͣ����
ping -n 6 127.0.0.1
goto loop
