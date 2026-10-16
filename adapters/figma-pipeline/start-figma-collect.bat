@echo off
chcp 936
title Figma ��ȡ�ռ�����
cd /d "%~dp0..\..\tools\figma-collect"

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

rem ��һ����������ڷ���Ķ˿ڣ��ֹ�˫��ʱ�˻�Ĭ�ϵ� 8768
set COLLECT_PORT=%~1
if "%COLLECT_PORT%"=="" set COLLECT_PORT=8768

rem collect-server.ts �������뻷���������ϣ�������·�������������ֲ�
set PAGES_DIR=pages-gas
echo �����ռ����񣺶˿� %COLLECT_PORT%������Ŀ¼ pages-gas
"%BUNEXE%" collect-server.ts --port %COLLECT_PORT% --pages-dir pages-gas
