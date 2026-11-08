@echo off
rem FeiyuMC server keep-alive loop (crash auto-restart)
:loop
cd /d G:\feiyu-mc\server
rem fabric 切换开关: ops\use-fabric.flag 存在时启动 Fabric(结构模组版), 否则 Paper
if exist G:\feiyu-mc\ops\use-fabric.flag goto fabric
"C:\Users\Administrator\AppData\Roaming\.minecraft\runtime\java-runtime-delta\bin\java.exe" -Xms2G -Xmx3G -jar paper-1.21.1-133.jar nogui >> logs\server-loop.log 2>&1
goto after
:fabric
if not exist logs mkdir logs
"C:\Users\Administrator\AppData\Roaming\.minecraft\runtime\java-runtime-delta\bin\java.exe" -Xms2G -Xmx3G -jar fabric-server-mc.1.21.1-loader.0.20.1-launcher.1.21.1.jar nogui >> logs\server-loop.log 2>&1
:after
if exist G:\feiyu-mc\ops\stop.flag (
  del G:\feiyu-mc\ops\stop.flag
  echo [%date% %time%] manual stop, no restart >> logs\server-loop.log
  exit /b 0
)
echo [%date% %time%] server exited, restart in 10s >> logs\server-loop.log
timeout /t 10 /nobreak >nul
goto loop
