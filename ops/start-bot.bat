@echo off
rem FeiyuMC bot keep-alive loop (crash auto-restart)
rem 视觉理解服务（eye-server mc 分区）：走 tailnet + Bearer，token 文件不进仓库
set EYE_SERVER=http://100.89.64.119:8901
set EYE_TOKEN_FILE=G:\feiyu-mc\ops\.eye-mc-token
:loop
cd /d G:\feiyu-mc\bot
node bot.js >> bot.log 2>&1
if exist G:\feiyu-mc\ops\bot-stop.flag (
  del G:\feiyu-mc\ops\bot-stop.flag
  echo [%date% %time%] manual stop, no restart >> bot.log
  exit /b 0
)
echo [%date% %time%] bot exited, restart in 15s >> bot.log
timeout /t 15 /nobreak >nul
goto loop
