@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Label Auto 启动

rem ---- 已在运行则直接打开页面 ----
for %%P in (5221 5222 5223 5224 5225) do (
  curl.exe -s -m 1 "http://127.0.0.1:%%P/api/config" >nul 2>&1
  if not errorlevel 1 (
    echo 服务已在运行：http://127.0.0.1:%%P/qc
    start "" "http://127.0.0.1:%%P/qc"
    ping -n 3 127.0.0.1 >nul
    exit /b 0
  )
)

where pythonw >nul 2>&1
if errorlevel 1 (
  echo 未找到 pythonw，请先把 Python 加入 PATH。
  pause
  exit /b 1
)

echo 正在启动 Label Auto ...
rem pythonw：不弹控制台窗口；输出重定向到 server.log 便于排查
start "" pythonw dashboard.py >> "%~dp0server.log" 2>&1

rem ---- 等端口就绪（最多 15 秒） ----
for /l %%I in (1,1,15) do (
  ping -n 2 127.0.0.1 >nul
  for %%P in (5221 5222 5223 5224 5225) do (
    curl.exe -s -m 1 "http://127.0.0.1:%%P/api/config" >nul 2>&1
    if not errorlevel 1 (
      echo 已启动：http://127.0.0.1:%%P/qc
      start "" "http://127.0.0.1:%%P/qc"
      ping -n 3 127.0.0.1 >nul
      exit /b 0
    )
  )
)

echo 启动超时，请查看任务栏里最小化的 LabelAuto 窗口中的报错。
pause
exit /b 1
